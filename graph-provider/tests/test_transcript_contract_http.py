"""Synthetic HTTP/store doubles; no user's conversation or database is accessed."""
import json
import os
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'synthetic-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'synthetic-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings


def fixture(rows=()):
    application = create_app(Settings(bootstrap_token='synthetic-bootstrap-token-1234', neo4j_password='synthetic-password'))
    calls = []

    async def execute_query(query, **parameters):
        calls.append((query, parameters))
        return list(rows), None, None

    async def authenticate(token):
        if token != 'synthetic-access':
            raise HTTPException(401, 'Unauthorized')
        return {'id': 'synthetic-principal'}

    async def authorize(actor, space_id, role):
        assert actor == {'id': 'synthetic-principal'}
        assert role == 'reader'
        if space_id != 'synthetic-space':
            raise HTTPException(403, 'Forbidden')
        return {'id': space_id, 'kind': 'personal'}

    application.state.store.runtime = SimpleNamespace(driver=SimpleNamespace(execute_query=execute_query))
    application.state.store.authenticate = authenticate
    application.state.store.authorize = authorize
    return application, calls


@pytest.mark.asyncio
async def test_health_advertises_only_the_registered_transcript_contract():
    application, _ = fixture()

    async def health():
        return {'status': 'ok'}

    application.state.store.health = health
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url='http://provider.test') as client:
        result = await client.get('/health')
    assert result.status_code == 200
    assert result.json()['transcript_contract'] == 1
    assert isinstance(result.json()['provider_version'], str)
    paths = application.openapi()['paths']
    assert 'get' in paths['/v1/task-context-sessions/current']
    for operation in ['query', 'append', 'boundary']:
        assert 'post' in paths[f'/v1/agent-conversations/{operation}']


@pytest.mark.asyncio
@pytest.mark.parametrize('rows,expected', [([], None), ([{'record_json': json.dumps({'token': 'synthetic-task', 'personal_project_id': 'synthetic-project', 'project_agent_id': 'synthetic-agent'})}], {'token': 'synthetic-task', 'personal_project_id': 'synthetic-project', 'project_agent_id': 'synthetic-agent'})])
async def test_current_session_returns_nullable_context_instead_of_a_route_404(rows, expected):
    application, calls = fixture(rows)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url='http://provider.test') as client:
        result = await client.get('/v1/task-context-sessions/current', params={'personal_space_id': 'synthetic-space', 'session_id': 'synthetic-session', 'source_application': 'codex'}, headers={'authorization': 'Bearer synthetic-access'})
    assert result.status_code == 200
    assert result.json() == expected
    assert len(calls) == 1
    assert 't.token=s.current_token' in calls[0][0]


@pytest.mark.asyncio
@pytest.mark.parametrize('token,space,status', [('invalid', 'synthetic-space', 401), ('synthetic-access', 'foreign-space', 403)])
async def test_current_session_checks_authority_before_reading_any_context(token, space, status):
    application, calls = fixture()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url='http://provider.test') as client:
        result = await client.get('/v1/task-context-sessions/current', params={'personal_space_id': space, 'session_id': 'synthetic-session', 'source_application': 'codex'}, headers={'authorization': f'Bearer {token}'})
    assert result.status_code == status
    assert calls == []


@pytest.mark.asyncio
async def test_current_session_query_isolated_by_host_source_and_session():
    application, calls = fixture()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url='http://provider.test') as client:
        for source, session in [('codex', 'session-one'), ('claude_code', 'session-one'), ('codex', 'session-two')]:
            result = await client.get('/v1/task-context-sessions/current', params={'personal_space_id': 'synthetic-space', 'session_id': session, 'source_application': source}, headers={'authorization': 'Bearer synthetic-access'})
            assert result.status_code == 200
            assert result.json() is None
    assert len({parameters['id'] for _, parameters in calls}) == 3
