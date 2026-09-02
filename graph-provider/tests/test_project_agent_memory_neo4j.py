"""Opt-in acceptance against a disposable loopback Neo4j; no LLM or real data.

Tests use public HTTP interfaces for writes and verification. The launcher must
explicitly set FULI_TEST_NEO4J_EPHEMERAL=1; no existing graph is cleared.
"""

import asyncio
import os
from contextlib import asynccontextmanager
from urllib.parse import urlparse

import httpx
import pytest


def fixture_settings():
    uri = os.getenv('FULI_TEST_NEO4J_URI')
    if not uri or os.getenv('FULI_TEST_NEO4J_EPHEMERAL') != '1':
        pytest.skip('requires an explicitly disposable FULI_TEST_NEO4J_URI')
    if urlparse(uri).hostname not in {'127.0.0.1', 'localhost', '::1'}:
        pytest.fail('Agent memory acceptance requires a disposable loopback graph')
    from fuli_graph.config import Settings
    return Settings(
        provider_id='agent-memory-acceptance', provider_mode='personal',
        bootstrap_token='memory-fixture-bootstrap-1234',
        neo4j_uri=uri, neo4j_password=os.getenv('FULI_TEST_NEO4J_PASSWORD', 'fixture-pass'),
    )


@asynccontextmanager
async def provider_client(settings, access_token=None, *, raise_app_exceptions=True):
    # The module's default app is not used and never opens a graph connection.
    os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'memory-fixture-bootstrap-1234')
    os.environ.setdefault('FULI_NEO4J_PASSWORD', 'fixture-pass')
    os.environ['FULI_NEO4J_URI'] = settings.neo4j_uri
    from fuli_graph.app import create_app
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=raise_app_exceptions),
            base_url='http://fixture',
        ) as client:
            if access_token is None:
                response = await client.post('/v1/bootstrap',
                    headers={'x-fuli-bootstrap-token': settings.bootstrap_token},
                    json={'principal_name': 'Synthetic memory acceptance'})
                assert response.status_code == 200
                access_token = response.json()['access_token']
            client.headers['Authorization'] = f'Bearer {access_token}'
            yield client, access_token


async def seed_agent(client, space_id, project='sample-project', agent='engineer', *,
    allowed_clients=None):
    response = await client.put('/v1/personal-projects', json={
        'personal_space_id': space_id, 'project_id': project,
        'profile': {'name': 'Synthetic sample project', 'lifecycle': 'active'},
    })
    assert response.status_code == 200, response.text
    response = await client.put('/v1/project-agents', json={
        'personal_space_id': space_id, 'personal_project_id': project,
        'agent_id': agent,
        'profile': {'name': 'Synthetic engineer', 'responsibility': 'Maintain the sample.',
            'allowed_clients': allowed_clients if allowed_clients is not None
                else ['codex', 'claude_code', 'cursor', 'other'],
            'work_kinds': ['implementation'], 'capabilities': ['coding'],
        },
    })
    assert response.status_code == 200, response.text


def write_payload(space_id, **changes):
    return {
        'personal_space_id': space_id, 'personal_project_id': 'sample-project',
        'agent_id': 'engineer', 'expected_revision': 0,
        'idempotency_key': 'checkpoint-first', 'source_application': 'codex',
        'memory': {'summary': 'Aster is the synthetic service name.',
            'decisions': ['Use the existing local graph.'],
            'open_threads': ['Verify service restart.'],
            'next_actions': ['Run the acceptance suite.']},
        **changes,
    }


@pytest.mark.asyncio
async def test_memory_write_respects_the_roles_allowed_clients():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic client-restricted memory', 'kind': 'personal',
        })
        space_id = space.json()['id']
        await seed_agent(client, space_id, allowed_clients=['codex'])
        rejected = await client.put('/v1/project-agents/engineer/memory',
            json=write_payload(space_id, source_application='cursor'))
        assert rejected.status_code == 403, rejected.text
        latest = await client.get('/v1/project-agents/engineer/memory', params={
            'personal_space_id': space_id, 'personal_project_id': 'sample-project',
        })
        assert latest.json()['revision'] == 0
        allowed = await client.put('/v1/project-agents/engineer/memory',
            json=write_payload(space_id))
        assert allowed.status_code == 200, allowed.text
        assert allowed.json()['revision'] == 1


@pytest.mark.asyncio
async def test_task_token_collision_is_rejected_without_corrupting_either_session():
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic token collision', 'kind': 'personal',
        })
        space_id = space.json()['id']
        payload = {
            'personal_space_id': space_id, 'source_application': 'codex',
            'session_id': 'first-host-session', 'token': 'fuli-task-collision-token',
            'turn_id': 'turn-one',
        }
        first = await client.put('/v1/task-contexts', json=payload)
        assert first.status_code == 200, first.text
        collided = await client.put('/v1/task-contexts', json={
            **payload, 'source_application': 'cursor', 'session_id': 'second-host-session',
        })
        assert collided.status_code == 409, collided.text
        original = await client.get(f'/v1/task-contexts/{payload["token"]}', params={
            'personal_space_id': space_id, 'source_application': 'codex',
        })
        assert original.status_code == 200, original.text
        assert original.json()['session_id'] == 'first-host-session'
        other = await client.get('/v1/task-context-sessions/checkpoint', params={
            'personal_space_id': space_id, 'source_application': 'cursor',
            'session_id': 'second-host-session',
        })
        assert other.json()['status'] == 'not_started'


@pytest.mark.asyncio
async def test_replaying_a_superseded_turn_is_an_explicit_conflict():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic superseded turn', 'kind': 'personal',
        })
        space_id = space.json()['id']
        base = {
            'personal_space_id': space_id, 'source_application': 'codex',
            'session_id': 'synthetic-replay-session',
        }
        first = await client.put('/v1/task-contexts', json={
            **base, 'token': 'fuli-task-first-replay', 'turn_id': 'turn-one',
        })
        assert first.status_code == 200, first.text
        current = await client.put('/v1/task-contexts', json={
            **base, 'token': 'fuli-task-second-replay', 'turn_id': 'turn-two',
        })
        assert current.status_code == 200, current.text
        stale = await client.put('/v1/task-contexts', json={
            **base, 'token': 'fuli-task-third-replay', 'turn_id': 'turn-one',
        })
        assert stale.status_code == 409, stale.text
        retry = await client.put('/v1/task-contexts', json={
            **base, 'token': 'fuli-task-current-retry', 'turn_id': 'turn-two',
        })
        assert retry.status_code == 200, retry.text
        assert retry.json()['token'] == current.json()['token']
        mismatched_turn = await client.put('/v1/task-contexts', json={
            **base, 'token': current.json()['token'], 'turn_id': 'turn-one',
        })
        assert mismatched_turn.status_code == 409, mismatched_turn.text
        stale_token = await client.put('/v1/task-contexts', json={
            **base, 'token': first.json()['token'], 'turn_id': 'turn-two',
        })
        assert stale_token.status_code == 409, stale_token.text
        verified = await client.get('/v1/task-context-sessions/checkpoint', params=base)
        assert verified.json()['task_context_token'] == current.json()['token']
        completed = await client.put(f'/v1/task-contexts/{current.json()["token"]}/checkpoint',
            json={'personal_space_id': space_id, 'source_application': 'codex',
                'phase': 'complete', 'disposition': 'retain_nothing',
                'reason': 'No durable changes in the current synthetic turn.',
                'fingerprint': 'b' * 64})
        assert completed.status_code == 200, completed.text


@pytest.mark.asyncio
async def test_memory_survives_provider_restart_and_client_switch():
    settings = fixture_settings()
    async with provider_client(settings) as (client, token):
        response = await client.post('/v1/spaces', json={
            'name': 'Synthetic memory acceptance', 'kind': 'personal',
        })
        assert response.status_code == 200
        space_id = response.json()['id']
        await seed_agent(client, space_id)
        response = await client.put('/v1/project-agents/engineer/memory',
            json=write_payload(space_id))
        assert response.status_code == 200, response.text
        assert response.json()['revision'] == 1

    # A new application, GraphitiRuntime, driver and HTTP client share only DB data.
    async with provider_client(settings, token) as (client, _):
        response = await client.get('/v1/project-agents/engineer/memory', params={
            'personal_space_id': space_id, 'personal_project_id': 'sample-project',
        })
        assert response.status_code == 200, response.text
        assert response.json()['current']['memory']['summary'] == 'Aster is the synthetic service name.'
        update = write_payload(space_id, expected_revision=1,
            idempotency_key='checkpoint-second', source_application='claude_code',
            memory={'summary': 'Aster restart is verified.', 'next_actions': ['Check Cursor recovery.']})
        response = await client.put('/v1/project-agents/engineer/memory', json=update)
        assert response.status_code == 200, response.text
        assert response.json()['revision'] == 2
        latest = await client.get('/v1/project-agents/engineer/memory', params={
            'personal_space_id': space_id, 'personal_project_id': 'sample-project', 'limit': 10,
        })
        assert latest.json()['current']['source_application'] == 'claude_code'
        assert [item['revision'] for item in latest.json()['history']] == [2, 1]


@pytest.mark.asyncio
async def test_task_entry_resolves_one_role_without_creating_a_worker():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic role resolution', 'kind': 'personal',
        })
        space_id = space.json()['id']
        await seed_agent(client, space_id, agent='engineer')
        await seed_agent(client, space_id, agent='reviewer')
        response = await client.post('/v1/project-agent-context/resolve', json={
            'personal_space_id': space_id, 'personal_project_id': 'sample-project',
            'source_application': 'cursor', 'work_kind': 'implementation',
            'required_capabilities': ['coding'],
        })

        assert response.status_code == 200, response.text
        assert response.json()['status'] == 'ready'
        assert response.json()['agent']['agent_id'] == 'engineer'
        assert response.json()['worker_started'] is False
        tasks = await client.get('/v1/project-agent-tasks', params={
            'personal_space_id': space_id, 'personal_project_id': 'sample-project',
        })
        assert tasks.json() == []


@pytest.mark.asyncio
async def test_context_fallback_discloses_that_no_specialist_matched():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic context fallback', 'kind': 'personal',
        })
        space_id = space.json()['id']
        await seed_agent(client, space_id, agent='engineer')
        await seed_agent(client, space_id, agent='reviewer')
        request = {
            'personal_space_id': space_id, 'personal_project_id': 'sample-project',
            'source_application': 'cursor', 'work_kind': 'design_review',
        }
        response = await client.post('/v1/project-agent-context/resolve', json=request)
        assert response.status_code == 200, response.text
        assert response.json()['status'] == 'ready'
        assert response.json()['reason'] == 'project_context_fallback'
        assert 'design_review' in ' '.join(response.json()['match_basis'])
        assert response.json()['worker_started'] is False
        required = await client.post('/v1/project-agent-context/resolve', json={
            **request, 'required_capabilities': ['absent-capability'],
        })
        assert required.status_code == 200, required.text
        assert required.json()['status'] == 'unassigned'
        assert required.json()['agent'] is None


@pytest.mark.asyncio
async def test_simultaneous_hosts_cannot_overwrite_memory_or_duplicate_retries():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic concurrent hosts', 'kind': 'personal',
        })
        space_id = space.json()['id']
        await seed_agent(client, space_id)
        payloads = [write_payload(space_id,
            idempotency_key=f'concurrent-{source}', source_application=source,
            memory={'summary': f'Synthetic {source} checkpoint.'})
            for source in ['codex', 'cursor']]
        responses = await asyncio.gather(*[
            client.put('/v1/project-agents/engineer/memory', json=payload)
            for payload in payloads
        ])
        assert sorted(response.status_code for response in responses) == [200, 409]
        winner = next(payload for payload, result in zip(payloads, responses)
            if result.status_code == 200)
        retries = await asyncio.gather(*[
            client.put('/v1/project-agents/engineer/memory', json=winner)
            for _ in range(3)
        ])
        assert all(response.status_code == 200 for response in retries)
        assert all(response.json()['revision'] == 1 for response in retries)
        latest = await client.get('/v1/project-agents/engineer/memory', params={
            'personal_space_id': space_id, 'personal_project_id': 'sample-project', 'limit': 10,
        })
        assert len(latest.json()['history']) == 1


@pytest.mark.asyncio
async def test_lifecycle_stop_and_checkpoint_survive_independent_provider_runtimes():
    settings = fixture_settings()
    async with provider_client(settings) as (client, token):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic durable lifecycle', 'kind': 'personal',
        })
        space_id = space.json()['id']
        await seed_agent(client, space_id)
        begun = await client.put('/v1/task-contexts', json={
            'personal_space_id': space_id, 'personal_project_id': 'sample-project',
            'project_agent_id': 'engineer', 'session_id': 'synthetic-session',
            'source_session_id': 'ephemeral-entry-mcp-host',
            'source_application': 'codex', 'token': 'fuli-task-synthetic-context',
            'memory_revision': 0, 'turn_id': 'turn-one',
        })
        assert begun.status_code == 200, begun.text
        task_token = begun.json()['token']

    async with provider_client(settings, token) as (client, _):
        params = {'personal_space_id': space_id, 'session_id': 'synthetic-session',
            'source_application': 'codex'}
        pending = await client.get('/v1/task-context-sessions/checkpoint', params=params)
        assert pending.status_code == 200, pending.text
        assert pending.json()['status'] == 'checkpoint_required'
        assert pending.json()['task_context_token'] == task_token
        other_host = await client.get('/v1/task-context-sessions/checkpoint',
            params={**params, 'source_application': 'cursor'})
        assert other_host.json()['status'] == 'not_started'
        checkpoint = {'personal_space_id': space_id, 'source_application': 'codex',
            'disposition': 'retain_nothing',
            'reason': 'No durable change in this synthetic test.',
            'fingerprint': 'a' * 64}
        prepared = await client.put(f'/v1/task-contexts/{task_token}/checkpoint', json={
            **checkpoint, 'phase': 'prepare', 'agent_memory': {
                'expected_revision': 0,
                'memory': {'summary': 'Stable lifecycle session provenance.'},
            },
        })
        assert prepared.status_code == 200, prepared.text
        assert prepared.json()['agent_memory']['source_session_id'] == 'synthetic-session'
        saved = await client.put(f'/v1/task-contexts/{task_token}/checkpoint',
            json={**checkpoint, 'phase': 'complete'})
        assert saved.status_code == 200, saved.text

    async with provider_client(settings, token) as (client, _):
        verified = await client.get('/v1/task-context-sessions/checkpoint', params=params)
        assert verified.json()['status'] == 'checkpointed'
        retry = await client.put(f'/v1/task-contexts/{task_token}/checkpoint',
            json={**checkpoint, 'phase': 'complete'})
        assert retry.status_code == 200
        conflict = await client.put(f'/v1/task-contexts/{task_token}/checkpoint', json={
            **checkpoint, 'reason': 'Different review.', 'fingerprint': 'b' * 64,
        })
        assert conflict.status_code == 409


@pytest.mark.asyncio
async def test_memory_isolated_by_project_agent_and_personal_space():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic isolated roles', 'kind': 'personal',
        })
        space_id = space.json()['id']
        await seed_agent(client, space_id)
        await seed_agent(client, space_id, project='other-project')
        await seed_agent(client, space_id, agent='reviewer')
        saved = await client.put('/v1/project-agents/engineer/memory', json=write_payload(space_id))
        assert saved.status_code == 200, saved.text
        for project_id, agent_id in [('other-project', 'engineer'), ('sample-project', 'reviewer')]:
            response = await client.get(f'/v1/project-agents/{agent_id}/memory', params={
                'personal_space_id': space_id, 'personal_project_id': project_id,
            })
            assert response.status_code == 200, response.text
            assert response.json()['current'] is None
            assert response.json()['revision'] == 0
        other_space = await client.post('/v1/spaces', json={
            'name': 'Synthetic other personal space', 'kind': 'personal',
        })
        response = await client.get('/v1/project-agents/engineer/memory', params={
            'personal_space_id': other_space.json()['id'], 'personal_project_id': 'sample-project',
        })
        assert response.status_code == 404
        archived = await client.delete('/v1/project-agents/engineer', params={
            'personal_space_id': space_id, 'reason': 'Synthetic archival test',
        })
        assert archived.status_code == 200, archived.text
        rejected = await client.put('/v1/project-agents/engineer/memory', json=write_payload(space_id,
            expected_revision=1, idempotency_key='after-archive'))
        assert rejected.status_code in {404, 409}


@pytest.mark.asyncio
async def test_automatic_owner_balances_live_sessions_before_continuity():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic live-session routing', 'kind': 'personal',
        })
        space_id = space.json()['id']
        await seed_agent(client, space_id, agent='engineer')
        await seed_agent(client, space_id, agent='reviewer')
        context = {'personal_space_id': space_id, 'personal_project_id': 'sample-project',
            'source_application': 'codex', 'work_kind': 'implementation',
            'required_capabilities': ['coding']}
        first = await client.post('/v1/project-agent-context/resolve', json=context)
        assert first.status_code == 200, first.text
        assert first.json()['agent']['agent_id'] == 'engineer'
        begun = await client.put('/v1/task-contexts', json={
            'personal_space_id': space_id, 'personal_project_id': 'sample-project',
            'project_agent_id': 'engineer', 'session_id': 'busy-codex-session',
            'source_application': 'codex', 'token': 'fuli-task-busy-synthetic-role',
        })
        assert begun.status_code == 200, begun.text
        same_host = await client.post('/v1/project-agent-context/resolve',
            json={**context, 'session_id': 'busy-codex-session'})
        assert same_host.status_code == 200, same_host.text
        assert same_host.json()['agent']['agent_id'] == 'engineer'
        assert same_host.json()['reason'] == 'active_task_owner'
        next_host = await client.post('/v1/project-agent-context/resolve',
            json={**context, 'source_application': 'cursor'})
        assert next_host.status_code == 200, next_host.text
        assert next_host.json()['agent']['agent_id'] == 'reviewer'
        unqualified = await client.post('/v1/project-agent-context/resolve',
            json={**context, 'required_capabilities': ['absent-capability']})
        assert unqualified.json()['status'] == 'unassigned'
