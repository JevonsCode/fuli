"""Checkpoint replay through authenticated ASGI HTTP and disposable Neo4j.

All identities are synthetic. Removing one new metadata property explicitly
simulates a pre-upgrade record; no daily database or model is used.
"""

from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


async def context_fixture(client):
    space = await client.post('/v1/spaces', json={
        'name': 'Synthetic checkpoint replay', 'kind': 'personal',
    })
    assert space.status_code == 200, space.text
    space_id = space.json()['id']
    await seed_agent(client, space_id)
    context = {
        'personal_space_id': space_id, 'personal_project_id': 'sample-project',
        'project_agent_id': 'engineer', 'session_id': f'synthetic-{uuid4()}',
        'source_application': 'codex', 'token': f'fuli-task-{uuid4()}',
        'turn_id': 'first-turn',
    }
    response = await client.put('/v1/task-contexts', json=context)
    assert response.status_code == 200, response.text
    return context


def checkpoint(context, **changes):
    return {
        'personal_space_id': context['personal_space_id'], 'source_application': 'codex',
        'phase': 'prepare', 'disposition': 'retain_nothing',
        'reason': 'Retain the synthetic checkpoint outcome.', 'fingerprint': 'a' * 64,
        **changes,
    }


def memory_input(summary='Original synthetic memory.'):
    return {'expected_revision': 0, 'memory': {'summary': summary}}


async def memory(client, context):
    response = await client.get('/v1/project-agents/engineer/memory', params={
        'personal_space_id': context['personal_space_id'],
        'personal_project_id': context['personal_project_id'],
    })
    assert response.status_code == 200, response.text
    return response.json()


async def record(client, context):
    response = await client.get(f'/v1/task-contexts/{context["token"]}', params={
        'personal_space_id': context['personal_space_id'], 'source_application': 'codex',
    })
    assert response.status_code == 200, response.text
    return response.json()


async def simulate_legacy_record(settings, context):
    # Only this unique synthetic task loses the new metadata; its real old
    # checkpoint and any memory history remain to exercise upgrade recovery.
    async with AsyncGraphDatabase.driver(settings.neo4j_uri,
        auth=('neo4j', settings.neo4j_password)) as driver:
        await driver.execute_query('''
            MATCH (task:FuliTaskContext {token: $token, personal_space_id: $space_id})
            REMOVE task.agent_memory_claimed
            ''', token=context['token'], space_id=context['personal_space_id'])


@pytest.mark.asyncio
@pytest.mark.parametrize('phase', ['prepare', 'complete'])
@pytest.mark.parametrize('legacy', [False, True])
async def test_claimed_checkpoint_cannot_add_memory_on_replay(phase, legacy):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        context = await context_fixture(client)
        endpoint = f'/v1/task-contexts/{context["token"]}/checkpoint'
        initial = await client.put(endpoint, json=checkpoint(context, phase=phase))
        assert initial.status_code == 200, initial.text
        if legacy:
            await simulate_legacy_record(settings, context)
        before = await record(client, context)
        replay = await client.put(endpoint, json=checkpoint(context, agent_memory=memory_input()))
        assert replay.status_code == 409, replay.text
        assert (await memory(client, context))['revision'] == 0
        assert (await record(client, context)) == before


@pytest.mark.asyncio
@pytest.mark.parametrize('legacy', [False, True])
async def test_memory_replay_preserves_original_content_and_completed_state(legacy):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        context = await context_fixture(client)
        endpoint = f'/v1/task-contexts/{context["token"]}/checkpoint'
        prepared = checkpoint(context, agent_memory=memory_input())
        initial = await client.put(endpoint, json=prepared)
        assert initial.status_code == 200, initial.text
        if legacy:
            await simulate_legacy_record(settings, context)
        retry = await client.put(endpoint, json=prepared)
        assert retry.status_code == 200, retry.text
        assert retry.json()['agent_memory'] == initial.json()['agent_memory']
        complete = await client.put(endpoint, json=checkpoint(context, phase='complete'))
        assert complete.status_code == 200, complete.text
        if legacy:
            await simulate_legacy_record(settings, context)
        before = await record(client, context)
        replay = await client.put(endpoint, json=prepared)
        assert replay.status_code == 200, replay.text
        assert replay.json()['agent_memory'] == initial.json()['agent_memory']
        changed = await client.put(endpoint, json=checkpoint(context,
            agent_memory=memory_input('Different late memory.')))
        assert changed.status_code == 409, changed.text
        assert (await memory(client, context))['revision'] == 1
        assert (await record(client, context)) == before


@pytest.mark.asyncio
async def test_new_turn_may_supersede_prepared_context_without_undoing_committed_memory():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        context = await context_fixture(client)
        endpoint = f'/v1/task-contexts/{context["token"]}/checkpoint'
        prepared = await client.put(endpoint, json=checkpoint(context, agent_memory=memory_input()))
        assert prepared.status_code == 200, prepared.text
        newer = {**context, 'token': f'fuli-task-{uuid4()}', 'turn_id': 'second-turn'}
        begun = await client.put('/v1/task-contexts', json=newer)
        assert begun.status_code == 200, begun.text
        assert begun.json()['previous_checkpoint_missing'] is True
        stale = await client.put(endpoint, json=checkpoint(context, phase='complete'))
        assert stale.status_code == 404, stale.text
        assert (await memory(client, newer))['revision'] == 1
        verified = await client.get('/v1/task-context-sessions/checkpoint', params={
            'personal_space_id': newer['personal_space_id'], 'session_id': newer['session_id'],
            'source_application': 'codex',
        })
        assert verified.status_code == 200, verified.text
        assert verified.json()['task_context_token'] == newer['token']
