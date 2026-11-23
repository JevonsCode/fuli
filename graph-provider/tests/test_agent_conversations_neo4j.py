"""Synthetic data only; requires an explicitly disposable loopback database."""
import asyncio
import json
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


def test_recovery_carries_the_newest_client_compaction_summary():
    """A client's own compaction summary is stored as its own event kind, never
    as a user message, and recovery points at (or carries) the newest one."""
    async def scenario():
        async with provider_client(fixture_settings()) as (client, _):
            space = (await client.post('/v1/spaces', json={'name':'Synthetic compaction', 'kind':'personal'})).json()['id']
            project = 'compaction-' + uuid4().hex[:10]
            await seed_agent(client, space, project=project, allowed_clients=['claude_code'])
            scope = dict(personal_space_id=space, personal_project_id=project, agent_id='engineer', source_application='claude_code')
            token = 'fuli-task-' + uuid4().hex
            assert (await client.put('/v1/task-contexts', json=dict(personal_space_id=space, personal_project_id=project,
                project_agent_id='engineer', session_id='native', source_application='claude_code', token=token))).status_code == 200
            base = {**scope, 'session_id': 'native', 'task_context_token': token}
            events = [dict(event_id='early', role='user', content='Synthetic early request'),
                      dict(event_id='older-summary', role='summary', kind='compaction_summary', content='Older synthetic summary'),
                      dict(event_id='newer-summary', role='summary', kind='compaction_summary', content='Newer synthetic summary'),
                      *[dict(event_id=f'turn-{index}', role='user', content=f'Later synthetic turn {index}') for index in range(4)]]
            saved = await client.post('/v1/agent-conversations/append', json={**base, 'events': events})
            assert saved.status_code == 200, saved.text
            cid = saved.json()['conversation_id']
            context = (await client.post('/v1/agent-conversations/query', json={**scope, 'conversation_id': cid,
                'mode': 'context'})).json()['context']
            assert context['compaction_summary'] == {'sequence': 3, 'bytes': 23, 'content': 'Newer synthetic summary'}
            assert all(message['role'] == 'user' and 'summary' not in message['content'] for message in context['messages'])
            page = (await client.post('/v1/agent-conversations/query', json={**scope, 'conversation_id': cid,
                'mode': 'events', 'limit': 50})).json()
            assert [event['kind'] for event in page['events'] if event['role'] == 'summary'] == ['compaction_summary'] * 2
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
            # The pointer carries the list row without where it was written from (a list names its sessions).
            assert fresh['recent'] == {key: value for key, value in listed['conversations'][0].items() if key != 'sessions'}
            assert fresh['recent']['id'] == opened['conversation_id']
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


def test_a_conversation_names_where_it_was_written_and_an_entry_names_the_agents_other_sessions():
    """11-18: an FLA can trace each of its conversations to the client,
    session, folder and model, and an entry says where else it works now."""
    async def scenario():
        async with provider_client(fixture_settings()) as (client, _):
            space = (await client.post('/v1/spaces', json={'name':'Synthetic provenance', 'kind':'personal'})).json()['id']
            project = 'trace-' + uuid4().hex[:10]
            await seed_agent(client, space, project=project, allowed_clients=['codex', 'claude_code'])
            await seed_agent(client, space, project=project, agent='specialist', allowed_clients=['codex'])
            scope = dict(personal_space_id=space, personal_project_id=project, agent_id='engineer')

            async def begin(source, session, provenance=None, agent='engineer'):
                token = 'fuli-task-' + uuid4().hex
                r = await client.put('/v1/task-contexts', json=dict(personal_space_id=space, personal_project_id=project,
                    project_agent_id=agent, session_id=session, source_application=source, token=token))
                assert r.status_code == 200, r.text
                r = await client.post('/v1/agent-conversations/begin', json={**scope, 'agent_id': agent,
                    'source_application': source, 'session_id': session, 'task_context_token': token,
                    **({'provenance': provenance} if provenance else {})})
                assert r.status_code == 200, r.text
                return r.json()

            codex = await begin('codex', 'synthetic-codex-1', {'working_directory': 'T:/synthetic/repo',
                'model': 'synthetic-model-a', 'title': 'Add the synthetic export'})
            assert 'elsewhere' in codex and codex['elsewhere'] == []
            # The same session's next entry keeps the first title and the folder; a newly reported model replaces the old.
            await begin('codex', 'synthetic-codex-1', {'model': 'synthetic-model-b', 'title': 'A later prompt'})
            claude = await begin('claude_code', 'synthetic-claude-1', {'working_directory': 'T:/synthetic/other',
                'title': 'Review the synthetic export'})
            # Claude's entry names the Agent's Codex session, with what it is about; never its own session.
            assert [(row['client'], row['session_id'], row['model'], row['working_directory'], row['title'])
                    for row in claude['elsewhere']] == [
                ('codex', 'synthetic-codex-1', 'synthetic-model-b', 'T:/synthetic/repo', 'Add the synthetic export')]
            assert claude['elsewhere'][0]['conversation_id'] == codex['conversation_id']
            # Another FLA of the project sees none of it.
            other = await begin('codex', 'synthetic-codex-2', agent='specialist')
            assert other['elsewhere'] == []
            listed = (await client.post('/v1/agent-conversations/query', json={**scope, 'source_application': 'codex',
                'mode': 'list'})).json()['conversations']
            rows = {row['id']: row for row in listed}
            traced = rows[codex['conversation_id']]
            assert traced['title'] == 'Add the synthetic export'
            assert [(s['client'], s['session_id'], s['model'], s['working_directory']) for s in traced['sessions']] == [
                ('codex', 'synthetic-codex-1', 'synthetic-model-b', 'T:/synthetic/repo')]
            assert traced['sessions'][0]['first_seen'] <= traced['sessions'][0]['last_seen']
            assert [s['client'] for s in rows[claude['conversation_id']]['sessions']] == ['claude_code']
            # A credential never becomes a title, and never refuses the entry.
            secret = await begin('codex', 'synthetic-codex-3', {'title': 'fix access_token=abc', 'model': 'synthetic-model-c'})
            listed = (await client.post('/v1/agent-conversations/query', json={**scope, 'source_application': 'codex',
                'mode': 'list'})).json()['conversations']
            assert [row.get('title') for row in listed if row['id'] == secret['conversation_id']] == [None]
            # Resuming the Codex conversation from Claude adds Claude's session to it; the conversation Claude
            # left still names Claude's session (history is kept), and Claude's next entry no longer lists itself.
            token = 'fuli-task-' + uuid4().hex
            await client.put('/v1/task-contexts', json=dict(personal_space_id=space, personal_project_id=project,
                project_agent_id='engineer', session_id='synthetic-claude-1', source_application='claude_code', token=token))
            resumed = await client.post('/v1/agent-conversations/resume', json={**scope, 'source_application': 'claude_code',
                'session_id': 'synthetic-claude-1', 'task_context_token': token, 'conversation_id': codex['conversation_id']})
            assert resumed.status_code == 200, resumed.text
            listed = (await client.post('/v1/agent-conversations/query', json={**scope, 'source_application': 'codex',
                'mode': 'list'})).json()['conversations']
            rows = {row['id']: row for row in listed}
            assert {s['client'] for s in rows[codex['conversation_id']]['sessions']} == {'codex', 'claude_code'}
            assert [s['client'] for s in rows[claude['conversation_id']]['sessions']] == ['claude_code']
            again = await begin('claude_code', 'synthetic-claude-1')
            assert [(row['client'], row['session_id']) for row in again['elsewhere']] == [
                ('codex', 'synthetic-codex-3'), ('codex', 'synthetic-codex-1')], 'one row per session, newest first'
    asyncio.run(scenario())


def test_one_conversation_written_by_claude_then_codex_names_each_events_client_and_session():
    """11-18 acceptance: Claude writes A in a FULI conversation, Codex resumes it
    and writes B; every event, and the checkpoint summary, can be traced to the
    client and native session that wrote it, with that session's model, folder and branch."""
    async def scenario():
        async with provider_client(fixture_settings()) as (client, _):
            space = (await client.post('/v1/spaces', json={'name': 'Synthetic handoff', 'kind': 'personal'})).json()['id']
            project = 'handoff-' + uuid4().hex[:10]
            await seed_agent(client, space, project=project, allowed_clients=['codex', 'claude_code'])
            scope = dict(personal_space_id=space, personal_project_id=project, agent_id='engineer')

            async def task(source, session):
                token = 'fuli-task-' + uuid4().hex
                r = await client.put('/v1/task-contexts', json=dict(personal_space_id=space, personal_project_id=project,
                    project_agent_id='engineer', session_id=session, source_application=source, token=token))
                assert r.status_code == 200, r.text
                return token

            async def post(path, body):
                r = await client.post(path, json={**scope, **body})
                assert r.status_code == 200, r.text
                return r.json()

            claude_token = await task('claude_code', 'synthetic-claude-a')
            opened = await post('/v1/agent-conversations/begin', {'source_application': 'claude_code',
                'session_id': 'synthetic-claude-a', 'task_context_token': claude_token,
                'provenance': {'working_directory': 'T:/synthetic/a', 'model': 'synthetic-claude-model',
                               'branch': 'JVS/synthetic-a', 'title': 'Write A'}})
            conversation = opened['conversation_id']
            await post('/v1/agent-conversations/append', {'source_application': 'claude_code',
                'session_id': 'synthetic-claude-a', 'task_context_token': claude_token,
                'events': [dict(event_id='a', role='assistant', content='SYNTHETIC_A')]})
            codex_token = await task('codex', 'synthetic-codex-b')
            await post('/v1/agent-conversations/begin', {'source_application': 'codex',
                'session_id': 'synthetic-codex-b', 'task_context_token': codex_token,
                'provenance': {'working_directory': 'T:/synthetic/b', 'model': 'synthetic-codex-model',
                               'branch': 'JVS/synthetic-b'}})
            await post('/v1/agent-conversations/resume', {'source_application': 'codex',
                'session_id': 'synthetic-codex-b', 'task_context_token': codex_token, 'conversation_id': conversation})
            await post('/v1/agent-conversations/append', {'source_application': 'codex',
                'session_id': 'synthetic-codex-b', 'task_context_token': codex_token, 'summary': 'Wrote B',
                'status': 'completed', 'events': [dict(event_id='b', role='assistant', content='SYNTHETIC_B'),
                    dict(event_id='b-summary', role='summary', kind='checkpoint', content='Wrote B')]})
            page = await post('/v1/agent-conversations/query', {'source_application': 'codex', 'mode': 'events',
                'conversation_id': conversation, 'limit': 10})
            by_content = {event['content']: (event['client'], event['session_id']) for event in page['events']}
            assert by_content == {'SYNTHETIC_A': ('claude_code', 'synthetic-claude-a'),
                                  'SYNTHETIC_B': ('codex', 'synthetic-codex-b'),
                                  'Wrote B': ('codex', 'synthetic-codex-b')}
            sources = {(s['client'], s['session_id']): s for s in page['sources']}
            claude = sources[('claude_code', 'synthetic-claude-a')]
            assert (claude['model'], claude['working_directory'], claude['branch']) == (
                'synthetic-claude-model', 'T:/synthetic/a', 'JVS/synthetic-a')
            # Codex joined this conversation by its resume and brings what its own entry reported.
            codex = sources[('codex', 'synthetic-codex-b')]
            assert (codex['model'], codex['working_directory'], codex['branch']) == (
                'synthetic-codex-model', 'T:/synthetic/b', 'JVS/synthetic-b')
            # One summary event read by its sequence still names its writer.
            summary = next(event for event in page['events'] if event['content'] == 'Wrote B')
            one = await post('/v1/agent-conversations/query', {'source_application': 'codex', 'mode': 'events',
                'conversation_id': conversation, 'after': summary['sequence'] - 1, 'limit': 1})
            assert (one['events'][0]['client'], one['events'][0]['session_id']) == ('codex', 'synthetic-codex-b')
            # The title's opening words name where they came from.
            listed = (await post('/v1/agent-conversations/query', {'source_application': 'codex', 'mode': 'list'}))[
                'conversations']
            row = next(row for row in listed if row['id'] == conversation)
            assert row['title'] == 'Write A'
            assert row['title_source'] == {'client': 'claude_code', 'session_id': 'synthetic-claude-a'}
    asyncio.run(scenario())


def test_each_digest_task_reads_back_the_checkpoint_event_that_wrote_it():
    """11-18 acceptance: Claude and Codex each write a checkpoint with the same
    words into one conversation; each digest task names its own event (sequence,
    event ID, client, native session), and the exact read of that sequence and
    event ID returns that checkpoint. A repeated write adds no task; a task
    with no recorded source reads as unknown; a source that names another
    event reads as unavailable, never as the next event."""
    async def scenario():
        settings = fixture_settings()
        async with provider_client(settings) as (client, _):
            space = (await client.post('/v1/spaces', json={'name': 'Synthetic digest source', 'kind': 'personal'})).json()['id']
            project = 'digest-' + uuid4().hex[:10]
            await seed_agent(client, space, project=project, allowed_clients=['codex', 'claude_code'])
            scope = dict(personal_space_id=space, personal_project_id=project, agent_id='engineer')

            async def post(path, body):
                r = await client.post(path, json={**scope, **body})
                assert r.status_code == 200, r.text
                return r.json()

            async def task(source, session):
                token = 'fuli-task-' + uuid4().hex
                r = await client.put('/v1/task-contexts', json=dict(personal_space_id=space, personal_project_id=project,
                    project_agent_id='engineer', session_id=session, source_application=source, token=token))
                assert r.status_code == 200, r.text
                return token

            async def checkpoint(source, session, token, event_id, words='Same words from either client'):
                return await post('/v1/agent-conversations/append', {'source_application': source, 'session_id': session,
                    'task_context_token': token, 'summary': words, 'status': 'completed',
                    'events': [dict(event_id=event_id, role='summary', kind='checkpoint', content=words)]})

            claude = await task('claude_code', 'synthetic-claude-d')
            opened = await post('/v1/agent-conversations/begin', {'source_application': 'claude_code',
                'session_id': 'synthetic-claude-d', 'task_context_token': claude})
            conversation = opened['conversation_id']
            await checkpoint('claude_code', 'synthetic-claude-d', claude, 'claude-task:summary')
            # The same event again (a retried write) adds no task.
            await checkpoint('claude_code', 'synthetic-claude-d', claude, 'claude-task:summary')
            codex = await task('codex', 'synthetic-codex-d')
            await post('/v1/agent-conversations/begin', {'source_application': 'codex', 'session_id': 'synthetic-codex-d',
                'task_context_token': codex})
            await post('/v1/agent-conversations/resume', {'source_application': 'codex', 'session_id': 'synthetic-codex-d',
                'task_context_token': codex, 'conversation_id': conversation})
            await checkpoint('codex', 'synthetic-codex-d', codex, 'codex-task:summary')

            async def digest_tasks():
                page = await post('/v1/agent-conversations/query', {'source_application': 'codex', 'mode': 'events',
                    'conversation_id': conversation, 'limit': 1})
                return page['digest']['tasks']

            tasks = await digest_tasks()
            assert [(t['source']['client'], t['source']['session_id'], t['source']['event_id']) for t in tasks] == [
                ('claude_code', 'synthetic-claude-d', 'claude-task:summary'),
                ('codex', 'synthetic-codex-d', 'codex-task:summary')]
            async def exact(sequence, event_id):
                return await post('/v1/agent-conversations/query', {'source_application': 'codex', 'mode': 'events',
                    'conversation_id': conversation, 'after': sequence - 1, 'limit': 1, 'event_id': event_id})

            for entry in tasks:
                read = await exact(entry['source']['sequence'], entry['source']['event_id'])
                assert read['source_check'] == 'verified'
                [event] = read['events']
                assert (event['sequence'], event['event_id'], event['kind'], event['content'], event['client'],
                        event['session_id']) == (entry['source']['sequence'], entry['source']['event_id'], 'checkpoint',
                        entry['summary'], entry['source']['client'], entry['source']['session_id'])
            # Another event ID at a source's sequence, or a sequence with no event: unavailable, nothing shown.
            wrong = await exact(tasks[0]['source']['sequence'], tasks[1]['source']['event_id'])
            assert (wrong['source_check'], wrong['events']) == ('unavailable', [])
            beyond = await exact(tasks[1]['source']['sequence'] + 50, tasks[1]['source']['event_id'])
            assert (beyond['source_check'], beyond['events']) == ('unavailable', [])
            listed = (await post('/v1/agent-conversations/query', {'source_application': 'codex', 'mode': 'list'}))['conversations']
            assert next(row for row in listed if row['id'] == conversation)['summary_source'] == tasks[-1]['source']

            # A digest stored before tasks kept their source: nothing proves which write a task was, so unknown.
            from neo4j import AsyncGraphDatabase
            driver = AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password))
            try:
                rows, _, _ = await driver.execute_query('MATCH (c:FuliConversation {id: $id}) RETURN c.digest AS digest',
                    id=conversation)
                stored = json.loads(rows[0]['digest'])
                older = [{key: value for key, value in t.items() if key != 'source'} for t in stored['tasks']]
                await driver.execute_query('MATCH (c:FuliConversation {id: $id}) SET c.digest = $digest', id=conversation,
                    digest=json.dumps({**stored, 'tasks': older}))
            finally:
                await driver.close()
            assert [t['source'] for t in await digest_tasks()] == [None, None]
            row = next(r for r in (await post('/v1/agent-conversations/query', {'source_application': 'codex',
                'mode': 'list'}))['conversations'] if r['id'] == conversation)
            assert row['summary_source'] is None
    asyncio.run(scenario())


AUTO_CLOSE = 'Auto-closed by the Stop hook: the Agent recorded no checkpoint for this task.'


def test_a_progress_list_pages_by_position_and_keeps_real_progress_past_automatic_closes():
    """11-19 (Jefa's list_project_conversations): a keyset list reaches every
    conversation, and a real result stays the progress after 13 automatic closes."""
    async def scenario():
        async with provider_client(fixture_settings()) as (client, _):
            space = (await client.post('/v1/spaces', json={'name': 'Synthetic progress', 'kind': 'personal'})).json()['id']
            project = 'progress-' + uuid4().hex[:10]
            await seed_agent(client, space, project=project, allowed_clients=['codex', 'claude_code'])
            scope = dict(personal_space_id=space, personal_project_id=project, agent_id='engineer')

            async def post(path, body):
                r = await client.post(path, json={**scope, **body})
                assert r.status_code == 200, r.text
                return r.json()

            async def checkpoint(session, token, event_id, summary):
                await post('/v1/agent-conversations/append', {'source_application': 'codex', 'session_id': session,
                    'task_context_token': token, 'summary': summary, 'status': 'reported',
                    'events': [dict(event_id=event_id, role='summary', kind='checkpoint', content=summary)]})

            for n in range(22):
                session = f'synthetic-session-{n:02d}'
                token = 'fuli-task-' + uuid4().hex
                r = await client.put('/v1/task-contexts', json=dict(personal_space_id=space, personal_project_id=project,
                    project_agent_id='engineer', session_id=session, source_application='codex', token=token))
                assert r.status_code == 200, r.text
                await post('/v1/agent-conversations/begin', {'source_application': 'codex', 'session_id': session,
                    'task_context_token': token})
                if n == 0:
                    await checkpoint(session, token, 'task-0:summary', 'Result 0')
                    for close in range(13):
                        await checkpoint(session, token, f'auto-{close}:summary', AUTO_CLOSE)

            async def page(position=None, limit=20, **extra):
                after = {'after_activity': position[0], 'after_id': position[1]} if position else {}
                return (await post('/v1/agent-conversations/query', {'mode': 'list', 'limit': limit, **after,
                    **extra}))['conversations']

            first = await page(with_progress=True)
            second = await page((first[-1]['last_activity'], first[-1]['id']), with_progress=True)
            ids = [row['id'] for row in first + second]
            assert len(ids) == 22 and len(set(ids)) == 22, 'two pages, no repeat and no gap'
            reported = [row for row in first + second if row['progress']]
            assert len(reported) == 1
            assert reported[0]['progress']['summary'] == 'Result 0', 'the real result outlives 13 automatic closes'
            assert reported[0]['progress']['at'] < reported[0]['last_activity']
            assert all('progress' not in row for row in await page(limit=3)), 'only when asked'
    asyncio.run(scenario())


def test_a_task_activity_receipt_links_only_through_a_session_bound_to_one_conversation():
    """11-19: a member's receipt on the session of the lead's conversation is that
    conversation's progress, named with its reporter, task and event; a receipt
    from another client, without a session or in another project is not, and
    nothing is linked once the session works on a second conversation there."""
    async def scenario():
        async with provider_client(fixture_settings()) as (client, _):
            space = (await client.post('/v1/spaces', json={'name': 'Synthetic receipts', 'kind': 'personal'})).json()['id']
            project, other = 'receipts-' + uuid4().hex[:10], 'receipts-other-' + uuid4().hex[:10]
            for name in (project, other):
                for agent in ('engineer', 'member'):
                    await seed_agent(client, space, project=name, agent=agent, allowed_clients=['codex', 'claude_code'])
            session = 'synthetic-shared-session'

            async def begin(agent, source='codex'):
                token = 'fuli-task-' + uuid4().hex
                r = await client.put('/v1/task-contexts', json=dict(personal_space_id=space, personal_project_id=project,
                    project_agent_id=agent, session_id=session, source_application=source, token=token))
                assert r.status_code == 200, r.text
                r = await client.post('/v1/agent-conversations/begin', json=dict(personal_space_id=space,
                    personal_project_id=project, agent_id=agent, source_application=source, session_id=session,
                    task_context_token=token))
                assert r.status_code == 200, r.text
                return r.json()['conversation_id']

            async def task(name):
                r = await client.post('/v1/project-agent-tasks', json={'personal_space_id': space,
                    'personal_project_id': name, 'idempotency_key': 'synthetic-receipt-task-' + name,
                    'title': 'Synthetic receipt task', 'objective': 'Verify receipt links.', 'work_kind': 'implementation',
                    'lead_agent_id': 'engineer', 'collaborator_agent_ids': ['member'], 'source_application': 'codex',
                    'routing_reason': 'Synthetic routing.'})
                assert r.status_code == 200, r.text
                return {**r.json()['task'], 'project': name}

            async def receipt(found, key, summary, **source):
                r = await client.post(f'/v1/project-agent-tasks/{found["task_id"]}/events', json={
                    'personal_space_id': space, 'personal_project_id': found['project'],
                    'task_id': found['task_id'], 'agent_id': 'member', 'status': found['status'],
                    'idempotency_key': f'synthetic-receipt-{key}', 'summary': summary, **source})
                assert r.status_code == 200, r.text

            held = await begin('engineer')
            here, there = await task(project), await task(other)
            await receipt(here, 'linked', 'Ran the release checks', source_application='codex', source_session_id=session)
            await receipt(here, 'other-client', 'Another client', source_application='claude_code', source_session_id=session)
            await receipt(here, 'no-session', 'No native session', source_application='codex')
            await receipt(there, 'other-project', 'Another project', source_application='codex', source_session_id=session)

            async def listed():
                r = await client.post('/v1/agent-conversations/query', json=dict(personal_space_id=space,
                    personal_project_id=project, agent_id='engineer', mode='list', with_progress=True))
                assert r.status_code == 200, r.text
                return next(row for row in r.json()['conversations'] if row['id'] == held)

            activity = (await listed())['task_activity']
            assert activity['summary'] == 'Ran the release checks'
            assert activity['source']['agent_id'] == 'member' and activity['source']['client'] == 'codex'
            assert activity['source']['task_id'] == here['task_id'] and activity['source']['event_id']
            # The same native session now also works on the member's own conversation here: ambiguous.
            await begin('member')
            assert (await listed())['task_activity'] is None
    asyncio.run(scenario())
