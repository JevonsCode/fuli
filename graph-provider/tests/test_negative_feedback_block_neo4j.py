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

from fuli_graph import knowledge_batch_confirmation, knowledge_management
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


async def seed_relationship(settings, space_id, item_id, fact):
    basis = {
        'existence_reason': 'Synthetic fixture preference.',
        'quadrant_reason': 'Synthetic fixture quadrant.',
        'proposed_by': {'kind': 'agent', 'label': 'Codex'},
    }
    await query(settings, '''
        MATCH (space:FuliSpace {id: $space})
        CREATE (source:Entity {uuid: $source, group_id: space.group_id, name: 'Style'})
        CREATE (target:Entity {uuid: $target, group_id: space.group_id, name: 'Writing'})
        CREATE (source)-[:RELATES_TO {uuid: $item, group_id: space.group_id, name: 'PREFERS',
          fact: $fact, created_at: datetime('2026-10-01T00:00:00Z'),
          fuli_profile_aspect: 'taste', fuli_preference_scope: 'global',
          fuli_attributes_json: $attributes, fuli_origin_quadrant: 'known_known',
          fuli_current_quadrant: 'known_known', fuli_epistemic_status: 'observed',
          fuli_confirmation_status: 'pending', fuli_confirmation_basis_json: $basis,
          fuli_usage_generation: 1}]->(target)
        ''', space=space_id, item=item_id, source=str(uuid4()), target=str(uuid4()), fact=fact,
        attributes=json.dumps({'preferenceKey': item_id}), basis=json.dumps(basis))


async def use(client, space_id, task_id, item_id, use_kind='applied', item_kind='entity'):
    response = await client.post('/v1/knowledge/usage', json={
        'personal_space_id': space_id, 'task_id': task_id,
        'items': [{'item_id': item_id, 'item_kind': item_kind, 'use_kind': use_kind}],
    })
    assert response.status_code == 200, response.text
    return response.json()


async def delivered(client, space_id, project_id):
    response = await client.get('/v1/collaboration-preferences', params={
        'personal_space_id': space_id, 'personal_project_id': project_id,
    })
    assert response.status_code == 200, response.text
    return sorted(item['id'] for item in response.json()['effective_preferences'])


async def graph_suspension(client, space_id, item_id):
    response = await client.get(f'/v1/spaces/{space_id}/graph', params={'limit': 500})
    assert response.status_code == 200, response.text
    [node] = [node for node in response.json()['nodes'] if node['id'] == item_id]
    return node['agent_authority_suspension']


async def item_state(settings, item_id, item_kind='entity'):
    match = ('MATCH (item:Entity {uuid: $item})' if item_kind == 'entity'
             else 'MATCH ()-[item:RELATES_TO {uuid: $item}]->()')
    [state] = await query(settings, match + '''
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
        after_uses = await item_state(settings, old)
        assert after_uses['status'] == 'pending'
        assert after_uses['uses'] == 8
        assert after_uses['utility'] <= blocked['utility']
        assert after_uses['confidence'] <= blocked['confidence']
        assert await graph_suspension(client, space_id, old) == 'negative_feedback_block'

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
        assert await graph_suspension(client, space_id, old) is None
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


@pytest.mark.asyncio
@pytest.mark.parametrize('item_kind', ['entity', 'relationship'])
async def test_neo4j_edit_that_raced_a_rejection_is_refused_and_cannot_clear_it(
    item_kind, monkeypatch,
):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await personal_space(client)
        item = f'raced-style-{uuid4()}'
        if item_kind == 'entity':
            await seed_preference(settings, space_id, item, 'Use dramatic parallelism.',
                                  key=item)
            content = {'name': 'Style, reworded'}
        else:
            await seed_relationship(settings, space_id, item, 'Use dramatic parallelism.')
            content = {'fact': 'Use parallelism, reworded.'}
        promoted = 0
        for task_id, use_kind in [('task-1', 'applied'), ('task-1', 'cited'), ('task-2', 'applied'),
                                  ('task-2', 'cited'), ('task-3', 'applied')]:
            promoted += (await use(client, space_id, task_id, item, use_kind,
                                   item_kind))['promoted_count']
        assert promoted == 1
        edit = {'personal_space_id': space_id, 'item_kind': item_kind, 'action': 'update',
                'operation_actor': 'human', 'reason': 'Reword the style.', **content}

        # The user's rejection commits after the edit read the item, while the
        # edit is still computing its embedding.
        computed_embedding = knowledge_management._updated_embedding

        async def rejection_lands(*args):
            rejected = await client.post('/v1/knowledge/feedback', json={
                'personal_space_id': space_id, 'task_id': 'task-correction',
                'items': [{
                    'item_id': item, 'item_kind': item_kind, 'feedback_kind': 'rejected',
                    'reason': 'The user rejected this style.',
                    'evidence_summary': 'Synthetic fixture.', 'reported_by_kind': 'user',
                }],
            })
            assert rejected.status_code == 200, rejected.text
            return await computed_embedding(*args)

        monkeypatch.setattr(knowledge_management, '_updated_embedding', rejection_lands)
        stale = await client.patch(f'/v1/knowledge/items/{item}', json=edit)
        monkeypatch.setattr(knowledge_management, '_updated_embedding', computed_embedding)

        assert stale.status_code == 409, stale.text
        blocked = await item_state(settings, item, item_kind)
        assert blocked['status'] == 'pending' and blocked['negatives'] == 1
        block = json.loads(blocked['block'])
        assert block['reported_by_kind'] == 'user'
        assert await query(settings, '''
            MATCH (revision:FuliKnowledgeRevision {item_id: $item}) RETURN revision.id AS id
            ''', item=item) == []
        for task_id in ['task-4', 'task-5', 'task-6', 'task-7', 'task-8']:
            fresh = await use(client, space_id, task_id, item, 'applied', item_kind)
            assert fresh['promoted_count'] == 0
        assert item not in await delivered(client, space_id, 'novel')

        retried = await client.patch(f'/v1/knowledge/items/{item}', json=edit)
        assert retried.status_code == 200, retried.text
        assert retried.json()['previous']['negativeFeedbackBlock'] == block
        assert json.loads((await item_state(settings, item, item_kind))['block']) == block


@pytest.mark.asyncio
@pytest.mark.parametrize('rejected_kind', ['entity', 'relationship'])
async def test_neo4j_batch_confirmation_read_before_a_rejection_is_refused_whole(
    rejected_kind, monkeypatch,
):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await personal_space(client)
        episode = str(uuid4())
        entity, relationship = f'batch-entity-{uuid4()}', f'batch-relationship-{uuid4()}'
        await seed_preference(settings, space_id, entity, 'Use dramatic parallelism.', key=entity)
        await seed_relationship(settings, space_id, relationship, 'Use dramatic parallelism.')
        await query(settings, '''
            MATCH (space:FuliSpace {id: $space})
            MATCH (entity:Entity {uuid: $entity})
            MATCH ()-[relationship:RELATES_TO {uuid: $relationship}]->()
            CREATE (episode:Episodic {uuid: $episode, group_id: space.group_id})
            CREATE (episode)-[:MENTIONS]->(entity)
            SET relationship.episodes = [$episode]
            ''', space=space_id, entity=entity, relationship=relationship, episode=episode)
        kinds = {entity: 'entity', relationship: 'relationship'}
        rejected = entity if rejected_kind == 'entity' else relationship
        read = knowledge_batch_confirmation._read_item

        # The user's rejection commits right after the confirmer read that item.
        async def rejection_lands(store, space, item_id, item_kind):
            current = await read(store, space, item_id, item_kind)
            if item_id == rejected:
                response = await client.post('/v1/knowledge/feedback', json={
                    'personal_space_id': space_id, 'task_id': 'task-correction',
                    'items': [{
                        'item_id': item_id, 'item_kind': item_kind, 'feedback_kind': 'rejected',
                        'reason': 'The user rejected this style.',
                        'evidence_summary': 'Synthetic fixture.', 'reported_by_kind': 'user',
                    }],
                })
                assert response.status_code == 200, response.text
            return current

        payload = {
            'personal_space_id': space_id, 'group_kind': 'source', 'group_value': episode,
            'reason': 'The user reviewed every item from this source.',
            'operation_actor': 'human',
            'confirmer': {'kind': 'user', 'label': 'Synthetic user'},
            'items': [{
                'item_id': item_id, 'item_kind': item_kind,
                'existence_reason': 'Captured from the source.', 'quadrant_reason': 'Stated.',
                'proposed_by': {'kind': 'agent', 'label': 'Codex'},
            } for item_id, item_kind in kinds.items()],
        }
        monkeypatch.setattr(knowledge_batch_confirmation, '_read_item', rejection_lands)
        stale = await client.post('/v1/knowledge/batch-confirmations', json=payload)
        monkeypatch.setattr(knowledge_batch_confirmation, '_read_item', read)

        assert stale.status_code == 409, stale.text
        assert f'{rejected_kind}:{rejected}' in stale.json()['detail']
        block = json.loads((await item_state(settings, rejected, rejected_kind))['block'])
        for item_id, item_kind in kinds.items():
            assert (await item_state(settings, item_id, item_kind))['status'] == 'pending'
        assert await query(settings, '''
            MATCH (revision:FuliKnowledgeRevision) WHERE revision.item_id IN $items
            RETURN revision.id AS id
            ''', items=list(kinds)) == []

        retried = await client.post('/v1/knowledge/batch-confirmations', json=payload)
        assert retried.status_code == 200, retried.text
        assert retried.json()['confirmed_count'] == 2
        [revision] = await query(settings, '''
            MATCH (revision:FuliKnowledgeRevision {item_id: $item})
            RETURN revision.previous_json AS previous, revision.current_json AS current
            ''', item=rejected)
        assert json.loads(revision['previous'])['negativeFeedbackBlock'] == block
        assert json.loads(revision['current'])['negativeFeedbackBlock'] is None
        restored = await item_state(settings, rejected, rejected_kind)
        assert restored['status'] == 'confirmed' and restored['block'] is None
