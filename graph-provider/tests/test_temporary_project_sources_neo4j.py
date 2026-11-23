"""Temporary project sources on a disposable Neo4j: real conversation records,
real temporary projects in both ID formats. Synthetic spaces, projects and sessions."""
import asyncio
from uuid import uuid4

from fuli_graph.temporary_project_scope import conversation_fallback_project_id, session_temporary_project_id
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


def test_sources_come_only_from_recorded_sessions_whose_derived_id_matches_exactly():
    async def scenario():
        async with provider_client(fixture_settings()) as (client, _):
            space = (await client.post('/v1/spaces', json={'name': 'Synthetic sources', 'kind': 'personal'})).json()['id']
            project = 'sources-' + uuid4().hex[:10]
            await seed_agent(client, space, project=project, allowed_clients=['codex', 'claude_code'])
            token = 'fuli-task-' + uuid4().hex
            assert (await client.put('/v1/task-contexts', json=dict(personal_space_id=space, personal_project_id=project,
                project_agent_id='engineer', session_id='qa-native-17', source_application='codex', token=token))).status_code == 200
            appended = await client.post('/v1/agent-conversations/append', json=dict(personal_space_id=space,
                personal_project_id=project, agent_id='engineer', source_application='codex', session_id='qa-native-17',
                task_context_token=token, events=[dict(event_id='jsonl-v1:0:0:0', role='user', content='synthetic')]))
            assert appended.status_code == 200, appended.text

            # The session's temporary project (current format) and the pre-2026-10-18 one.
            session_project = session_temporary_project_id(space, 'codex', 'qa-native-17')
            ensured = await client.post('/v1/temporary-projects/ensure', json=dict(personal_space_id=space,
                scope_key=session_project.removeprefix('temporary-'), source_application='codex', lifetime='session'))
            assert ensured.status_code == 200, ensured.text
            fallback = conversation_fallback_project_id(space, 'codex', 'qa-native-17')
            created = await client.put('/v1/personal-projects', json=dict(personal_space_id=space, project_id=fallback,
                profile={'name': '会话项目 / Conversation project', 'lifecycle': 'active', 'purpose': 'Synthetic session project.'}))
            assert created.status_code == 200, created.text
            # A session FULI has no record of, and a task temporary project: no source for either.
            unrecorded = session_temporary_project_id(space, 'claude_code', 'never-recorded')
            for scope_key, lifetime in ((unrecorded.removeprefix('temporary-'), 'session'), (uuid4().hex * 2, 'task')):
                made = await client.post('/v1/temporary-projects/ensure', json=dict(personal_space_id=space,
                    scope_key=scope_key, source_application='claude_code', lifetime=lifetime))
                assert made.status_code == 200, made.text

            answer = await client.get('/v1/personal-projects/temporary-sources', params={'personal_space_id': space})
            assert answer.status_code == 200, answer.text
            # The conversation text, its title and folders never leave; only client and session.
            assert answer.json() == sorted([
                {'personal_project_id': session_project, 'source_application': 'codex', 'session_id': 'qa-native-17'},
                {'personal_project_id': fallback, 'source_application': 'codex', 'session_id': 'qa-native-17'},
            ], key=lambda row: row['personal_project_id'])
            # The listing route still reads projects; this path is not taken as a project ID.
            assert (await client.get('/v1/personal-projects', params={'personal_space_id': space})).status_code == 200
    asyncio.run(scenario())
