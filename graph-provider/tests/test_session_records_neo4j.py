"""rec#5 C6 "本会话记了什么" against an explicitly disposable Neo4j: every write
carries its session, conversation, client, project and time; one session's
record list holds its saved turns, knowledge and preference evidence and
nothing of another session; paused turns hold nothing. Synthetic data only;
public HTTP routes drive every write."""

from uuid import uuid4

import pytest

from fuli_graph import session_records

from test_project_agent_memory_neo4j import provider_client, seed_agent
from test_turn_receipt_neo4j import REVIEW, reviewed_settings

OFF = 'Capture was off for this task (session: session_paused); FULI kept no summary.'


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


async def new_space(client):
    space_id = ok(await client.post('/v1/spaces', json={'name': f'Synthetic records {uuid4()}', 'kind': 'personal'}))['id']
    await seed_agent(client, space_id, 'thesis', 'writer')
    await seed_agent(client, space_id, 'ledger', 'keeper')
    return space_id


class Session:
    """One synthetic host session: each turn begins a task, saves its visible
    words to the Agent journal and checkpoints."""

    def __init__(self, client, space_id, session_id):
        self.client, self.space_id, self.session_id, self.turns = client, space_id, session_id, 0

    async def begin(self, project='thesis', agent='writer'):
        self.turns += 1
        self.token = f'fuli-task-{uuid4()}'
        self.project, self.agent = project, agent
        task = ok(await self.client.put('/v1/task-contexts', json={
            'personal_space_id': self.space_id, 'personal_project_id': project, 'project_agent_id': agent,
            'session_id': self.session_id, 'source_application': 'codex', 'token': self.token,
            'turn_id': f'{self.session_id}-turn-{self.turns}'}))
        return task

    async def append(self, *events):
        return ok(await self.client.post('/v1/agent-conversations/append', json={
            'personal_space_id': self.space_id, 'personal_project_id': self.project, 'agent_id': self.agent,
            'source_application': 'codex', 'session_id': self.session_id, 'task_context_token': self.token,
            'events': list(events)}))

    async def resume(self, conversation_id):
        return ok(await self.client.post('/v1/agent-conversations/resume', json={
            'personal_space_id': self.space_id, 'personal_project_id': self.project, 'agent_id': self.agent,
            'source_application': 'codex', 'session_id': self.session_id, 'task_context_token': self.token,
            'conversation_id': conversation_id}))

    async def say(self, words):
        return await self.append(
            {'event_id': f'{self.token}:user', 'role': 'user', 'content': words},
            {'event_id': f'{self.token}:assistant', 'role': 'assistant', 'content': f'Synthetic answer to: {words}'})

    async def commit(self, entities, *, project=None, personal_global=False):
        return ok(await self.client.post('/v1/knowledge/commits', json={
            'space_id': self.space_id, 'personal_project_id': None if personal_global else project or self.project,
            'episode': {'idempotency_key': f'{self.token}:knowledge:current_project', 'session_id': self.session_id,
                        'name': 'Synthetic turn capture', 'source_kind': 'task_remember',
                        'source_description': 'Synthetic items a turn kept.', 'source_application': 'codex',
                        'source_excerpt': entities[0]['summary'], 'reference_time': '2026-10-20T06:00:00Z',
                        'entities': entities}}))

    async def checkpoint(self, saved=None, *, reason='Synthetic turn.', personal_global=False):
        body = {'personal_space_id': self.space_id, 'source_application': 'codex', 'phase': 'complete',
                'disposition': 'capture_candidates' if saved else 'retain_nothing', 'reason': reason,
                'fingerprint': 'b' * 64}
        if saved:
            body |= {'capture_status': 'committed', 'capture_results': [{
                'scope': 'personal_global' if personal_global else 'current_project',
                'personal_project_id': None if personal_global else self.project, 'status': 'committed',
                'episode_id': saved['episode_id'], 'entity_ids': saved['entity_ids'], 'relationship_ids': []}]}
        elif reason == OFF:
            body['capture_status'] = 'capture_disabled'
        return ok(await self.client.put(f'/v1/task-contexts/{self.token}/checkpoint', json=body))

    async def records(self, client=None):
        return await (client or self.client).post('/v1/session-records', headers=REVIEW, json={
            'personal_space_id': self.space_id, 'source_application': 'codex', 'session_id': self.session_id})


def fact(key, text):
    return {'key': key, 'name': text, 'type': 'ProjectFact', 'summary': text, 'origin_quadrant': 'known_known'}


def preference(key, text):
    return {'key': key, 'name': text, 'type': 'PersonalPreference', 'summary': text,
            'profile_aspect': 'judgment_preference', 'origin_quadrant': 'known_known', 'content_source': 'user_explicit'}


@pytest.mark.asyncio
async def test_a_session_list_holds_its_turns_knowledge_and_preference_evidence_with_their_source():
    async with provider_client(reviewed_settings()) as (client, _):
        space_id = await new_space(client)
        session = Session(client, space_id, f'native-{uuid4()}')
        saved = {}
        for turn in range(1, 7):
            await session.begin()
            await session.say(f'Synthetic request {turn}')
            if turn == 2:
                saved['facts'] = await session.commit([fact('gate', 'Deploys use the staging gate'),
                                                       fact('port', 'The service listens on 9090')])
            if turn == 3:
                saved['preference'] = await session.commit([preference('cite', '论文引用格式用 GB/T 7714')])
            await session.checkpoint(saved.get('facts') if turn == 2 else saved.get('preference') if turn == 3 else None)
        other = Session(client, space_id, f'native-{uuid4()}')
        await other.begin()
        await other.say('Another session words')
        await other.checkpoint(await other.commit([fact('other', 'Another session fact')]))

        records = ok(await session.records())
        assert [len(turn['messages']) for turn in records['turns']] == [2] * 6
        conversation = records['turns'][0]['conversation_id']
        assert conversation and {turn['conversation_id'] for turn in records['turns']} == {conversation}
        assert all(message['created_at'] for turn in records['turns'] for message in turn['messages'])
        assert records['turns'][0]['messages'][0]['text'] == 'Synthetic request 1'
        items = {item['content']: item for item in records['items']}
        assert set(items) == {'Deploys use the staging gate', 'The service listens on 9090', '论文引用格式用 GB/T 7714'}
        turns = {turn['task_id']: index + 1 for index, turn in enumerate(records['turns'])}
        for content, turn in [('Deploys use the staging gate', 2), ('论文引用格式用 GB/T 7714', 3)]:
            item = items[content]
            assert turns[item['task_id']] == turn, 'each record names the turn that wrote it'
            assert (item['change'], item['origin_project_id'], item['conversation_id']) == ('created', 'thesis', conversation)
            assert item['recorded_at'] and item['confirmation_status'] == 'pending'
        assert items['论文引用格式用 GB/T 7714']['excerpt'] == '论文引用格式用 GB/T 7714'
        assert [project['id'] for project in records['projects']] == ['thesis']
        assert 'Another session' not in str(records), 'only this session'
        # G1-4 the other way: the item names its session, conversation, client, project and time.
        view = ok(await client.post('/v1/knowledge/item-views', json={
            'personal_space_id': space_id, 'item_kind': 'entity',
            'item_id': saved['preference']['entity_ids'][0]}))
        source = view['evidence'][0]
        assert (source['session_id'], source['conversation_id'], source['source_application'],
                source['personal_project_id']) == (session.session_id, conversation, 'codex', 'thesis')
        assert source['created_at']


@pytest.mark.asyncio
async def test_paused_turns_record_nothing_and_say_why_without_their_words():
    async with provider_client(reviewed_settings()) as (client, _):
        space_id = await new_space(client)
        session = Session(client, space_id, f'native-{uuid4()}')
        for turn in range(1, 15):
            await session.begin()
            if 6 <= turn <= 13:
                await session.append({'event_id': f'jsonl-v1:{turn}0:{turn}9:not_recorded', 'role': 'tool',
                    'kind': 'tool_result', 'content': f'[Not recorded: automatic recording was off (session_paused); '
                    f'native bytes {turn}0 to {turn}9 remain in native history.]'})
                await session.checkpoint(reason=OFF)
            else:
                await session.say(f'Synthetic request {turn}')
                await session.checkpoint()
        records = ok(await session.records())
        paused = records['turns'][5:13]
        assert all(turn['capture_off'] == {'layer': 'session', 'reason': 'session_paused'} for turn in paused)
        assert all(turn['messages'] == [] and len(turn['not_recorded']) == 1 for turn in paused)
        assert all(turn['not_recorded'][0]['created_at'] and turn['not_recorded'][0]['after'] for turn in paused)
        assert records['items'] == []
        assert [turn['capture_off'] for turn in records['turns'][:5] + records['turns'][13:]] == [None] * 6


@pytest.mark.asyncio
async def test_records_name_the_project_of_the_turn_that_wrote_them_and_follow_the_readers_permission():
    async with provider_client(reviewed_settings()) as (client, _):
        space_id = await new_space(client)
        session = Session(client, space_id, f'native-{uuid4()}')
        await session.begin('ledger', 'keeper')
        await session.say('Synthetic private ledger words')
        await session.checkpoint(await session.commit([fact('balance', 'Synthetic private balance')]))
        await session.begin('thesis', 'writer')
        await session.say('Synthetic thesis words')
        await session.checkpoint(await session.commit([fact('outline', 'Synthetic thesis outline')]))
        records = ok(await session.records())
        assert [turn['personal_project_id'] for turn in records['turns']] == ['ledger', 'thesis']
        assert {item['content']: item['origin_project_id'] for item in records['items']} == {
            'Synthetic private balance': 'ledger', 'Synthetic thesis outline': 'thesis'}
        assert len({turn['conversation_id'] for turn in records['turns']}) == 2, 'one journal per Agent'
        stranger = ok(await client.post('/v1/principals', json={'name': 'Synthetic stranger'}))
        async with provider_client(reviewed_settings(), stranger['access_token']) as (other, _):
            assert (await session.records(other)).status_code in {403, 404}


@pytest.mark.asyncio
async def test_a_link_naming_only_the_session_finds_its_one_client_and_never_guesses_between_two():
    async with provider_client(reviewed_settings()) as (client, _):
        space_id = await new_space(client)
        session = Session(client, space_id, f'native-{uuid4()}')
        await session.begin()
        await session.say('Synthetic words')
        await session.checkpoint()
        found = ok(await client.post('/v1/session-records', headers=REVIEW, json={
            'personal_space_id': space_id, 'session_id': session.session_id}))
        assert (found['source_application'], found['clients'], len(found['turns'])) == ('codex', [], 1)
        ok(await client.put('/v1/task-contexts', json={
            'personal_space_id': space_id, 'personal_project_id': 'thesis', 'session_id': session.session_id,
            'source_application': 'claude_code', 'token': f'fuli-task-{uuid4()}', 'turn_id': 'other-client-turn'}))
        shared = ok(await client.post('/v1/session-records', headers=REVIEW, json={
            'personal_space_id': space_id, 'session_id': session.session_id}))
        assert (shared['source_application'], shared['clients'], shared['turns']) == (None, ['claude_code', 'codex'], [])
        unknown = ok(await client.post('/v1/session-records', headers=REVIEW, json={
            'personal_space_id': space_id, 'session_id': 'no-such-session'}))
        assert (unknown['source_application'], unknown['clients'], unknown['turns']) == (None, [], [])


# dot #263 P2-2: an item listed once keeps every episode that wrote or cited it.
@pytest.mark.asyncio
async def test_an_item_cited_in_two_turns_keeps_both_sources_with_their_own_turn_and_project():
    async with provider_client(reviewed_settings()) as (client, _):
        space_id = await new_space(client)
        session = Session(client, space_id, f'native-{uuid4()}')
        cite = preference('cite', '论文引用格式用 GB/T 7714')
        await session.begin('ledger', 'keeper')
        first = await session.commit([cite], personal_global=True)
        await session.checkpoint(first, personal_global=True)
        await session.begin('thesis', 'writer')
        second = await session.commit([cite], personal_global=True)
        await session.checkpoint(second, personal_global=True)
        records = ok(await session.records())
        turns = [turn['task_id'] for turn in records['turns']]
        [item] = records['items']
        assert [(source['episode_id'], source['task_id'], source['origin_project_id'], source['change'])
                for source in item['sources']] == [
            (first['episode_id'], turns[0], 'ledger', 'created'), (second['episode_id'], turns[1], 'thesis', 'evidence')]
        assert (item['episode_id'], item['origin_project_id']) == (first['episode_id'], 'ledger')


# dot #263 P2-3: every conversation the session wrote to, each turn in its own.
@pytest.mark.asyncio
async def test_two_resumes_keep_every_conversation_and_each_turn_names_its_own():
    async with provider_client(reviewed_settings()) as (client, _):
        space_id = await new_space(client)
        session = Session(client, space_id, f'native-{uuid4()}')
        others = [Session(client, space_id, f'native-{uuid4()}') for _ in range(2)]
        await session.begin()
        conversations = [(await session.say('S in its own conversation'))['conversation_id']]
        for other in others:
            await other.begin()
            conversations.append((await other.say('Words of another session'))['conversation_id'])
            await other.checkpoint()
        await session.checkpoint()
        for index, conversation_id in enumerate(conversations[1:], start=2):
            await session.begin()
            await session.resume(conversation_id)
            assert (await session.say(f'S after resume {index}'))['conversation_id'] == conversation_id
            await session.checkpoint()
        records = ok(await session.records())
        assert [turn['conversation_id'] for turn in records['turns']] == conversations
        assert [turn['messages'][0]['text'] for turn in records['turns']] == [
            'S in its own conversation', 'S after resume 2', 'S after resume 3']
        assert 'Words of another session' not in str(records)


# dot #263 P2-4: the event bound counts this session's events only, and says when it cut.
@pytest.mark.asyncio
async def test_the_event_bound_never_drops_a_session_for_another_sessions_events_and_reports_its_own(monkeypatch):
    monkeypatch.setattr(session_records, 'MAX_EVENTS', 4)
    async with provider_client(reviewed_settings()) as (client, _):
        space_id = await new_space(client)
        session = Session(client, space_id, f'native-{uuid4()}')
        await session.begin()
        conversation_id = (await session.say('S words before the flood'))['conversation_id']
        await session.checkpoint()
        other = Session(client, space_id, f'native-{uuid4()}')
        for turn in range(4):
            await other.begin()
            if turn == 0:
                await other.resume(conversation_id)
            await other.say(f'Another session turn {turn}')
            await other.checkpoint()
        records = ok(await session.records())
        assert [len(turn['messages']) for turn in records['turns']] == [2]
        assert records['truncated'] is False
        for turn in range(2):
            await session.begin()
            await session.say(f'S later turn {turn}')
            await session.checkpoint()
        records = ok(await session.records())
        assert records['truncated'] is True, 'six of its own events past a bound of four'
        assert [len(turn['messages']) for turn in records['turns']] == [0, 2, 2], 'the newest are kept'


# dot #263 P2-2 (re-review): no source of any episode read is dropped before the
# reader's projection. The cap of 2 is the per-item cap 47fe921 had; there is none now.
@pytest.mark.asyncio
async def test_every_source_of_an_item_survives_so_a_later_project_and_the_last_citation_are_found(monkeypatch):
    monkeypatch.setattr(session_records, 'MAX_SOURCES', 2, raising=False)
    async with provider_client(reviewed_settings()) as (client, _):
        space_id = await new_space(client)
        session = Session(client, space_id, f'native-{uuid4()}')
        cite = preference('cite', '论文引用格式用 GB/T 7714')
        saved = []
        for project, agent in [('ledger', 'keeper'), ('ledger', 'keeper'), ('thesis', 'writer'), ('thesis', 'writer')]:
            await session.begin(project, agent)
            saved.append(await session.commit([cite], personal_global=True))
            await session.checkpoint(saved[-1], personal_global=True)
        records = ok(await session.records())
        turns = [turn['task_id'] for turn in records['turns']]
        [item] = records['items']
        assert [(source['episode_id'], source['task_id'], source['origin_project_id']) for source in item['sources']] == [
            (episode['episode_id'], turn, project)
            for episode, turn, project in zip(saved, turns, ['ledger', 'ledger', 'thesis', 'thesis'])]
        assert records['truncated'] is False
