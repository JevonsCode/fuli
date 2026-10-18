"""Routine fallback closure through authenticated HTTP and disposable Neo4j."""

import asyncio
import json
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_task_checkpoint_replay_neo4j import context_fixture, checkpoint, memory_input, memory
from test_agent_delegations_neo4j import worker_run_fixture


async def stored(settings, token):
    async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
        rows, _, _ = await driver.execute_query(
            'MATCH (t:FuliTaskContext {token: $token}) RETURN t.record_json AS record', token=token)
    return json.loads(rows[0]['record'])


def next_turn(context, **changes):
    return {**context, 'token': f'fuli-task-{uuid4()}', 'turn_id': f'next-{uuid4()}', **changes}


@pytest.mark.asyncio
async def test_next_entry_closes_only_the_same_native_sessions_routine_fallback():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        context = await context_fixture(client, work_log_required=True, entry_via='tool')
        retry = await client.put('/v1/task-contexts', json={**context, 'token': f'fuli-task-{uuid4()}'})
        assert retry.status_code == 200 and retry.json()['token'] == context['token']
        assert (await stored(settings, context['token']))['checkpoint'] is None
        foreign = await client.put('/v1/task-contexts', json=next_turn(context, session_id=f'foreign-{uuid4()}'))
        assert foreign.status_code == 200
        assert (await stored(settings, context['token']))['checkpoint'] is None
        following = next_turn(context)
        created = await client.put('/v1/task-contexts', json=following)
        assert created.status_code == 200, created.text
        old = await stored(settings, context['token'])
        assert old['checkpoint']['phase'] == 'complete'
        assert old['checkpoint']['disposition'] == 'retain_nothing'
        assert old['checkpoint']['work_log']['status'] == 'reported'
        assert 'auto-closed' in old['checkpoint']['work_log']['summary'].lower()
        assert 'memory' not in old['checkpoint'] and not old['checkpoint'].get('capture_results')
        assert created.json()['previous_checkpoint_missing'] is False
        assert created.json()['routine_auto_close_eligible'] is True
        again = await client.put('/v1/task-contexts', json=following)
        assert again.status_code == 200 and await stored(settings, context['token']) == old


@pytest.mark.asyncio
async def test_prepared_memory_and_meaningful_work_log_are_never_replaced():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        context = await context_fixture(client, work_log_required=True, entry_via='tool')
        claim = checkpoint(context, agent_memory=memory_input(),
            work_log={'status': 'incomplete', 'summary': 'Synthetic implementation still needs acceptance.'})
        prepared = await client.put(f'/v1/task-contexts/{context["token"]}/checkpoint', json=claim)
        assert prepared.status_code == 200, prepared.text
        original = await stored(settings, context['token'])
        following = await client.put('/v1/task-contexts', json=next_turn(context))
        assert following.status_code == 200 and following.json()['previous_checkpoint_missing'] is True
        assert await stored(settings, context['token']) == original
        assert (await memory(client, context))['current']['memory']['summary'] == 'Original synthetic memory.'


@pytest.mark.asyncio
async def test_new_entry_failure_rolls_back_the_auto_close():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        context = await context_fixture(client, entry_via='tool')
        foreign = next_turn(context, session_id=f'other-{uuid4()}')
        assert (await client.put('/v1/task-contexts', json=foreign)).status_code == 200
        rejected = await client.put('/v1/task-contexts', json=next_turn(context, token=foreign['token']))
        assert rejected.status_code == 409, rejected.text
        assert (await stored(settings, context['token']))['checkpoint'] is None
        accepted = await client.put('/v1/task-contexts', json=next_turn(context))
        assert accepted.status_code == 200
        assert (await stored(settings, context['token']))['checkpoint']['phase'] == 'complete'


@pytest.mark.asyncio
async def test_hook_entry_remains_owned_by_the_stop_hook():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        context = await context_fixture(client, entry_via='hook')
        following = await client.put('/v1/task-contexts', json=next_turn(context))
        assert following.status_code == 200 and following.json()['previous_checkpoint_missing'] is True
        assert (await stored(settings, context['token']))['checkpoint'] is None


@pytest.mark.asyncio
async def test_worker_and_coordination_links_protect_existing_tasks():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        context = await context_fixture(client, entry_via='tool')
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
            for relation in ['AUTHORIZES_WORKER_RUN', 'FOR_WORKER_RUN', 'COORDINATES_TASK']:
                await driver.execute_query(f'MATCH (t:FuliTaskContext {{token: $token}}) '
                    f'CREATE (t)-[:{relation}]->(:SyntheticLazyCloseGuard)', token=context['token'])
        following = await client.put('/v1/task-contexts', json=next_turn(context))
        assert following.status_code == 200 and following.json()['previous_checkpoint_missing'] is True
        assert (await stored(settings, context['token']))['checkpoint'] is None


@pytest.mark.asyncio
async def test_concurrent_new_entries_keep_one_current_task_and_reported_history():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        context = await context_fixture(client, entry_via='tool')
        turns = [next_turn(context), next_turn(context)]
        responses = await asyncio.gather(*(client.put('/v1/task-contexts', json=turn) for turn in turns))
        assert all(response.status_code == 200 for response in responses), [response.text for response in responses]
        records = [await stored(settings, item['token']) for item in [context, *turns]]
        assert sum(record['checkpoint'] is None for record in records) == 1
        assert all(record['checkpoint']['work_log']['status'] == 'reported'
                   for record in records if record['checkpoint'])


@pytest.mark.asyncio
async def test_first_sealed_worker_admission_keeps_an_explicit_checkpoint():
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        prepared = await client.put('/v1/project-agent-worker-runs', json=payload)
        assert prepared.status_code == 200, prepared.text
        path = f'/v1/project-agent-worker-runs/{prepared.json()["run_id"]}'
        assert (await client.post(path + '/start-claim', json=scope, headers=headers)).status_code == 200
        session = {**scope, 'source_application': 'codex', 'session_id': f'synthetic-lazy-worker-{uuid4()}'}
        assert (await client.put(path + '/session', json=session, headers=headers)).status_code == 200
        for _ in range(2):
            own = await client.post(path + '/contexts', json=session, headers=headers)
            assert own.status_code == 200, own.text
            assert own.json()['task_context']['routine_auto_close_eligible'] is False
