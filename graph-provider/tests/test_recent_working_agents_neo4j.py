"""Who began a task lately, for the desktop client's tray menu, against a disposable graph."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


@pytest.mark.asyncio
async def test_recent_working_agents_names_each_agent_once_and_whether_a_task_is_under_way():
    async with provider_client(fixture_settings()) as (client, _):
        space = (await client.post('/v1/spaces', json={
            'name': 'Synthetic recent work', 'kind': 'personal'})).json()['id']
        other = (await client.post('/v1/spaces', json={
            'name': 'Synthetic other space', 'kind': 'personal'})).json()['id']
        for agent in ['engineer', 'reviewer']:
            await seed_agent(client, space, agent=agent)
        await seed_agent(client, other, agent='outsider')

        async def begin(session, agent, space_id=space):
            token = 'fuli-task-' + uuid4().hex
            response = await client.put('/v1/task-contexts', json={
                'personal_space_id': space_id, 'personal_project_id': 'sample-project' if agent else None,
                'project_agent_id': agent, 'session_id': session, 'source_application': 'codex', 'token': token})
            assert response.status_code == 200, response.text
            return token

        async def recent(since):
            response = await client.get('/v1/task-context-agents/recent', params={
                'personal_space_id': space, 'since': since})
            assert response.status_code == 200, response.text
            return response.json()

        hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        assert await recent(hour_ago) == []

        # The reviewer's only task is closed; the engineer's first is superseded by its session's second.
        closed = await begin('reviewer-session', 'reviewer')
        checkpoint = {'personal_space_id': space, 'source_application': 'codex', 'phase': 'prepare',
            'disposition': 'retain_nothing', 'reason': 'Synthetic closed work.', 'fingerprint': 'd' * 64,
            'work_log': {'status': 'completed', 'summary': 'Synthetic result.'}}
        for phase in ['prepare', 'complete']:
            response = await client.put(f'/v1/task-contexts/{closed}/checkpoint', json={**checkpoint, 'phase': phase})
            assert response.status_code == 200, response.text
        await begin('engineer-session', 'engineer')
        await begin('engineer-session', 'engineer')
        await begin('nobody-session', None)
        await begin('outsider-session', 'outsider', other)

        listed = await recent(hour_ago)
        assert [(row['agent_id'], row['working']) for row in listed] == [('engineer', True), ('reviewer', False)]
        assert all(datetime.fromisoformat(row['last_active']).tzinfo is not None for row in listed)
        assert listed[0]['last_active'] > listed[1]['last_active']

        assert await recent((datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()) == []
        without_zone = await client.get('/v1/task-context-agents/recent', params={
            'personal_space_id': space, 'since': '2026-11-16T00:00:00'})
        assert without_zone.status_code == 422
