"""System HR identity migration against an explicitly disposable Neo4j.

The graph is seeded through a separate runtime-compatible driver so the
fixtures exercise old storage shapes that the HTTP writers no longer emit.
Every test is skipped unless the caller opts into the loopback ephemeral
database used by the other Neo4j acceptance tests.
"""

import asyncio
import hashlib
import json
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from fuli_graph.provider_values import stable_uuid
from test_project_agent_memory_neo4j import fixture_settings, provider_client


LEGACY_HR = 'fuli-project-hr'
CANONICAL_HR = 'employee.bole'


def _profile(name, *, capability):
    return {
        'name': name,
        'display_name': name,
        'responsibility': f'Synthetic {name} responsibility.',
        'agent_type': 'hr',
        'work_kinds': ['staffing-review'],
        'capabilities': [capability],
        'initial_preferences': [f'Synthetic {name} preference.'],
        'default_model_strategy': {
            'mode': 'adaptive',
            'reasoning_effort': 'default',
            'capability_hints': [],
        },
        'executor_policy': {
            'mode': 'flexible',
            'locked_executor_ids': [],
            'preferred_executor_ids': [],
        },
        'allowed_clients': ['codex', 'claude', 'claude_code', 'cursor', 'kiro', 'other'],
        'status': 'active',
    }


def _memory_record(space_id, project_id, checkpoint_id):
    return json.dumps({
        'checkpoint_id': checkpoint_id,
        'personal_space_id': space_id,
        'personal_project_id': project_id,
        'agent_id': LEGACY_HR,
        'revision': 1,
        'memory': {
            'summary': 'Synthetic legacy HR memory.',
            'decisions': ['Preserve the original checkpoint.'],
            'open_threads': ['Verify the canonical Bole alias.'],
            'next_actions': ['Run the migration acceptance test.'],
        },
        'source_application': 'codex',
        'source_session_id': 'synthetic-legacy-session',
        'task_id': None,
        'created_at': '2026-01-01T00:00:00Z',
    }, ensure_ascii=False, sort_keys=True)


async def _seed_fixture(settings, space_id, *, both=False, memory_conflict=False):
    """Create old and optional pre-existing canonical records in one space."""

    suffix = uuid4().hex
    project_id = f'synthetic-hr-project-{suffix}'
    legacy_node_id = f'synthetic-legacy-hr-node-{suffix}'
    canonical_node_id = stable_uuid(
        settings.provider_id,
        space_id,
        'project-agent',
        CANONICAL_HR,
    )
    active_assignment_id = f'synthetic-active-assignment-{suffix}'
    ended_assignment_id = f'synthetic-ended-assignment-{suffix}'
    task_id = f'synthetic-hr-task-{suffix}'
    event_id = f'synthetic-hr-event-{suffix}'
    recruitment_id = f'synthetic-hr-recruitment-{suffix}'
    attention_id = f'synthetic-hr-attention-{suffix}'
    context_id = f'synthetic-hr-context-{suffix}'
    head_id = f'synthetic-legacy-memory-head-{suffix}'
    checkpoint_id = stable_uuid(head_id, 'legacy-checkpoint')
    checkpoint_json = _memory_record(space_id, project_id, checkpoint_id)
    from fuli_graph.project_agent_memory_models import ProjectAgentMemoryWrite
    memory_write = ProjectAgentMemoryWrite(
        personal_space_id=space_id, personal_project_id=project_id, agent_id=LEGACY_HR,
        expected_revision=0, idempotency_key='legacy-checkpoint', source_application='codex',
        memory=json.loads(checkpoint_json)['memory'],
    ).model_dump(mode='json')
    checkpoint_hash = hashlib.sha256(json.dumps(
        {key: value for key, value in memory_write.items()
         if key not in {'source_application', 'source_session_id'}},
        sort_keys=True, ensure_ascii=False, separators=(',', ':'),
    ).encode()).hexdigest()

    legacy_profile = _profile('Legacy HR', capability='legacy-capability')
    canonical_profile = _profile('Existing Bole', capability='canonical-capability')

    async with AsyncGraphDatabase.driver(
        settings.neo4j_uri,
        auth=('neo4j', settings.neo4j_password),
        database=settings.neo4j_database,
    ) as driver:
        await driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
            CREATE (legacy:FuliProjectAgent {
              id: $legacy_node_id, agent_id: $legacy_id, name: 'Legacy HR',
              profile_json: $legacy_profile_json, agent_type: 'hr', status: 'active',
              memory_scope: 'reviewed_agent', capabilities: ['legacy-capability'],
              work_kinds: ['staffing-review'], created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z', legacy_marker: 'keep-me'
            })
            CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(legacy)
            CREATE (project:FuliPersonalProject {
              id: $project_node_id, project_id: $project_id,
              name: 'Synthetic HR project', lifecycle: 'active'
            })
            CREATE (space)-[:CONTAINS_PROJECT]->(project)
            CREATE (active:FuliProjectAgentAssignment {
              id: $active_assignment_id, assignment_id: $active_assignment_id,
              status: 'active', revision: 0, responsibility: 'Current HR review',
              work_kinds: ['staffing-review'], capabilities: ['legacy-capability'],
              reason: 'Synthetic active history',
              assigned_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
            })
            CREATE (ended:FuliProjectAgentAssignment {
              id: $ended_assignment_id, assignment_id: $ended_assignment_id,
              status: 'ended', revision: 1, responsibility: 'Previous HR review',
              work_kinds: ['staffing-review'], capabilities: ['legacy-capability'],
              reason: 'Synthetic ended history', end_reason: 'Synthetic replacement',
              assigned_at: '2025-01-01T00:00:00Z', updated_at: '2025-02-01T00:00:00Z',
              ended_at: '2025-02-01T00:00:00Z'
            })
            CREATE (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(active)
            CREATE (active)-[:ASSIGNED_AGENT]->(legacy)
            CREATE (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(ended)
            CREATE (ended)-[:ASSIGNED_AGENT]->(legacy)
            CREATE (task:FuliProjectAgentTask {
              id: $task_id, task_id: $task_id, personal_space_id: $space_id,
              personal_project_id: $project_id, title: 'Synthetic HR task',
              objective: 'Exercise every legacy HR reference.', work_kind: 'staffing-review',
              required_capabilities: ['legacy-capability'], status: 'completed', revision: 2,
              routing_outcome: 'assigned_existing', routing_reason: 'Synthetic fixture',
              coordinator_agent_id: $legacy_id, lead_agent_id: $legacy_id,
              hr_agent_id: $legacy_id, created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-02T00:00:00Z'
            })
            CREATE (space)-[:HAS_PROJECT_AGENT_TASK]->(task)
            CREATE (task)-[:HAS_PARTICIPANT {
              role: 'lead', status: 'completed', joined_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-02T00:00:00Z', ended_at: '2026-01-02T00:00:00Z'
            }]->(legacy)
            CREATE (event:FuliProjectAgentTaskEvent {
              id: $event_id, event_id: $event_id, task_id: $task_id,
              agent_id: $legacy_id, status: 'completed', actor_kind: 'hr',
              summary: 'Synthetic legacy event', source_application: 'codex',
              created_at: '2026-01-02T00:00:00Z', payload_hash: 'immutable-event-hash'
            })
            CREATE (task)-[:HAS_TASK_EVENT]->(event)
            CREATE (event)-[:EVENT_AGENT]->(legacy)
            CREATE (recruitment:FuliProjectAgentRecruitment {
              id: $recruitment_id, recruitment_id: $recruitment_id,
              personal_space_id: $space_id, personal_project_id: $project_id,
              task_id: $task_id, coordinator_agent_id: $legacy_id,
              hr_agent_id: $legacy_id, position_kind: 'durable', work_kind: 'staffing-review',
              required_capabilities: ['legacy-capability'], reason_code: 'no_match',
              reason: 'Synthetic recruitment history', status: 'fulfilled',
              confirmation_mode: 'automatic', proposed_agent_id: 'synthetic-proposed-agent',
              proposed_profile_json: $legacy_profile_json, revision: 1,
              created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z'
            })
            CREATE (space)-[:HAS_PROJECT_AGENT_RECRUITMENT]->(recruitment)
            CREATE (recruitment)-[:RECRUITED_BY]->(legacy)
            CREATE (task)-[:TRIGGERED_RECRUITMENT]->(recruitment)
            CREATE (attention:FuliAgentAttention {
              id: $attention_id, request_id: $attention_id,
              personal_space_id: $space_id, personal_project_id: $project_id,
              agent_id: $legacy_id, task_id: $task_id, kind: 'review',
              title: 'Synthetic HR attention', detail: 'Preserve this request.',
              requested_action: 'Review the synthetic assignment.', status: 'open', revision: 0,
              created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
            })
            CREATE (space)-[:HAS_AGENT_ATTENTION]->(attention)
            CREATE (context:FuliTaskContext {
              id: $context_id, token: $context_id, personal_space_id: $space_id,
              personal_project_id: $project_id, project_agent_id: $legacy_id,
              record_json: $context_json, created_at: '2026-01-01T00:00:00Z'
            })
            CREATE (head:FuliProjectAgentMemory {
              id: $head_id, personal_space_id: $space_id,
              personal_project_id: $project_id, agent_id: $legacy_id, revision: 1
            })
            CREATE (legacy)-[:HAS_WORKING_MEMORY]->(head)
            CREATE (project)-[:HAS_AGENT_WORKING_MEMORY]->(head)
            CREATE (checkpoint:FuliProjectAgentMemoryCheckpoint {
              id: $checkpoint_id, revision: 1, payload_hash: $checkpoint_hash,
              record_json: $checkpoint_json
            })
            CREATE (head)-[:HAS_MEMORY_CHECKPOINT]->(checkpoint)
            ''',
            space_id=space_id,
            legacy_node_id=legacy_node_id,
            legacy_id=LEGACY_HR,
            legacy_profile_json=json.dumps(legacy_profile),
            project_node_id=f'synthetic-project-node-{suffix}',
            project_id=project_id,
            active_assignment_id=active_assignment_id,
            ended_assignment_id=ended_assignment_id,
            task_id=task_id,
            event_id=event_id,
            recruitment_id=recruitment_id,
            attention_id=attention_id,
            context_id=context_id,
            context_json=json.dumps({
                'project_agent_id': LEGACY_HR,
                'source': 'synthetic-immutable-context',
            }),
            head_id=head_id,
            checkpoint_id=checkpoint_id,
            checkpoint_hash=checkpoint_hash,
            checkpoint_json=checkpoint_json,
        )

        if both:
            await driver.execute_query(
                '''
                MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
                CREATE (canonical:FuliProjectAgent {
                  id: $canonical_node_id, agent_id: $canonical_id, name: 'Existing Bole',
                  profile_json: $canonical_profile_json, agent_type: 'hr', status: 'active',
                  memory_scope: 'reviewed_agent', capabilities: ['canonical-capability'],
                  work_kinds: ['staffing-review'], created_at: '2026-01-01T00:00:00Z',
                  updated_at: '2026-01-01T00:00:00Z', canonical_marker: 'keep-me'
                })
                CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(canonical)
                ''',
                space_id=space_id,
                canonical_node_id=canonical_node_id,
                canonical_id=CANONICAL_HR,
                canonical_profile_json=json.dumps(canonical_profile),
            )

            if memory_conflict:
                await driver.execute_query(
                    '''
                    MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
                    MATCH (canonical:FuliProjectAgent {id: $canonical_node_id})
                    MATCH (project:FuliPersonalProject {project_id: $project_id})
                    CREATE (head:FuliProjectAgentMemory {
                      id: $canonical_head_id, personal_space_id: $space_id,
                      personal_project_id: $project_id, agent_id: $canonical_id, revision: 1
                    })
                    CREATE (canonical)-[:HAS_WORKING_MEMORY]->(head)
                    CREATE (project)-[:HAS_AGENT_WORKING_MEMORY]->(head)
                    CREATE (checkpoint:FuliProjectAgentMemoryCheckpoint {
                      id: $canonical_checkpoint_id, revision: 1,
                      payload_hash: 'canonical-conflicting-hash',
                      record_json: $canonical_checkpoint_json
                    })
                    CREATE (head)-[:HAS_MEMORY_CHECKPOINT]->(checkpoint)
                    ''',
                    space_id=space_id,
                    canonical_node_id=canonical_node_id,
                    canonical_id=CANONICAL_HR,
                    project_id=project_id,
                    canonical_head_id=f'synthetic-canonical-memory-head-{suffix}',
                    canonical_checkpoint_id=f'synthetic-canonical-memory-checkpoint-{suffix}',
                    canonical_checkpoint_json=json.dumps({
                        'checkpoint': 'canonical-conflict',
                    }),
                )

    return {
        'space_id': space_id,
        'project_id': project_id,
        'legacy_node_id': legacy_node_id,
        'canonical_node_id': canonical_node_id,
        'task_id': task_id,
        'recruitment_id': recruitment_id,
        'attention_id': attention_id,
        'context_id': context_id,
        'head_id': head_id,
        'checkpoint_id': checkpoint_id,
        'checkpoint_json': checkpoint_json,
        'checkpoint_hash': checkpoint_hash,
        'memory_write': memory_write,
    }


async def _create_space(client, name):
    response = await client.post('/v1/spaces', json={'name': name, 'kind': 'personal'})
    assert response.status_code == 200, response.text
    return response.json()['id']


async def _query(settings, query, **parameters):
    async with AsyncGraphDatabase.driver(
        settings.neo4j_uri,
        auth=('neo4j', settings.neo4j_password),
        database=settings.neo4j_database,
    ) as driver:
        rows, _, _ = await driver.execute_query(query, **parameters)
        return rows


@pytest.mark.asyncio
async def test_legacy_only_hr_migration_preserves_history_refs_and_memory():
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        space_id = await _create_space(client, 'Synthetic legacy-only HR identity')
        fixture = await _seed_fixture(settings, space_id)

        ensured = await client.post('/v1/project-agents/system-hr', params={
            'personal_space_id': space_id,
        })
        assert ensured.status_code == 200, ensured.text
        assert ensured.json()['agent_id'] == CANONICAL_HR

        rows = await _query(settings, '''
            MATCH (space:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (legacy {id: $legacy_node_id})
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (canonical:FuliProjectAgent {agent_id: $canonical_id})
            OPTIONAL MATCH (legacy)-[:MERGED_INTO]->(merged)
            RETURN labels(legacy) AS legacy_labels,
                   legacy.profile_json AS legacy_profile,
                   legacy.legacy_marker AS legacy_marker,
                   canonical.legacy_agent_ids AS legacy_ids,
                   count(merged) AS merged_count
            ''', space_id=space_id, legacy_node_id=fixture['legacy_node_id'],
            canonical_id=CANONICAL_HR)
        assert len(rows) == 1
        assert set(rows[0]['legacy_labels']) == {'FuliProjectAgentAlias'}
        assert json.loads(rows[0]['legacy_profile'])['name'] == 'Legacy HR'
        assert rows[0]['legacy_marker'] == 'keep-me'
        assert rows[0]['legacy_ids'] == [LEGACY_HR]
        assert rows[0]['merged_count'] == 1

        assignment_rows = await _query(settings, '''
            MATCH (project:FuliPersonalProject {project_id: $project_id})-
                  [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (assignment:FuliProjectAgentAssignment)-[:ASSIGNED_AGENT]->
                  (agent:FuliProjectAgent {agent_id: $canonical_id})
            RETURN collect(assignment.status) AS statuses
            ''', project_id=fixture['project_id'], canonical_id=CANONICAL_HR)
        assert set(assignment_rows[0]['statuses']) == {'active', 'ended'}

        refs = await _query(settings, '''
            MATCH (space:FuliSpace {id: $space_id})
            MATCH (task:FuliProjectAgentTask {task_id: $task_id})
            MATCH (event:FuliProjectAgentTaskEvent {event_id: $event_id})
            MATCH (recruitment:FuliProjectAgentRecruitment {recruitment_id: $recruitment_id})
            MATCH (attention:FuliAgentAttention {request_id: $attention_id})
            MATCH (context:FuliTaskContext {id: $context_id})
            RETURN task.coordinator_agent_id AS coordinator,
                   task.lead_agent_id AS lead, task.hr_agent_id AS task_hr,
                   event.agent_id AS event_agent, recruitment.hr_agent_id AS recruitment_hr,
                   recruitment.coordinator_agent_id AS recruitment_coordinator,
                   attention.agent_id AS attention_agent,
                   context.project_agent_id AS context_agent,
                   task.hr_identity_original_refs_json AS task_original,
                   attention.hr_identity_original_refs_json AS attention_original
            ''', space_id=space_id, task_id=fixture['task_id'], event_id=f'synthetic-hr-event-{fixture["task_id"].split("-")[-1]}',
            recruitment_id=fixture['recruitment_id'], attention_id=fixture['attention_id'],
            context_id=fixture['context_id'])
        assert len(refs) == 1
        assert {refs[0][key] for key in (
            'coordinator', 'lead', 'task_hr', 'event_agent', 'recruitment_hr',
            'recruitment_coordinator', 'attention_agent', 'context_agent',
        )} == {CANONICAL_HR}
        assert json.loads(refs[0]['task_original'])['hr_agent_id'] == LEGACY_HR
        assert json.loads(refs[0]['attention_original'])['agent_id'] == LEGACY_HR

        edge_rows = await _query(settings, '''
            MATCH (legacy {id: $legacy_node_id})-[legacy_edge]-(other)
            WHERE NOT type(legacy_edge) IN ['HAS_PROJECT_AGENT_IDENTITY', 'MERGED_INTO']
            MATCH (canonical:FuliProjectAgent {agent_id: $canonical_id})-[canonical_edge]-(other)
            WHERE type(canonical_edge) = type(legacy_edge)
            RETURN count(legacy_edge) AS original_edges, count(canonical_edge) AS copied_edges
            ''', legacy_node_id=fixture['legacy_node_id'], canonical_id=CANONICAL_HR)
        assert edge_rows[0]['original_edges'] == edge_rows[0]['copied_edges']

        checkpoint_rows = await _query(settings, '''
            MATCH (checkpoint:FuliProjectAgentMemoryCheckpoint {id: $checkpoint_id})
            RETURN checkpoint.record_json AS record_json, checkpoint.payload_hash AS payload_hash
            ''', checkpoint_id=fixture['checkpoint_id'])
        assert checkpoint_rows == [{
            'record_json': fixture['checkpoint_json'],
            'payload_hash': fixture['checkpoint_hash'],
        }]

        old_read = await client.get('/v1/project-agents/fuli-project-hr/memory', params={
            'personal_space_id': space_id,
            'personal_project_id': fixture['project_id'],
        })
        assert old_read.status_code == 200, old_read.text
        assert old_read.json()['agent_id'] == CANONICAL_HR
        assert old_read.json()['current']['checkpoint_id'] == fixture['checkpoint_id']

        for identity in (CANONICAL_HR, LEGACY_HR):
            replay = await client.put(f'/v1/project-agents/{identity}/memory', json={
                **fixture['memory_write'], 'agent_id': identity,
            })
            assert replay.status_code == 200, replay.text
            assert replay.json()['revision'] == 1
            assert replay.json()['checkpoint_id'] == fixture['checkpoint_id']
        changed = await client.put(f'/v1/project-agents/{CANONICAL_HR}/memory', json={
            **fixture['memory_write'], 'agent_id': CANONICAL_HR,
            'memory': {'summary': 'Different input must not reuse a checkpoint key.'},
        })
        assert changed.status_code == 409
        next_revision = await client.put(f'/v1/project-agents/{CANONICAL_HR}/memory', json={
            **fixture['memory_write'], 'agent_id': CANONICAL_HR, 'expected_revision': 1,
            'idempotency_key': 'next-checkpoint', 'memory': {'summary': 'Synthetic next revision.'},
        })
        assert next_revision.status_code == 200, next_revision.text
        assert next_revision.json()['revision'] == 2
        heads = await _query(settings, '''
            MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (:FuliProjectAgent {agent_id: $agent_id})-[:HAS_WORKING_MEMORY]->(head)
            RETURN collect(DISTINCT head.id) AS ids''', space_id=space_id, agent_id=CANONICAL_HR)
        assert heads[0]['ids'] == [fixture['head_id']]


@pytest.mark.asyncio
async def test_both_hr_identities_converge_idempotently_under_concurrent_ensure():
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        space_id = await _create_space(client, 'Synthetic duplicate HR identities')
        fixture = await _seed_fixture(settings, space_id, both=True)
        other_space_id = await _create_space(client, 'Synthetic unrelated HR space')

        await _query(settings, '''
            MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
            CREATE (same_name:FuliProjectAgent {
              id: $other_id, agent_id: 'synthetic-other-agent', name: 'Bole',
              profile_json: $profile_json, agent_type: 'durable', status: 'active'
            })
            CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(same_name)
            WITH space
            MATCH (other_space:FuliSpace {id: $other_space_id, kind: 'personal'})
            CREATE (other_legacy:FuliProjectAgent {
              id: $other_legacy_id, agent_id: $legacy_id, name: 'Other space legacy',
              profile_json: $profile_json, agent_type: 'hr', status: 'active'
            })
            CREATE (other_space)-[:HAS_PROJECT_AGENT_IDENTITY]->(other_legacy)
            ''', space_id=space_id, other_space_id=other_space_id,
            other_id=f'synthetic-unrelated-agent-{uuid4().hex}',
            other_legacy_id=f'synthetic-other-space-legacy-{uuid4().hex}',
            legacy_id=LEGACY_HR, profile_json=json.dumps(_profile(
                'Unrelated Bole', capability='unrelated-capability')))

        responses = await asyncio.gather(*(
            client.post('/v1/project-agents/system-hr', params={
                'personal_space_id': space_id,
            }) for _ in range(4)
        ))
        assert [response.status_code for response in responses] == [200] * 4
        assert {response.json()['agent_id'] for response in responses} == {CANONICAL_HR}

        repeated = await client.post('/v1/project-agents/system-hr', params={
            'personal_space_id': space_id,
        })
        assert repeated.status_code == 200, repeated.text

        counts = await _query(settings, '''
            MATCH (space:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
            WHERE agent.agent_id IN [$legacy_id, $canonical_id]
            OPTIONAL MATCH (agent)-[:MERGED_INTO]->(target)
            RETURN collect(DISTINCT [agent.agent_id, labels(agent)]) AS agents,
                   count(DISTINCT target) AS merge_targets
            ''', space_id=space_id, legacy_id=LEGACY_HR, canonical_id=CANONICAL_HR)
        assert len(counts) == 1
        assert sorted((item[0], set(item[1])) for item in counts[0]['agents']) == [
            (CANONICAL_HR, {'FuliProjectAgent'}),
            (LEGACY_HR, {'FuliProjectAgentAlias'}),
        ]
        assert counts[0]['merge_targets'] == 1

        untouched = await _query(settings, '''
            MATCH (space:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
            WHERE agent.agent_id = 'synthetic-other-agent'
            MATCH (other_space:FuliSpace {id: $other_space_id})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->(other_legacy)
            WHERE other_legacy.agent_id = $legacy_id
            RETURN labels(agent) AS same_name_labels,
                   labels(other_legacy) AS other_labels,
                   other_legacy.canonical_agent_id AS other_canonical
            ''', space_id=space_id, other_space_id=other_space_id, legacy_id=LEGACY_HR)
        assert untouched == [{
            'same_name_labels': ['FuliProjectAgent'],
            'other_labels': ['FuliProjectAgent'],
            'other_canonical': None,
        }]


@pytest.mark.asyncio
async def test_memory_head_conflict_rolls_back_identity_and_checkpoint_changes():
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        space_id = await _create_space(client, 'Synthetic HR memory conflict')
        fixture = await _seed_fixture(settings, space_id, both=True, memory_conflict=True)

        before = await _query(settings, '''
            MATCH (space:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (legacy {id: $legacy_node_id})
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (canonical:FuliProjectAgent {agent_id: $canonical_id})
            MATCH (checkpoint:FuliProjectAgentMemoryCheckpoint {id: $checkpoint_id})
            MATCH (task:FuliProjectAgentTask {task_id: $task_id})
            OPTIONAL MATCH (legacy)-[:MERGED_INTO]->(merged)
            RETURN labels(legacy) AS legacy_labels,
                   canonical.profile_json AS canonical_profile,
                   task.hr_agent_id AS task_hr,
                   checkpoint.record_json AS record_json,
                   checkpoint.payload_hash AS payload_hash,
                   count(merged) AS merged_count
            ''', space_id=space_id, legacy_node_id=fixture['legacy_node_id'],
            canonical_id=CANONICAL_HR, checkpoint_id=fixture['checkpoint_id'],
            task_id=fixture['task_id'])

        rejected = await client.post('/v1/project-agents/system-hr', params={
            'personal_space_id': space_id,
        })
        assert rejected.status_code == 409, rejected.text

        after = await _query(settings, '''
            MATCH (space:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (legacy {id: $legacy_node_id})
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (canonical:FuliProjectAgent {agent_id: $canonical_id})
            MATCH (checkpoint:FuliProjectAgentMemoryCheckpoint {id: $checkpoint_id})
            MATCH (task:FuliProjectAgentTask {task_id: $task_id})
            OPTIONAL MATCH (legacy)-[:MERGED_INTO]->(merged)
            RETURN labels(legacy) AS legacy_labels,
                   canonical.profile_json AS canonical_profile,
                   task.hr_agent_id AS task_hr,
                   checkpoint.record_json AS record_json,
                   checkpoint.payload_hash AS payload_hash,
                   count(merged) AS merged_count
            ''', space_id=space_id, legacy_node_id=fixture['legacy_node_id'],
            canonical_id=CANONICAL_HR, checkpoint_id=fixture['checkpoint_id'],
            task_id=fixture['task_id'])
        assert after == before
        assert after[0]['legacy_labels'] == ['FuliProjectAgent']
        assert after[0]['task_hr'] == LEGACY_HR
        assert after[0]['record_json'] == fixture['checkpoint_json']
        assert after[0]['payload_hash'] == fixture['checkpoint_hash']


@pytest.mark.asyncio
@pytest.mark.parametrize('conflict', [False, True])
async def test_knowledge_scope_and_learning_keys_preserve_evidence_and_rollback(conflict):
    from fuli_graph.store_project_agent_executor_learning import project_agent_executor_outcome_bucket_id
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        space_id = await _create_space(client, 'Synthetic knowledge identity upgrade')
        fixture = await _seed_fixture(settings, space_id, both=True)
        other_space = await _create_space(client, 'Synthetic isolated knowledge')
        old_key, new_key = [project_agent_executor_outcome_bucket_id(
            settings.provider_id, space_id, fixture['project_id'], 'staffing-review', identity,
            'synthetic-executor', 'adaptive', bucket_kind='reset',
        ) for identity in (LEGACY_HR, CANONICAL_HR)]
        await _query(settings, '''
            MATCH (space:FuliSpace {id: $space_id}), (other:FuliSpace {id: $other_space})
            CREATE (a:Entity {uuid: $entity_id, group_id: space.group_id,
              fuli_preference_agent_id: $legacy_id})
            CREATE (b:Entity {uuid: $other_entity_id, group_id: other.group_id,
              fuli_preference_agent_id: $legacy_id})
            CREATE (a)-[:RELATES_TO {uuid: $relation_id, group_id: space.group_id,
              fuli_preference_agent_id: $legacy_id, fact: 'Synthetic immutable fact.'}]->(a)
            CREATE (:Episodic {uuid: $episode_id, group_id: space.group_id,
              fuli_project_agent_id: $legacy_id, content: 'Synthetic immutable evidence.'})
            CREATE (:FuliProjectAgentExecutorOutcomeReset {id: $old_key, reset_id: $old_key,
              personal_space_id: $space_id, personal_project_id: $project_id,
              agent_id: $legacy_id, work_kind: 'staffing-review', executor_id: 'synthetic-executor',
              model_strategy_key: 'adaptive', payload_hash: 'immutable-reset-hash'})
            FOREACH (_ IN CASE WHEN $conflict THEN [1] ELSE [] END |
              CREATE (:FuliProjectAgentExecutorOutcomeReset {id: $new_key,
                personal_space_id: $space_id, agent_id: $canonical_id}))
            ''', space_id=space_id, other_space=other_space, project_id=fixture['project_id'],
            entity_id=f'{space_id}-entity', other_entity_id=f'{other_space}-entity',
            relation_id=f'{space_id}-relation', episode_id=f'{space_id}-episode',
            legacy_id=LEGACY_HR, canonical_id=CANONICAL_HR,
            old_key=old_key, new_key=new_key, conflict=conflict)
        result = await client.post('/v1/project-agents/system-hr', params={'personal_space_id': space_id})
        assert result.status_code == (409 if conflict else 200), result.text
        rows = await _query(settings, '''
            MATCH (a:Entity {uuid: $entity_id})-[r:RELATES_TO]->(a)
            MATCH (b:Entity {uuid: $other_entity_id}), (e:Episodic {uuid: $episode_id})
            MATCH (reset:FuliProjectAgentExecutorOutcomeReset {id: $key})
            RETURN a.fuli_preference_agent_id AS entity_agent, r.fuli_preference_agent_id AS relation_agent,
              e.fuli_project_agent_id AS episode_agent, b.fuli_preference_agent_id AS other_agent,
              r.fact AS fact, e.content AS content, reset.payload_hash AS payload_hash,
              reset.hr_identity_original_id AS original_id
            ''', entity_id=f'{space_id}-entity', other_entity_id=f'{other_space}-entity',
            episode_id=f'{space_id}-episode', key=old_key if conflict else new_key)
        assert len(rows) == 1
        expected = LEGACY_HR if conflict else CANONICAL_HR
        assert {rows[0][key] for key in ('entity_agent', 'relation_agent', 'episode_agent')} == {expected}
        assert rows[0]['other_agent'] == LEGACY_HR
        assert rows[0]['fact'] == 'Synthetic immutable fact.'
        assert rows[0]['content'] == 'Synthetic immutable evidence.'
        assert rows[0]['payload_hash'] == 'immutable-reset-hash'
        assert rows[0]['original_id'] == (None if conflict else old_key)
