"""Atomic checkpoint accounting against an explicitly disposable Neo4j."""

import asyncio
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_task_checkpoint_replay_neo4j import checkpoint, context_fixture, memory, memory_input, record


async def query(settings, statement, **parameters):
    async with AsyncGraphDatabase.driver(settings.neo4j_uri,
        auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
        rows, _, _ = await driver.execute_query(statement, **parameters)
        return [dict(row) for row in rows]


async def seed_items(settings, context):
    item_id, relationship_id = str(uuid4()), str(uuid4())
    await query(settings, '''
        MATCH (space:FuliSpace {id: $space})
        CREATE (item:Entity {uuid: $item, group_id: space.group_id,
          name: 'Synthetic checkpoint rule', summary: 'Use the existing transaction.',
          fuli_usage_generation: 1, fuli_confirmation_status: 'pending'})
        CREATE (target:Entity {uuid: $target, group_id: space.group_id, name: 'Synthetic target'})
        CREATE (item)-[:RELATES_TO {uuid: $relationship, group_id: space.group_id,
          fuli_usage_generation: 1, fuli_confirmation_status: 'pending'}]->(target)
        ''', space=context['personal_space_id'], item=item_id, target=str(uuid4()),
        relationship=relationship_id)
    return [
        {'item_id': item_id, 'item_kind': 'entity', 'use_kind': 'applied'},
        {'item_id': relationship_id, 'item_kind': 'relationship', 'use_kind': 'cited'},
    ]


async def audits(settings, context):
    return await query(settings, '''
        MATCH (:FuliSpace {id: $space})-[:HAS_KNOWLEDGE_AUDIT]->(audit:FuliKnowledgeAudit)
        WHERE audit.action = 'knowledge_used'
        RETURN audit.item_id AS item_id, audit.task_id AS task_id,
               audit.session_id AS session_id, audit.usage_generation AS generation
        ''', space=context['personal_space_id'])


@pytest.mark.asyncio
async def test_usage_failure_rolls_back_claim_memory_and_prior_item_then_accepts_retry():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        scope = {'version': 1, 'work_kind': 'implementation', 'workflow': 'checkpoint-accounting'}
        context = await context_fixture(client, work_log_required=True, preference_scope=scope)
        items = await seed_items(settings, context)
        endpoint = f'/v1/task-contexts/{context["token"]}/checkpoint'
        payload = checkpoint(context, agent_memory=memory_input(), knowledge_usage=items,
            work_log={'status': 'completed', 'summary': 'Verified the synthetic checkpoint result.'})
        failed = await client.put(endpoint, json={**payload, 'knowledge_usage': [items[0], {
            'item_id': 'missing-item', 'item_kind': 'entity', 'use_kind': 'applied'}]})
        assert failed.status_code == 404, failed.text
        assert (await record(client, context))['checkpoint'] is None
        assert (await memory(client, context))['revision'] == 0
        assert await audits(settings, context) == []
        state = await query(settings, 'MATCH (item:Entity {uuid: $id}) '
            'RETURN item.fuli_qualified_use_count AS uses', id=items[0]['item_id'])
        assert state == [{'uses': None}], 'An earlier item score must roll back too.'

        accepted = await client.put(endpoint, json=payload)
        assert accepted.status_code == 200, accepted.text
        result = accepted.json()['checkpoint']['knowledge_usage_result']
        assert result['recorded_count'] == 2
        assert (await memory(client, context))['revision'] == 1
        assert (await record(client, context))['preference_scope'] == scope
        # The Provider binds the actual items independently of a caller-supplied fingerprint.
        for changed in [None, [items[0]], [{**items[0], 'use_kind': 'cited'}, items[1]]]:
            rejected = await client.put(endpoint, json={**payload, 'knowledge_usage': changed})
            assert rejected.status_code == 409, rejected.text
        duplicate = await client.put(endpoint, json={**payload, 'knowledge_usage': [items[0], items[0]]})
        assert duplicate.status_code == 422
        assert len(await audits(settings, context)) == 2


@pytest.mark.asyncio
async def test_parallel_providers_and_lost_commit_response_replay_original_usage_generation(monkeypatch):
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (first, token):
        context = await context_fixture(first)
        items = await seed_items(settings, context)
        endpoint = f'/v1/task-contexts/{context["token"]}/checkpoint'
        payload = checkpoint(context, agent_memory=memory_input(), knowledge_usage=items)
        async with provider_client(settings, token, raise_app_exceptions=False) as (second, _):
            responses = await asyncio.gather(first.put(endpoint, json=payload), second.put(endpoint, json=payload))
            assert [response.status_code for response in responses] == [200, 200]
            original = responses[0].json()['checkpoint']['knowledge_usage_result']
            assert responses[1].json()['checkpoint']['knowledge_usage_result'] == original
            assert len(await audits(settings, context)) == 2
            assert (await memory(first, context))['revision'] == 1

        # The transaction commits, then delivery fails. A fresh Provider must not recount.
        from fuli_graph.store_task_contexts import StoreTaskContexts
        original_write = StoreTaskContexts.checkpoint_task_context

        async def lose_response(store, actor, task_token, request):
            await original_write(store, actor, task_token, request)
            raise RuntimeError('Synthetic failure after commit, before response delivery')

        with monkeypatch.context() as patch:
            patch.setattr(StoreTaskContexts, 'checkpoint_task_context', lose_response)
            lost = await first.put(endpoint, json={**payload, 'phase': 'complete', 'agent_memory': None})
            assert lost.status_code == 500

    # A content revision after the old commit must not turn a retry into another generation's use.
    await query(settings, 'MATCH (item:Entity {uuid: $id}) SET item.fuli_usage_generation = 2',
                id=items[0]['item_id'])
    async with provider_client(settings, token) as (restarted, _):
        for retry in [payload, {**payload, 'phase': 'complete', 'agent_memory': None}]:
            response = await restarted.put(endpoint, json=retry)
            assert response.status_code == 200, response.text
            assert response.json()['checkpoint']['phase'] == 'complete'
            assert response.json()['checkpoint']['knowledge_usage_result'] == original
        saved = await record(restarted, context)
        assert saved['checkpoint']['knowledge_usage_result'] == original
        evidence = await audits(settings, context)
        assert len(evidence) == 2 and {row['generation'] for row in evidence} == {1}
        assert {row['task_id'] for row in evidence} == {context['token']}
        assert {row['session_id'] for row in evidence} == {context['session_id']}


@pytest.mark.asyncio
async def test_explicit_usage_keeps_confirmation_policy_and_retain_nothing_work_log():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        context = await context_fixture(client, work_log_required=True)
        items = await seed_items(settings, context)
        await query(settings, '''
            MATCH (space:FuliSpace {id: $space})
            CREATE (space)-[:HAS_KNOWLEDGE_CONFLICT]->(:FuliKnowledgeConflict {
              id: $conflict, item_id: $item, status: 'pending'})
            ''', space=context['personal_space_id'], conflict=str(uuid4()), item=items[1]['item_id'])
        for task in range(4):
            seeded = await client.post('/v1/knowledge/usage', json={
                'personal_space_id': context['personal_space_id'], 'task_id': f'synthetic-prior-{task}',
                'items': items})
            assert seeded.status_code == 200, seeded.text
        endpoint = f'/v1/task-contexts/{context["token"]}/checkpoint'
        payload = checkpoint(context, knowledge_usage=items)
        rejected = await client.put(endpoint, json=payload)
        assert rejected.status_code == 422, 'Usage does not replace a truthful work log.'
        result = await client.put(endpoint, json={**payload, 'work_log': {
            'status': 'completed', 'summary': 'Completed implementation without new knowledge candidates.'}})
        assert result.status_code == 200, result.text
        checkpoint_result = result.json()['checkpoint']
        assert checkpoint_result['disposition'] == 'retain_nothing'
        usage = checkpoint_result['knowledge_usage_result']
        assert usage['promoted_count'] == 1
        assert [item['confirmation_status'] for item in usage['items']] == ['agent_confirmed', 'pending']
        assert all(item['qualified_use_count'] == 5 for item in usage['items'])
