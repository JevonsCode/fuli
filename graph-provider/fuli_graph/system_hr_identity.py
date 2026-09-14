"""Lossless, exact-ID upgrade of the original HR into the built-in Bole.

The old node and its original edges remain an audit source, not another active
Agent. Only this reserved legacy ID is eligible; names never establish identity.
The caller owns a transaction so any conflicting reference rolls everything back.
"""

import json
import re

from fastapi import HTTPException

from .project_agent_models import ProjectAgentProfile
from .provider_values import now_utc

SYSTEM_HR_AGENT_ID = 'employee.bole'
LEGACY_HR_AGENT_ID = 'fuli-project-hr'
REFERENCE_FIELDS = (
    'agent_id', 'hr_agent_id', 'lead_agent_id', 'coordinator_agent_id',
    'project_agent_id', 'recruited_agent_id', 'proposed_agent_id',
)


async def resolve_hr_alias(store, space_id, agent_id):
    if agent_id != LEGACY_HR_AGENT_ID:
        return agent_id
    rows, _, _ = await store.runtime.driver.execute_query(
        '''MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
                 [:HAS_PROJECT_AGENT_IDENTITY]->(alias:FuliProjectAgentAlias {
                   agent_id: $legacy_id, canonical_agent_id: $canonical_id
                 })-[:MERGED_INTO]->(agent:FuliProjectAgent {agent_id: $canonical_id})
           RETURN agent.agent_id AS agent_id''',
        space_id=space_id, legacy_id=LEGACY_HR_AGENT_ID,
        canonical_id=SYSTEM_HR_AGENT_ID, routing_='r',
    )
    return rows[0]['agent_id'] if rows else agent_id


def merged_hr_profile(canonical, legacy):
    """Keep current Bole settings and old role knowledge without widening clients."""
    profile = {**legacy, **canonical, 'name': 'Bole', 'display_name': 'Bole',
               'agent_type': 'hr', 'status': 'active'}
    for field in ('capabilities', 'work_kinds', 'initial_preferences'):
        profile[field] = list(dict.fromkeys([*canonical.get(field, []), *legacy.get(field, [])]))
    old_clients = legacy.get('allowed_clients')
    if old_clients is not None:
        profile['allowed_clients'] = [c for c in profile.get('allowed_clients', []) if c in old_clients]
    old_policy = legacy.get('executor_policy') or {}
    policy = canonical.get('executor_policy') or {}
    if old_policy.get('mode') == 'locked':
        if policy.get('mode') == 'locked' and policy != old_policy:
            raise HTTPException(409, 'Bole identities have conflicting locked executor policies')
        profile['executor_policy'] = old_policy
    return ProjectAgentProfile.model_validate(profile)


async def merge_legacy_hr(store, space_id):
    driver = store.runtime.driver
    # Serialize all upgrades of this space, including two simultaneous setups.
    rows, _, _ = await driver.execute_query(
        '''MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
           SET space._hr_identity_lock = coalesce(space._hr_identity_lock, 0) + 1
           WITH space
           MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                 (legacy:FuliProjectAgent {agent_id: $legacy_id})
           MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                 (canonical:FuliProjectAgent {agent_id: $canonical_id})
           SET legacy._task_lifecycle_lock = true, canonical._task_lifecycle_lock = true
           REMOVE legacy._task_lifecycle_lock, canonical._task_lifecycle_lock
           RETURN legacy, canonical, elementId(legacy) AS legacy_element,
                  elementId(canonical) AS canonical_element''',
        space_id=space_id, legacy_id=LEGACY_HR_AGENT_ID, canonical_id=SYSTEM_HR_AGENT_ID,
    )
    if not rows:
        return
    row = rows[0]
    legacy, canonical = dict(row['legacy']), dict(row['canonical'])
    if legacy.get('agent_type') != 'hr' or canonical.get('agent_type') != 'hr':
        raise HTTPException(409, 'Reserved Bole identity is occupied by a different role')
    profile = merged_hr_profile(json.loads(canonical['profile_json']), json.loads(legacy['profile_json']))
    scope = dict(space_id=space_id, legacy_id=LEGACY_HR_AGENT_ID, canonical_id=SYSTEM_HR_AGENT_ID)
    memory_rows, _, _ = await driver.execute_query(
        '''MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                 (agent:FuliProjectAgent)-[:HAS_WORKING_MEMORY]->(head:FuliProjectAgentMemory)
           WHERE agent.agent_id IN [$legacy_id, $canonical_id]
           WITH head.personal_project_id AS project_id, collect(DISTINCT head.id) AS heads
           WHERE size(heads) > 1 RETURN project_id''', **scope,
    )
    if memory_rows:
        raise HTTPException(409, 'Bole identities have separate memory histories in one project; no data was changed')
    # Keep original relationships on the alias. Create equivalent canonical
    # relationships, refusing to overwrite a different existing relationship.
    edges, _, _ = await driver.execute_query(
        '''MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                 (legacy:FuliProjectAgent {agent_id: $legacy_id})
           MATCH (legacy)-[edge]-(other)
           WHERE type(edge) <> 'HAS_PROJECT_AGENT_IDENTITY'
           RETURN DISTINCT type(edge) AS kind, properties(edge) AS props,
                  elementId(startNode(edge)) AS start_id,
                  elementId(endNode(edge)) AS end_id''',
        space_id=space_id, legacy_id=LEGACY_HR_AGENT_ID,
    )
    for edge in edges:
        kind = edge['kind']
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*', kind):
            raise HTTPException(409, 'Unsupported HR relationship; no data was changed')
        start_id = row['canonical_element'] if edge['start_id'] == row['legacy_element'] else edge['start_id']
        end_id = row['canonical_element'] if edge['end_id'] == row['legacy_element'] else edge['end_id']
        copied, _, _ = await driver.execute_query(
            f'''MATCH (source), (target)
                WHERE elementId(source) = $start_id AND elementId(target) = $end_id
                MERGE (source)-[edge:{kind}]->(target)
                ON CREATE SET edge = $props
                RETURN properties(edge) AS props''',
            start_id=start_id, end_id=end_id, props=dict(edge['props']),
        )
        if not copied or dict(copied[0]['props']) != dict(edge['props']):
            raise HTTPException(409, 'Bole identities have conflicting relationship history; no data was changed')
    # Scalar routing references follow the canonical identity. Immutable JSON
    # evidence and hashes remain unchanged; original references are retained.
    references, _, _ = await driver.execute_query(
        '''MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
           CALL {
             WITH space MATCH (n) WHERE n.personal_space_id = space.id RETURN n
             UNION
             WITH space MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->(:FuliProjectAgentTask)-
                  [:HAS_TASK_EVENT]->(n:FuliProjectAgentTaskEvent) RETURN n
           }
           WITH DISTINCT n WHERE NOT n:FuliProjectAgent
             AND any(key IN $fields WHERE n[key] = $legacy_id)
           RETURN elementId(n) AS element_id,
                  [key IN $fields WHERE n[key] = $legacy_id] AS fields''',
        space_id=space_id, legacy_id=LEGACY_HR_AGENT_ID, fields=list(REFERENCE_FIELDS),
    )
    for reference in references:
        fields = reference['fields']
        # Keys come from our constant whitelist, never arbitrary query input.
        assignments = ', '.join(f'n.{key} = $canonical_id' for key in fields)
        await driver.execute_query(
            f'''MATCH (n) WHERE elementId(n) = $element_id
                SET {assignments}, n.hr_identity_original_refs_json = $original''',
            element_id=reference['element_id'], canonical_id=SYSTEM_HR_AGENT_ID,
            original=json.dumps({key: LEGACY_HR_AGENT_ID for key in fields}),
        )
    await _move_learning_buckets(store, space_id)
    # Knowledge UUIDs and evidence payloads are immutable. Only their mutable
    # visibility metadata follows the identity, within this space's graph group.
    await driver.execute_query(
        '''MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
           MATCH (n) WHERE n.group_id = space.group_id
             AND (n:Entity OR n:Episodic)
           FOREACH (_ IN CASE WHEN n.fuli_project_agent_id = $legacy_id THEN [1] ELSE [] END |
             SET n.fuli_project_agent_id = $canonical_id, n.hr_identity_original_agent_id = $legacy_id)
           FOREACH (_ IN CASE WHEN n.fuli_preference_agent_id = $legacy_id THEN [1] ELSE [] END |
             SET n.fuli_preference_agent_id = $canonical_id, n.hr_identity_original_agent_id = $legacy_id)''',
        **scope,
    )
    await driver.execute_query(
        '''MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
           MATCH ()-[edge:RELATES_TO]->() WHERE edge.group_id = space.group_id
             AND edge.fuli_preference_agent_id = $legacy_id
           SET edge.fuli_preference_agent_id = $canonical_id,
               edge.hr_identity_original_agent_id = $legacy_id''', **scope,
    )
    await driver.execute_query(
        '''MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                 (legacy:FuliProjectAgent {agent_id: $legacy_id})
           MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                 (canonical:FuliProjectAgent {agent_id: $canonical_id})
           SET canonical.profile_json = $profile_json, canonical.name = 'Bole',
               canonical.status = 'active',
               canonical.created_at = CASE WHEN legacy.created_at < canonical.created_at
                 THEN legacy.created_at ELSE canonical.created_at END,
               canonical.recruited_at = coalesce(canonical.recruited_at, legacy.recruited_at),
               canonical.recruitment_reason = coalesce(canonical.recruitment_reason, legacy.recruitment_reason),
               canonical.recruitment_source_application = coalesce(
                 canonical.recruitment_source_application, legacy.recruitment_source_application),
               canonical.capabilities = $capabilities, canonical.work_kinds = $work_kinds,
               canonical.legacy_agent_ids = [$legacy_id], canonical.updated_at = $timestamp,
               legacy:FuliProjectAgentAlias, legacy.canonical_agent_id = $canonical_id,
               legacy.merged_at = $timestamp
           REMOVE legacy:FuliProjectAgent
           MERGE (legacy)-[:MERGED_INTO]->(canonical)''',
        **scope, profile_json=profile.model_dump_json(), capabilities=profile.capabilities,
        work_kinds=profile.work_kinds, timestamp=now_utc(),
    )


async def _move_learning_buckets(store, space_id):
    # These are derived cache/reset keys, not evidence or checkpoint IDs. Keep
    # the original key for audit and refuse ambiguous overlapping buckets.
    from .store_project_agent_executor_learning import project_agent_executor_outcome_bucket_id

    for kind, label in (
        ('aggregate', 'FuliProjectAgentExecutorOutcomeAggregate'),
        ('reset', 'FuliProjectAgentExecutorOutcomeReset'),
    ):
        rows, _, _ = await store.runtime.driver.execute_query(
            f'''MATCH (n:{label} {{personal_space_id: $space_id,
                  hr_identity_original_refs_json: $original}}) RETURN n''',
            space_id=space_id, original=json.dumps({'agent_id': LEGACY_HR_AGENT_ID}),
        )
        for row in rows:
            node = dict(row['n'])
            new_id = project_agent_executor_outcome_bucket_id(
                store.settings.provider_id, space_id, node['personal_project_id'],
                node['work_kind'], SYSTEM_HR_AGENT_ID, node['executor_id'],
                node['model_strategy_key'], bucket_kind=kind,
            )
            conflicts, _, _ = await store.runtime.driver.execute_query(
                f'MATCH (n:{label} {{id: $id}}) RETURN n.id AS id', id=new_id)
            if conflicts:
                raise HTTPException(409, 'Bole identities have overlapping executor learning histories; no data was changed')
            await store.runtime.driver.execute_query(
                f'''MATCH (n:{label} {{id: $old_id}})
                    SET n.hr_identity_original_id = n.id,
                        n.id = $new_id, n.{kind}_id = $new_id''',
                old_id=node['id'], new_id=new_id)
