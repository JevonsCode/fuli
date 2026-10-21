"""rec#5 C6 "本会话记了什么" against an explicitly disposable Neo4j: every write
carries its session, conversation, client, project and time; one session's
record list holds its saved turns, knowledge and preference evidence and
nothing of another session; paused turns hold nothing. Synthetic data only;
public HTTP routes drive every write."""

from uuid import uuid4

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent

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

    async def say(self, words):
        return await self.append(
            {'event_id': f'{self.token}:user', 'role': 'user', 'content': words},
            {'event_id': f'{self.token}:assistant', 'role': 'assistant', 'content': f'Synthetic answer to: {words}'})

    async def commit(self, entities, *, project=None):
        return ok(await self.client.post('/v1/knowledge/commits', json={
            'space_id': self.space_id, 'personal_project_id': project or self.project,
            'episode': {'idempotency_key': f'{self.token}:knowledge:current_project', 'session_id': self.session_id,
                        'name': 'Synthetic turn capture', 'source_kind': 'task_remember',
                        'source_description': 'Synthetic items a turn kept.', 'source_application': 'codex',
                        'source_excerpt': entities[0]['summary'], 'reference_time': '2026-10-20T06:00:00Z',
                        'entities': entities}}))

    async def checkpoint(self, saved=None, *, reason='Synthetic turn.'):
        body = {'personal_space_id': self.space_id, 'source_application': 'codex', 'phase': 'complete',
                'disposition': 'capture_candidates' if saved else 'retain_nothing', 'reason': reason,
                'fingerprint': 'b' * 64}
        if saved:
            body |= {'capture_status': 'committed', 'capture_results': [{
                'scope': 'current_project', 'personal_project_id': self.project, 'status': 'committed',
                'episode_id': saved['episode_id'], 'entity_ids': saved['entity_ids'], 'relationship_ids': []}]}
        elif reason == OFF:
            body['capture_status'] = 'capture_disabled'
        return ok(await self.client.put(f'/v1/task-contexts/{self.token}/checkpoint', json=body))

    async def records(self, client=None):
        return await (client or self.client).post('/v1/session-records', json={
            'personal_space_id': self.space_id, 'source_application': 'codex', 'session_id': self.session_id})


def fact(key, text):
    return {'key': key, 'name': text, 'type': 'ProjectFact', 'summary': text, 'origin_quadrant': 'known_known'}


def preference(key, text):
    return {'key': key, 'name': text, 'type': 'PersonalPreference', 'summary': text,
            'profile_aspect': 'judgment_preference', 'origin_quadrant': 'known_known', 'content_source': 'user_explicit'}


@pytest.mark.asyncio
async def test_a_session_list_holds_its_turns_knowledge_and_preference_evidence_with_their_source():
    async with provider_client(fixture_settings()) as (client, _):
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
    async with provider_client(fixture_settings()) as (client, _):
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
    async with provider_client(fixture_settings()) as (client, _):
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
        async with provider_client(fixture_settings(), stranger['access_token']) as (other, _):
            assert (await session.records(other)).status_code in {403, 404}


@pytest.mark.asyncio
async def test_a_link_naming_only_the_session_finds_its_one_client_and_never_guesses_between_two():
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await new_space(client)
        session = Session(client, space_id, f'native-{uuid4()}')
        await session.begin()
        await session.say('Synthetic words')
        await session.checkpoint()
        found = ok(await client.post('/v1/session-records', json={
            'personal_space_id': space_id, 'session_id': session.session_id}))
        assert (found['source_application'], found['clients'], len(found['turns'])) == ('codex', [], 1)
        ok(await client.put('/v1/task-contexts', json={
            'personal_space_id': space_id, 'personal_project_id': 'thesis', 'session_id': session.session_id,
            'source_application': 'claude_code', 'token': f'fuli-task-{uuid4()}', 'turn_id': 'other-client-turn'}))
        shared = ok(await client.post('/v1/session-records', json={
            'personal_space_id': space_id, 'session_id': session.session_id}))
        assert (shared['source_application'], shared['clients'], shared['turns']) == (None, ['claude_code', 'codex'], [])
        unknown = ok(await client.post('/v1/session-records', json={
            'personal_space_id': space_id, 'session_id': 'no-such-session'}))
        assert (unknown['source_application'], unknown['clients'], unknown['turns']) == (None, [], [])
