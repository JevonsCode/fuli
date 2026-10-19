"""Scenario 1 of rec issue 5 against an explicitly disposable Neo4j.

The user corrects an Agent-confirmed writing style. A replayed usage event and
later uses must not revive it, another client must not receive it, the client
project's own rule must survive, and only an explicit confirmation restores it
while keeping the rejection in history. Public HTTP routes drive every write.
"""

import json
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from test_project_agent_memory_neo4j import fixture_settings, provider_client


async def query(settings, statement, **parameters):
    async with AsyncGraphDatabase.driver(settings.neo4j_uri,
        auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
        rows, _, _ = await driver.execute_query(statement, **parameters)
        return [dict(row) for row in rows]


async def personal_space(client):
    response = await client.post('/v1/spaces', json={
        'name': 'Synthetic novelist correction', 'kind': 'personal',
    })
    assert response.status_code == 200, response.text
    space_id = response.json()['id']
    for project in ['novel', 'client-copy']:
        created = await client.put('/v1/personal-projects', json={
            'personal_space_id': space_id, 'project_id': project,
            'profile': {'name': f'Synthetic {project}', 'lifecycle': 'active',
                        'purpose': 'Verify that a corrected preference stays corrected.'},
        })
        assert created.status_code == 200, created.text
    return space_id


async def seed_preference(settings, space_id, item_id, summary, *, key, status='pending',
                          scope='global', project_id=None):
    basis = {
        'existence_reason': 'Synthetic fixture preference.',
        'quadrant_reason': 'Synthetic fixture quadrant.',
        'proposed_by': {'kind': 'agent', 'label': 'Codex'},
    }
    if status == 'confirmed':
        basis.update(confirmed_by={'kind': 'user', 'label': 'Synthetic user'},
                     confirmed_at='2026-10-01T00:00:00+00:00')
    await query(settings, '''
        MATCH (space:FuliSpace {id: $space})
        CREATE (:Entity {uuid: $item, group_id: space.group_id, name: $item,
          summary: $summary, created_at: datetime('2026-10-01T00:00:00Z'),
          fuli_profile_aspect: 'taste', fuli_preference_scope: $scope,
          fuli_preference_project_id: $project, fuli_attributes_json: $attributes,
          fuli_origin_quadrant: 'known_known', fuli_current_quadrant: 'known_known',
          fuli_epistemic_status: 'observed', fuli_confirmation_status: $status,
          fuli_confirmation_basis_json: $basis, fuli_usage_generation: 1})
        ''', space=space_id, item=item_id, summary=summary, scope=scope, project=project_id,
        attributes=json.dumps({'preferenceKey': key}), status=status, basis=json.dumps(basis))


async def use(client, space_id, task_id, item_id, use_kind='applied'):
    response = await client.post('/v1/knowledge/usage', json={
        'personal_space_id': space_id, 'task_id': task_id,
        'items': [{'item_id': item_id, 'item_kind': 'entity', 'use_kind': use_kind}],
    })
    assert response.status_code == 200, response.text
    return response.json()


async def delivered(client, space_id, project_id):
    response = await client.get('/v1/collaboration-preferences', params={
        'personal_space_id': space_id, 'personal_project_id': project_id,
    })
    assert response.status_code == 200, response.text
    return sorted(item['id'] for item in response.json()['effective_preferences'])


async def item_state(settings, item_id):
    [state] = await query(settings, '''
        MATCH (item:Entity {uuid: $item})
        RETURN item.fuli_confirmation_status AS status,
               item.fuli_confirmation_basis_json AS basis,
               item.fuli_qualified_use_count AS uses,
               item.fuli_distinct_task_count AS tasks,
               item.fuli_utility_score AS utility,
               item.fuli_confidence_score AS confidence,
               item.fuli_negative_evidence_count AS negatives,
               item.fuli_negative_feedback_block_json AS block
        ''', item=item_id)
    return state


async def audits(settings, space_id, item_id):
    return await query(settings, '''
        MATCH (:FuliSpace {id: $space})-[:HAS_KNOWLEDGE_AUDIT]->(audit:FuliKnowledgeAudit)
        WHERE audit.item_id = $item
        RETURN audit.id AS id, audit.action AS action, audit.reported_by_kind AS reporter,
               audit.created_at AS created_at
        ORDER BY audit.created_at
        ''', space=space_id, item=item_id)


@pytest.mark.asyncio
async def test_neo4j_user_correction_is_not_revived_by_usage_and_lifts_only_on_confirmation():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await personal_space(client)
        old, client_rule, restrained = (f'{name}-{uuid4()}' for name in
                                        ['old-style', 'client-style', 'restrained-style'])
        await seed_preference(settings, space_id, old, 'Use dramatic parallelism.',
                              key='writing-rhetoric')
        await seed_preference(settings, space_id, client_rule,
                              'Client headlines use dramatic parallelism.', key='writing-rhetoric',
                              status='confirmed', scope='project', project_id='client-copy')

        promoted = 0
        for task_id, use_kind in [('task-1', 'applied'), ('task-1', 'cited'), ('task-2', 'applied'),
                                  ('task-2', 'cited'), ('task-3', 'applied')]:
            promoted += (await use(client, space_id, task_id, old, use_kind))['promoted_count']
        assert promoted == 1
        assert old in await delivered(client, space_id, 'novel')
        client_before = await item_state(settings, client_rule)

        feedback = await client.post('/v1/knowledge/feedback', json={
            'personal_space_id': space_id, 'task_id': 'task-correction',
            'items': [{
                'item_id': old, 'item_kind': 'entity', 'feedback_kind': 'contradicted',
                'reason': (
                    'Those pieces followed client requirements; '
                    'my own novels stay restrained.'
                ),
                'evidence_summary': 'Synthetic fixture: the user corrected the inferred style.',
                'reported_by_kind': 'user',
            }],
        })
        assert feedback.status_code == 200, feedback.text
        [rejection] = [audit for audit in await audits(settings, space_id, old)
                       if audit['action'] == 'knowledge_feedback']
        blocked = await item_state(settings, old)
        assert blocked['status'] == 'pending'
        block = json.loads(blocked['block'])
        assert block['audit_id'] == rejection['id']
        assert block['reported_by_kind'] == 'user'
        assert block['usage_generation'] == 1
        await seed_preference(settings, space_id, restrained,
                              'My own novels stay restrained without dramatic parallelism.',
                              key='novel-restraint', status='confirmed')

        duplicate = await use(client, space_id, 'task-3', old)
        assert (duplicate['recorded_count'], duplicate['duplicate_count'],
                duplicate['promoted_count']) == (0, 1, 0)
        assert await item_state(settings, old) == blocked
        for task_id in ['task-4', 'task-5', 'task-6']:
            fresh = await use(client, space_id, task_id, old)
            assert (fresh['recorded_count'], fresh['promoted_count']) == (1, 0)
        assert (await item_state(settings, old))['status'] == 'pending'

        novel = await delivered(client, space_id, 'novel')
        assert old not in novel and restrained in novel
        assert await item_state(settings, client_rule) == client_before
        assert await delivered(client, space_id, 'client-copy') == sorted([client_rule, restrained])

        confirmed = await client.patch(f'/v1/knowledge/items/{old}', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'confirm',
            'operation_actor': 'human', 'reason': 'The user explicitly restored this style.',
            'confirmation_status': 'confirmed',
            'confirmation_basis': {
                'existence_reason': 'The user explicitly restored it.',
                'quadrant_reason': 'Stated directly.',
                'proposed_by': {'kind': 'agent', 'label': 'Codex'},
                'confirmed_by': {'kind': 'user', 'label': 'Synthetic user'},
                'confirmed_at': '2026-10-20T00:00:00Z',
            },
        })
        assert confirmed.status_code == 200, confirmed.text
        assert confirmed.json()['previous']['negativeFeedbackBlock'] == block
        assert confirmed.json()['current']['negativeFeedbackBlock'] is None
        restored = await item_state(settings, old)
        assert restored['status'] == 'confirmed' and restored['block'] is None
        [revision] = await query(settings, '''
            MATCH (:FuliSpace {id: $space})-[:HAS_KNOWLEDGE_REVISION]->
                  (revision:FuliKnowledgeRevision)
            WHERE revision.item_id = $item
            RETURN revision.action AS action, revision.previous_json AS previous
            ''', space=space_id, item=old)
        assert revision['action'] == 'confirm'
        assert json.loads(revision['previous'])['negativeFeedbackBlock'] == block
        actions = [audit['action'] for audit in await audits(settings, space_id, old)]
        assert actions.count('knowledge_feedback') == 1
        assert actions.count('knowledge_used') == 8
        assert 'human_change' in actions
        assert old in await delivered(client, space_id, 'novel')
