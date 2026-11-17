"""Who began a task lately, for the desktop client's tray menu, against a disposable graph."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_project_agent_team_lifecycle_neo4j import bind


@pytest.mark.asyncio
async def test_recent_working_agents_names_each_agent_once_and_whether_a_task_is_under_way():
    async with provider_client(fixture_settings()) as (client, _):
        space = (await client.post('/v1/spaces', json={
            'name': 'Synthetic recent work', 'kind': 'personal'})).json()['id']
        other = (await client.post('/v1/spaces', json={
            'name': 'Synthetic other space', 'kind': 'personal'})).json()['id']
        for agent in ['engineer', 'reviewer', 'tester']:
            await seed_agent(client, space, agent=agent)
        await seed_agent(client, other, agent='outsider')

        async def begin(session, agent, space_id=space):
            token = 'fuli-task-' + uuid4().hex
            response = await client.put('/v1/task-contexts', json={
                'personal_space_id': space_id, 'personal_project_id': 'sample-project' if agent else None,
                'project_agent_id': agent, 'session_id': session, 'source_application': 'codex', 'token': token})
            assert response.status_code == 200, response.text
            return token

        async def close(token, summary):
            checkpoint = {'personal_space_id': space, 'source_application': 'codex',
                'disposition': 'retain_nothing', 'reason': 'Synthetic closed work.', 'fingerprint': 'd' * 64,
                'work_log': {'status': 'completed', 'summary': summary}}
            for phase in ['prepare', 'complete']:
                response = await client.put(f'/v1/task-contexts/{token}/checkpoint', json={**checkpoint, 'phase': phase})
                assert response.status_code == 200, response.text

        async def recent(since):
            response = await client.get('/v1/task-context-agents/recent', params={
                'personal_space_id': space, 'since': since})
            assert response.status_code == 200, response.text
            return response.json()

        hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        assert await recent(hour_ago) == []

        # The reviewer's only task is closed with a summary of several lines.
        await close(await begin('reviewer-session', 'reviewer'),
                    '\n  The first line of a synthetic result that runs well past the tray menu width\nA second line.')
        # The engineer's first task is superseded by its session's second, which
        # coordinates a board task; a later errand in another session is closed.
        await begin('engineer-session', 'engineer')
        working = await begin('engineer-session', 'engineer')
        board = await client.post('/v1/project-agent-tasks', json={
            'personal_space_id': space, 'personal_project_id': 'sample-project',
            'idempotency_key': 'synthetic-tray-title', 'title': 'Synthetic tray wording fix',
            'objective': 'Verify the tray names the task.', 'work_kind': 'implementation',
            'source_application': 'codex', 'staffing_intent': 'reuse_preferred', 'lead_agent_id': 'reviewer',
            'coordinator_agent_id': 'engineer', 'routing_reason': 'Synthetic tray acceptance.'})
        assert board.status_code == 200, board.text
        bound = await bind(client, {'personal_space_id': space, 'personal_project_id': 'sample-project'},
                           working, board.json()['task']['task_id'])
        assert bound.status_code == 200, bound.text
        await close(await begin('engineer-errand', 'engineer'), 'Synthetic side errand.')
        # The tester's task is open, with neither a board task nor a summary.
        await begin('tester-session', 'tester')
        await begin('nobody-session', None)
        await begin('outsider-session', 'outsider', other)

        listed = await recent(hour_ago)
        assert [(row['agent_id'], row['working']) for row in listed] == [
            ('tester', True), ('engineer', True), ('reviewer', False)]
        assert all(datetime.fromisoformat(row['last_active']).tzinfo is not None for row in listed)
        assert listed[0]['last_active'] > listed[1]['last_active'] > listed[2]['last_active']
        assert {row['agent_id']: (row['personal_project_id'], row['title']) for row in listed} == {
            'tester': ('sample-project', None),
            # The task under way, not the later closed errand.
            'engineer': ('sample-project', 'Synthetic tray wording fix'),
            # The summary's first line, cut to what the tray holds.
            'reviewer': ('sample-project', 'The first line of a synthetic result that runs well past the'),
        }

        assert await recent((datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()) == []
        without_zone = await client.get('/v1/task-context-agents/recent', params={
            'personal_space_id': space, 'since': '2026-11-16T00:00:00'})
        assert without_zone.status_code == 422
