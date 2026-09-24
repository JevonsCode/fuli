"""Synthetic data only; requires an explicitly disposable loopback database."""
import asyncio
from uuid import uuid4
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


def test_conversation_cross_client_replay_isolation_and_policy():
    async def scenario():
        async with provider_client(fixture_settings()) as (client, _):
            space = (await client.post('/v1/spaces', json={'name':'Synthetic conversations', 'kind':'personal'})).json()['id']
            project = 'conversation-' + uuid4().hex[:10]
            await seed_agent(client, space, project=project, allowed_clients=['codex', 'claude_code'])
            scope = dict(personal_space_id=space, personal_project_id=project, agent_id='engineer', source_application='codex')
            async def begin(session, source):
                token = 'fuli-task-' + uuid4().hex
                r = await client.put('/v1/task-contexts', json=dict(personal_space_id=space,
                    personal_project_id=project, project_agent_id='engineer', session_id=session,
                    source_application=source, token=token))
                assert r.status_code == 200, r.text
                return token
            token = await begin('first', 'codex')
            base = dict(**scope, session_id='first', task_context_token=token)
            # Real hook order: query a fresh stream, begin the task, claim; no append seeds the cursor.
            fresh = await client.post('/v1/agent-conversations/query', json={**scope, 'session_id':'first', 'mode':'session'})
            assert fresh.json() == {'conversation_id': None, 'cursor': 0, 'initialized': False}
            boundary = await client.post('/v1/agent-conversations/boundary', json={**base,
                'expected_cursor':0, 'cursor':0, 'initialize_cursor':True})
            assert boundary.status_code == 200, boundary.text
            payload = dict(**scope, session_id='first', task_context_token=token,
                events=[dict(event_id='prompt', role='user', content='Synthetic task'),
                        dict(event_id='summary', role='summary', kind='checkpoint', content='First result')],
                summary='First result', status='completed', expected_cursor=0, cursor=100)
            r = await client.post('/v1/agent-conversations/append', json=payload)
            assert r.status_code == 200, r.text
            cid = r.json()['conversation_id']
            revision = r.json()['revision']
            assert (await client.post('/v1/agent-conversations/append', json={k:v for k,v in payload.items() if k not in ('cursor','expected_cursor')})).json()['revision'] == revision
            # Content mismatch fails atomically; old event remains.
            bad = {**payload, 'expected_cursor': 100, 'events': [dict(event_id='prompt', role='user', content='Changed')]}
            assert (await client.post('/v1/agent-conversations/append', json=bad)).status_code == 409
            cc = {**scope, 'source_application': 'claude_code'}
            cc_token = await begin('second', 'claude_code')
            r = await client.post('/v1/agent-conversations/resume', json={**cc, 'session_id':'second', 'task_context_token':cc_token, 'conversation_id':cid})
            assert r.status_code == 200, r.text
            later = {**cc, 'session_id':'second', 'task_context_token':cc_token, 'summary':'Second result', 'status':'completed',
                     'events':[dict(event_id='later', role='summary', kind='checkpoint', content='Second result')]}
            assert (await client.post('/v1/agent-conversations/append', json=later)).status_code == 200
            assert (await client.post('/v1/agent-conversations/append', json={k:v for k,v in payload.items() if k not in ('cursor','expected_cursor')})).status_code == 200
            read = await client.post('/v1/agent-conversations/query', json={**cc,'conversation_id':cid,'mode':'context'})
            assert read.status_code == 200, read.text
            assert read.json()['summary'] == 'Second result'
            # One native stream keeps its cursor when the selected Agent changes.
            await seed_agent(client, space, project=project, agent='specialist', allowed_clients=['codex'])
            next_token = 'fuli-task-' + uuid4().hex
            r = await client.put('/v1/task-contexts', json=dict(personal_space_id=space,
                personal_project_id=project, project_agent_id='specialist', session_id='first', source_application='codex', token=next_token))
            assert r.status_code == 200, r.text
            changed = {**base, 'agent_id':'specialist', 'task_context_token':next_token}
            stream = await client.post('/v1/agent-conversations/query', json={**scope, 'agent_id':'specialist', 'session_id':'first', 'mode':'session'})
            assert stream.json()['cursor'] == 100
            raw = {**changed, 'expected_cursor':100, 'cursor':110, 'events':[dict(event_id='new',role='user',content='New task')]}
            assert (await client.post('/v1/agent-conversations/append', json=raw)).status_code == 409
            assert (await client.post('/v1/agent-conversations/boundary', json={**changed, 'expected_cursor':100,'cursor':110})).status_code == 422
            assert (await client.post('/v1/agent-conversations/boundary', json={**changed, 'expected_cursor':100,'cursor':100})).status_code == 200
            assert (await client.post('/v1/agent-conversations/append', json=raw)).status_code == 200
            owner = {**scope, 'source_application':None}
            assert (await client.post('/v1/agent-conversations/query', json={**owner,'mode':'list'})).status_code == 200
            assert (await client.post('/v1/agent-conversations/query', json={**scope,'agent_id':'foreign','mode':'events','conversation_id':cid})).status_code == 404
            policy = await client.put('/v1/agent-conversations/policy', json={**owner,'policy':{'idle_days':7,'context_budget':1000,'enabled':False}})
            assert policy.status_code == 200, policy.text
            assert (await client.post('/v1/agent-conversations/append',json=later)).json()['status'] == 'capture_disabled'
    asyncio.run(scenario())


def test_fresh_boundary_authorization_and_concurrent_initialization():
    async def scenario():
        async with provider_client(fixture_settings()) as (client, _):
            space = (await client.post('/v1/spaces', json={'name':'Synthetic fresh boundary', 'kind':'personal'})).json()['id']
            project = 'boundary-' + uuid4().hex[:10]
            await seed_agent(client, space, project=project, allowed_clients=['codex'])
            scope = dict(personal_space_id=space, personal_project_id=project, agent_id='engineer', source_application='codex')
            token = 'fuli-task-' + uuid4().hex
            response = await client.put('/v1/task-contexts', json={**{k:v for k,v in scope.items() if k != 'agent_id'},
                'project_agent_id':'engineer', 'session_id':'fresh', 'token':token})
            assert response.status_code == 200, response.text
            base = {**scope, 'session_id':'fresh', 'task_context_token':token,
                'expected_cursor':0, 'cursor':0, 'initialize_cursor':True}
            # Denied scopes/tokens and stale expectations cannot initialize a fresh stream.
            for changes, status in [({'source_application':'cursor'}, 403),
                                    ({'task_context_token':'fuli-task-missing'}, 404),
                                    ({'expected_cursor':1, 'cursor':1}, 409),
                                    ({'initialize_cursor':False}, 409)]:
                rejected = await client.post('/v1/agent-conversations/boundary', json={**base, **changes})
                assert rejected.status_code == status, rejected.text
                session = await client.post('/v1/agent-conversations/query', json={**scope, 'session_id':'fresh', 'mode':'session'})
                assert session.json() == {'conversation_id':None, 'cursor':0, 'initialized':False}
            # Different proposed boundaries race: exactly one wins, including the zero-byte case.
            responses = await asyncio.gather(*[client.post('/v1/agent-conversations/boundary', json={**base, 'cursor':cursor}) for cursor in (0, 4)])
            assert sorted(response.status_code for response in responses) == [200, 409]
            winner = next(response.json()['cursor'] for response in responses if response.status_code == 200)
            session = await client.post('/v1/agent-conversations/query', json={**scope, 'session_id':'fresh', 'mode':'session'})
            assert session.json() == {'conversation_id':None, 'cursor':winner, 'initialized':True}
            # Initializing did not create placeholder conversations or import skipped historical bytes.
            listing = await client.post('/v1/agent-conversations/query', json={**scope, 'mode':'list'})
            assert listing.json() == {'conversations':[]}
            appended = await client.post('/v1/agent-conversations/append', json={**base, 'initialize_cursor':False,
                'expected_cursor':winner, 'cursor':winner+8, 'events':[{'event_id':'first', 'role':'user', 'content':'New task'}]})
            assert appended.status_code == 200, appended.text
            assert appended.json()['revision'] == 1
    asyncio.run(scenario())
