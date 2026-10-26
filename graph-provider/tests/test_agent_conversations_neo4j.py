"""Synthetic data only; requires an explicitly disposable loopback database."""
import asyncio
from uuid import uuid4
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


def test_context_proofs_name_only_the_asking_sessions_own_native_events():
    """rec#15 PR2: a session's task entry asks with its own ID and gets each
    message's full-content hash, plus the event ID of its own native records."""
    async def scenario():
        async with provider_client(fixture_settings()) as (client, _):
            space = (await client.post('/v1/spaces', json={'name':'Synthetic proofs', 'kind':'personal'})).json()['id']
            project = 'proofs-' + uuid4().hex[:10]
            await seed_agent(client, space, project=project, allowed_clients=['codex', 'claude_code'])
            codex = dict(personal_space_id=space, personal_project_id=project, agent_id='engineer', source_application='codex')
            claude = {**codex, 'source_application': 'claude_code'}
            async def begin(session, source):
                token = 'fuli-task-' + uuid4().hex
                r = await client.put('/v1/task-contexts', json=dict(personal_space_id=space,
                    personal_project_id=project, project_agent_id='engineer', session_id=session,
                    source_application=source, token=token))
                assert r.status_code == 200, r.text
                return token
            c_token = await begin('shared-id', 'codex')
            first = await client.post('/v1/agent-conversations/append', json={**codex, 'session_id': 'shared-id',
                'task_context_token': c_token, 'events': [dict(event_id='jsonl-v1:0:0:0', role='user', content='xxx')]})
            assert first.status_code == 200, first.text
            cid = first.json()['conversation_id']
            # Another client with the same native session ID writes the same event ID.
            h_token = await begin('shared-id', 'claude_code')
            assert (await client.post('/v1/agent-conversations/resume', json={**claude, 'session_id': 'shared-id',
                'task_context_token': h_token, 'conversation_id': cid})).status_code == 200
            assert (await client.post('/v1/agent-conversations/append', json={**claude, 'session_id': 'shared-id',
                'task_context_token': h_token,
                'events': [dict(event_id='jsonl-v1:0:0:0', role='user', content='zzz')]})).status_code == 200
            asked = await client.post('/v1/agent-conversations/query', json={**codex, 'conversation_id': cid,
                'mode': 'context', 'session_id': 'shared-id'})
            assert asked.status_code == 200, asked.text
            messages = asked.json()['context']['messages']
            assert [(m['content'], m.get('own_event')) for m in messages] == [('xxx', 'jsonl-v1:0:0:0'), ('zzz', None)]
            assert all(len(m['content_sha256']) == 64 for m in messages)
            plain = await client.post('/v1/agent-conversations/query', json={**codex, 'conversation_id': cid, 'mode': 'context'})
            assert all(set(m) == {'sequence', 'role', 'content'} for m in plain.json()['context']['messages'])
    asyncio.run(scenario())


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
            # Compaction is by size, not age: past the threshold, older messages
            # fold into request notes while raw events remain readable.
            tight = await client.put('/v1/agent-conversations/policy', json={**owner,
                'policy':{'compact_after_kb':8,'context_budget':4000,'enabled':True}})
            assert tight.status_code == 200, tight.text
            bulk = {**cc, 'session_id':'second', 'task_context_token':cc_token, 'events':[
                dict(event_id=f'bulk-{index}', role='user' if index % 2 == 0 else 'assistant',
                     content=(f'Request {index}\n' if index % 2 == 0 else '') + 'x' * 1500)
                for index in range(8)]}
            folded = await client.post('/v1/agent-conversations/append', json=bulk)
            assert folded.status_code == 200, folded.text
            recovered = (await client.post('/v1/agent-conversations/query', json={**cc,
                'conversation_id':cid, 'mode':'context'})).json()
            assert recovered['compacted_through'] > 0
            # Default recovery uses the checkpoint and recent raw, including
            # source sequences; the stored digest is only read on demand.
            assert recovered['context']['summary_role'] == 'historical'
            assert recovered['context']['latest_checkpoint'] == {
                'status': 'completed', 'summary': 'Second result', 'truncated': False}
            assert recovered['context']['summary'] == ''
            assert recovered['context']['truncated'] is True
            assert recovered['context']['conversation_id'] == cid
            assert recovered['context']['revision'] == recovered['revision']
            assert all('Request 0' not in message['content'] for message in recovered['context']['messages'])
            originals = (await client.post('/v1/agent-conversations/query', json={**cc,
                'conversation_id':cid, 'mode':'events', 'limit':50})).json()
            assert originals['raw_retained'] is True
            assert any(event['content'] == 'Synthetic task' for event in originals['events'])
            assert originals['digest']['tasks'][0]['summary'] == 'First result'
            for message in recovered['context']['messages']:
                original = (await client.post('/v1/agent-conversations/query', json={**cc,
                    'conversation_id':cid, 'mode':'events', 'after':message['sequence'] - 1, 'limit':1})).json()
                assert original['events'][0]['content'] == message['content']
            # A tiny budget truthfully truncates a Unicode/escaped checkpoint;
            # its full source is readable without retrieving an old raw page.
            assert (await client.put('/v1/agent-conversations/policy', json={**owner,
                'policy':{'compact_after_kb':8,'context_budget':512,'enabled':True}})).status_code == 200
            full_checkpoint = '完成😀"\\\n' * 300 + 'END'
            assert (await client.post('/v1/agent-conversations/append', json={**later,
                'summary':full_checkpoint, 'events':[dict(event_id='large-checkpoint', role='summary',
                    kind='checkpoint', content=full_checkpoint)]})).status_code == 200
            bounded = (await client.post('/v1/agent-conversations/query', json={**cc,
                'conversation_id':cid, 'mode':'context'})).json()['context']
            import json
            assert len(json.dumps(bounded, ensure_ascii=False, separators=(',', ':')).encode()) <= 512
            assert bounded['truncated'] and bounded['latest_checkpoint']['truncated']
            assert full_checkpoint.startswith(bounded['latest_checkpoint']['summary'].removesuffix('…'))
            reread = (await client.post('/v1/agent-conversations/query', json={**cc,
                'conversation_id':cid, 'mode':'events', 'after':bounded['revision'], 'limit':1})).json()
            assert reread['events'] == [] and reread['summary'] == full_checkpoint
            assert reread['revision'] == bounded['revision']
            policy = await client.put('/v1/agent-conversations/policy', json={**owner,'policy':{'compact_after_kb':64,'context_budget':1000,'enabled':False}})
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


def test_begin_returns_the_three_steps_in_one_request_and_keeps_their_privacy_rules():
    """rec#11 D-53: a task entry's session read, recovery or latest pointer and
    empty append in one request, each with its own route's checks."""
    async def scenario():
        async with provider_client(fixture_settings()) as (client, _):
            space = (await client.post('/v1/spaces', json={'name':'Synthetic begin', 'kind':'personal'})).json()['id']
            project = 'begin-' + uuid4().hex[:10]
            await seed_agent(client, space, project=project, allowed_clients=['codex', 'claude_code'])
            await seed_agent(client, space, project=project, agent='specialist', allowed_clients=['codex'])
            codex = dict(personal_space_id=space, personal_project_id=project, agent_id='engineer', source_application='codex')

            async def task(session, agent='engineer', source='codex'):
                token = 'fuli-task-' + uuid4().hex
                r = await client.put('/v1/task-contexts', json=dict(personal_space_id=space, personal_project_id=project,
                    project_agent_id=agent, session_id=session, source_application=source, token=token))
                assert r.status_code == 200, r.text
                return token

            async def begin(scope, session, token):
                return await client.post('/v1/agent-conversations/begin', json={**scope, 'session_id': session,
                    'task_context_token': token})

            async def bound(scope, session):
                return (await client.post('/v1/agent-conversations/query', json={**scope, 'mode': 'session',
                    'session_id': session})).json()['conversation_id']
            # A first entry: nothing to recover, nothing earlier in this scope; it opens this task's conversation.
            first = await begin(codex, 'native-a', await task('native-a'))
            assert first.status_code == 200, first.text
            opened = first.json()
            assert {key: opened[key] for key in ('status', 'revision', 'recovered_from', 'previous', 'recent')} == {
                'status': 'saved', 'revision': 0, 'recovered_from': None, 'previous': None, 'recent': None}
            assert await bound(codex, 'native-a') == opened['conversation_id']
            token_a = await task('native-a')
            for event_id, content in (('jsonl-v1:0:0:0', 'SYNTHETIC_OWN'), ('jsonl-v1:9:0:0', 'SYNTHETIC_SECOND')):
                assert (await client.post('/v1/agent-conversations/append', json={**codex, 'session_id': 'native-a',
                    'task_context_token': token_a,
                    'events': [dict(event_id=event_id, role='user', content=content)]})).status_code == 200
            # The same session's next entry recovers exactly what the context query returns for it, proofs included.
            again = (await begin(codex, 'native-a', await task('native-a'))).json()
            expected = (await client.post('/v1/agent-conversations/query', json={**codex, 'mode': 'context',
                'conversation_id': opened['conversation_id'], 'session_id': 'native-a'})).json()
            assert again['recovered_from'] == opened['conversation_id'] and again['recent'] is None
            assert again['previous'] == expected
            assert [m.get('own_event') for m in again['previous']['context']['messages']] == [
                'jsonl-v1:0:0:0', 'jsonl-v1:9:0:0']
            assert again['conversation_id'] == opened['conversation_id'] and again['revision'] == 2
            # A new native session gets only the latest conversation of this scope, as the list query has it.
            listed = (await client.post('/v1/agent-conversations/query', json={**codex, 'mode': 'list', 'limit': 1})).json()
            fresh = (await begin(codex, 'native-b', await task('native-b'))).json()
            assert fresh['previous'] is None and fresh['recovered_from'] is None
            assert fresh['recent'] == listed['conversations'][0] and fresh['recent']['id'] == opened['conversation_id']
            assert fresh['conversation_id'] != opened['conversation_id']
            # Another client's session with the same native ID is not this session: nothing is recovered for it.
            claude = {**codex, 'source_application': 'claude_code'}
            other_client = (await begin(claude, 'native-a', await task('native-a', source='claude_code'))).json()
            assert other_client['recovered_from'] is None and other_client['previous'] is None
            # Another FLA of the same project never sees this Agent's conversations.
            specialist = {**codex, 'agent_id': 'specialist'}
            own = (await begin(specialist, 'native-c', await task('native-c', agent='specialist'))).json()
            assert own['recent'] is None and own['recovered_from'] is None
            # Refusals leave nothing behind and return no read: a client the Agent may not use,
            # a task of another session or Agent, an unknown token, another project.
            token_d = await task('native-d')
            for scope, session, token, status in [
                ({**specialist, 'source_application': 'claude_code'}, 'native-d', token_d, 403),
                (codex, 'native-e', token_d, 409),
                (specialist, 'native-d', token_d, 409),
                (codex, 'native-d', 'fuli-task-missing', 404),
                ({**codex, 'personal_project_id': 'begin-foreign'}, 'native-d', token_d, 404),
            ]:
                refused = await begin(scope, session, token)
                assert refused.status_code == status, (scope, session, refused.text)
                assert set(refused.json()) == {'detail'}
            assert await bound(codex, 'native-d') is None and await bound(codex, 'native-e') is None
            # Recording off for this Agent: no conversation is opened; what was bound is still recovered, as before.
            assert (await client.put('/v1/agent-conversations/policy', json={**codex, 'source_application': None,
                'policy': {'compact_after_kb': 64, 'context_budget': 4000, 'enabled': False}})).status_code == 200
            disabled = (await begin(codex, 'native-a', await task('native-a'))).json()
            assert disabled['status'] == 'capture_disabled' and 'conversation_id' not in disabled
            assert disabled['recovered_from'] == opened['conversation_id']
            off = (await begin(codex, 'native-f', await task('native-f'))).json()
            assert off['status'] == 'capture_disabled' and await bound(codex, 'native-f') is None
    asyncio.run(scenario())
