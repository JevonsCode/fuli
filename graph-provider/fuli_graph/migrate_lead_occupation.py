"""Explicit project-lead occupation migration; preview is the default.

Run with ``python -m fuli_graph.migrate_lead_occupation --help``. Credentials
come only from FULI_MIGRATION_URI/USER/PASSWORD, never the running service config.
Apply requires the preview digest; rollback requires the returned migration ID.
Only occupation properties change. Identity, profile, assignments and memory stay intact.
"""

import argparse
import json
import os
from uuid import uuid4

from neo4j import GraphDatabase

from .graph_format_migrations import GRAPH_FORMAT_VERSION
from .provider_values import sha256_text


SNAPSHOT = '''
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-[:CONTAINS_PROJECT]->
      (project:FuliPersonalProject)-[:HAS_PROJECT_AGENT_COORDINATION_POLICY]->
      (policy:FuliProjectAgentCoordinationPolicy)
WHERE project.project_id IN $project_ids
MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent)
WHERE agent.agent_id = policy.team_lead_agent_id AND agent.status = 'active'
MATCH (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
      (:FuliProjectAgentAssignment {status: 'active'})-[:ASSIGNED_AGENT]->(agent)
OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]->(other:FuliPersonalProject)-
      [:HAS_PROJECT_AGENT_ASSIGNMENT]->(:FuliProjectAgentAssignment {status: 'active'})-
      [:ASSIGNED_AGENT]->(agent)
RETURN project.project_id AS project_id, agent.agent_id AS agent_id,
       agent.occupation_role AS role, coalesce(agent.occupation_tags, []) AS tags,
       collect(DISTINCT other.project_id) AS active_project_ids
'''


def build_plan(space_id, project_ids, rows):
    targets = sorted(set(project_ids))
    if not space_id or not targets:
        raise ValueError('explicit space and project IDs are required')
    missing = set(targets) - {row['project_id'] for row in rows}
    if missing:
        raise ValueError(f'missing active project leads: {sorted(missing)}')
    changes = {}
    for row in rows:
        if row['project_id'] not in targets:
            continue
        if row['agent_id'].startswith('employee.'):
            raise ValueError('builtin identities cannot be migrated into project leads')
        if set(row.get('active_project_ids', [])) - set(targets):
            raise ValueError('shared lead has assignments outside the explicit project scope')
        if row['role'] == 'lead':
            continue
        change = changes.setdefault(row['agent_id'], {
            'agent_id': row['agent_id'], 'project_ids': [],
            'before': {'role': row['role'], 'tags': row['tags']},
            'after': {'role': 'lead', 'tags': row['tags']},
        })
        if row['project_id'] not in change['project_ids']:
            change['project_ids'].append(row['project_id'])
    for change in changes.values():
        change['project_ids'].sort()
    plan = {'space_id': space_id, 'project_ids': targets,
            'changes': [changes[key] for key in sorted(changes)]}
    plan['digest'] = sha256_text(json.dumps(plan, sort_keys=True, ensure_ascii=False))
    return plan


def _require_current_format(transaction):
    """This tool writes outside the provider, so it checks the graph's data
    format itself: only a graph the provider has brought to this version."""
    records = list(transaction.run(
        "MATCH (format:FuliDataFormat {store: 'graph'}) RETURN format.version AS version"
    ))
    version = records[0]['version'] if records else None
    if version != GRAPH_FORMAT_VERSION:
        raise ValueError(
            f'the graph data format is {version}, not {GRAPH_FORMAT_VERSION}; start the '
            'matching FULI provider first, and upgrade FULI if the graph is newer'
        )


def migrate(transaction, space_id, project_ids, *, expected_digest=None, rollback_id=None):
    if expected_digest or rollback_id:
        _require_current_format(transaction)
    if rollback_id:
        records = list(transaction.run('''
            MATCH (audit:FuliLeadOccupationMigration {migration_id: $migration_id, space_id: $space_id})
            RETURN audit.project_ids AS project_ids
            ''', migration_id=rollback_id, space_id=space_id))
        if not records or set(records[0]['project_ids']) != set(project_ids):
            raise ValueError('rollback requires the exact migration project scope')
        rows = list(transaction.run('''
            MATCH (audit:FuliLeadOccupationMigration {migration_id: $migration_id, space_id: $space_id})-
                  [:CHANGED_OCCUPATION]->(entry:FuliLeadOccupationChange)-[:OF_AGENT]->(agent:FuliProjectAgent)
            SET agent._occupation_migration_lock = true
            REMOVE agent._occupation_migration_lock
            WITH audit, entry, agent
            WHERE audit.status = 'applied' AND agent.occupation_role = 'lead'
              AND agent.occupation_migration_id = audit.migration_id
              AND agent.occupation_updated_at = audit.applied_at
            SET agent.occupation_role = entry.before_role,
                agent.occupation_tags = entry.before_tags,
                agent.occupation_updated_at = entry.before_updated_at,
                agent.occupation_migration_id = entry.before_migration_id,
                entry.rolled_back_at = datetime()
            RETURN agent.agent_id AS agent_id
            ''', migration_id=rollback_id, space_id=space_id))
        counts = list(transaction.run('''
            MATCH (audit:FuliLeadOccupationMigration {migration_id: $migration_id, space_id: $space_id})
            RETURN audit.change_count AS count
            ''', migration_id=rollback_id, space_id=space_id))
        if not counts or len(rows) != counts[0]['count']:
            raise ValueError('occupation changed after migration; rollback aborted')
        transaction.run('''
            MATCH (audit:FuliLeadOccupationMigration {migration_id: $migration_id, space_id: $space_id})
            SET audit.status = 'rolled_back', audit.rolled_back_at = datetime()
            ''', migration_id=rollback_id, space_id=space_id).consume()
        return {'migration_id': rollback_id, 'status': 'rolled_back', 'changed': len(rows)}

    if expected_digest:
        # Serialize with ordinary occupation edits before rebuilding the preview.
        transaction.run('''
            MATCH (:FuliSpace {id: $space_id})-[:CONTAINS_PROJECT]->(project:FuliPersonalProject)-
                  [:HAS_PROJECT_AGENT_COORDINATION_POLICY]->(policy:FuliProjectAgentCoordinationPolicy)
            WHERE project.project_id IN $project_ids
            SET policy._occupation_migration_lock = true
            REMOVE policy._occupation_migration_lock
            WITH policy
            MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent)
            WHERE agent.agent_id = policy.team_lead_agent_id
            SET agent._occupation_migration_lock = true
            REMOVE agent._occupation_migration_lock
            ''', space_id=space_id, project_ids=project_ids).consume()
    plan = build_plan(space_id, project_ids, list(transaction.run(
        SNAPSHOT, space_id=space_id, project_ids=project_ids)))
    if not expected_digest:
        return plan
    if plan['digest'] != expected_digest:
        raise ValueError('preview is stale; preview again before applying')
    migration_id = str(uuid4())
    transaction.run('''
        CREATE (audit:FuliLeadOccupationMigration {migration_id: $migration_id,
          space_id: $space_id, project_ids: $project_ids, digest: $digest,
          status: 'applied', applied_at: datetime(), change_count: $change_count})
        WITH audit
        UNWIND $changes AS change
        MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
              (agent:FuliProjectAgent {agent_id: change.agent_id})
        CREATE (entry:FuliLeadOccupationChange {agent_id: agent.agent_id,
          before_role: agent.occupation_role, before_tags: agent.occupation_tags,
          before_updated_at: agent.occupation_updated_at,
          before_migration_id: agent.occupation_migration_id})
        CREATE (audit)-[:CHANGED_OCCUPATION]->(entry)-[:OF_AGENT]->(agent)
        SET agent.occupation_role = 'lead', agent.occupation_tags = change.after.tags,
            agent.occupation_updated_at = audit.applied_at,
            agent.occupation_migration_id = $migration_id
        ''', space_id=space_id, project_ids=plan['project_ids'], digest=plan['digest'],
        changes=plan['changes'], change_count=len(plan['changes']), migration_id=migration_id).consume()
    return {**plan, 'migration_id': migration_id, 'status': 'applied'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--space', required=True)
    parser.add_argument('--project', required=True, action='append')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', metavar='PREVIEW_DIGEST')
    mode.add_argument('--rollback', metavar='MIGRATION_ID')
    args = parser.parse_args()
    with GraphDatabase.driver(os.environ['FULI_MIGRATION_URI'], auth=(
            os.environ['FULI_MIGRATION_USER'], os.environ['FULI_MIGRATION_PASSWORD'])) as driver:
        with driver.session() as session:
            operation = session.execute_write if args.apply or args.rollback else session.execute_read
            result = operation(migrate, args.space, args.project,
                               expected_digest=args.apply, rollback_id=args.rollback)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
