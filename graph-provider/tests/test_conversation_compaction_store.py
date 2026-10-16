"""Store-level compaction and recovery against an in-memory driver; synthetic data only."""
import json
from types import SimpleNamespace

import pytest

from fuli_graph.agent_conversation_models import ConversationEvent, ConversationPolicy, ConversationQuery
from fuli_graph.store_agent_conversations import StoreAgentConversations, encode_event


class JournalDriver:
    """Answers only the journal queries used by compaction and reads."""

    def __init__(self):
        self.conversation = {'id': 'synthetic-conversation', 'scope': 'synthetic-scope', 'revision': 0,
                             'summary': '', 'status': 'reported', 'last_activity': '2026-10-12T00:00:00+00:00'}
        self.events = []

    def append(self, role, content, kind='message'):
        self.conversation['revision'] += 1
        _, payload = encode_event(ConversationEvent(event_id=f'e{self.conversation["revision"]}', role=role, content=content, kind=kind))
        self.events.append({'payload': payload, 'sequence': self.conversation['revision']})
        self.conversation['unfolded_bytes'] = self.conversation.get('unfolded_bytes', 0) + len(content.encode())

    async def execute_query(self, query, **params):
        if query.endswith('RETURN c'):
            return [{'c': dict(self.conversation)}], None, None
        if 'HAS_EVENT' in query:
            rows = [event for event in self.events if params['after'] < event['sequence']
                    <= params.get('revision', self.conversation['revision'])
                    and event['sequence'] < params.get('before', self.conversation['revision'] + 1)]
            if 'DESC' in query:
                rows = list(reversed(rows))
            return rows[:params.get('limit', len(rows))], None, None
        if query.startswith('MATCH (c:FuliConversation {id: $id}) SET c.digest'):
            self.conversation.update(digest=params['digest'], compacted_through=params['through'],
                                     unfolded_bytes=params['kept'])
            return [], None, None
        raise AssertionError(f'unexpected query {query}')


class Store(StoreAgentConversations):
    def __init__(self):
        self.runtime = SimpleNamespace(driver=JournalDriver())

    async def _conversation_scope(self, actor, request, *, write=False):
        return 'synthetic-scope'

    async def _conversation_policy(self, scope):
        return ConversationPolicy(compact_after_kb=8, context_budget=2000)


def query(mode, **changes):
    return ConversationQuery(personal_space_id='synthetic-space', personal_project_id='synthetic-project',
                             agent_id='engineer', conversation_id='synthetic-conversation', mode=mode, **changes)


@pytest.mark.asyncio
async def test_repeated_compaction_recovers_decisions_methods_and_corrections_with_raw_sources():
    store = Store()
    driver = store.runtime.driver
    policy = await store._conversation_policy(None)
    driver.append('user', 'Synthetic billing export\nDecision: export CSV with UTF-8 BOM.\n' + 'detail ' * 200)
    driver.append('assistant', 'Plan\nMethod: stream rows in 500-row pages.\n' + 'log ' * 300)
    for index in range(12):
        driver.append('user' if index % 2 == 0 else 'assistant', f'filler {index}\n' + 'noise ' * 300)
        await store._compact_conversation('synthetic-conversation', policy)
    driver.append('user', 'Update\nCorrection: use semicolons instead of commas.\nTODO: confirm the Excel import.')
    for index in range(6):
        driver.append('assistant', f'more {index}\n' + 'noise ' * 300)
        await store._compact_conversation('synthetic-conversation', policy)
    assert driver.conversation['compacted_through'] > 15

    context = (await store.query_conversations(None, query('context')))['context']
    assert context['summary'] == ''
    assert context['messages'][-1]['content'].startswith('more 5')
    assert context['messages'][-1]['sequence'] == driver.conversation['revision']
    assert context['truncated'] is True
    assert len(json.dumps(context, ensure_ascii=False, separators=(',', ':')).encode()) <= 2000

    page = await store.query_conversations(None, query('events', limit=50))
    digest = page['digest']
    assert 'Correction: use semicolons instead of commas.' in {entry['text'] for entry in digest['entries']}
    assert digest['omitted'] > 0
    by_text = {entry['text']: entry for entry in digest['entries']}
    source = by_text['Decision: export CSV with UTF-8 BOM.']['sources'][0]
    original = next(event for event in page['events'] if event['sequence'] == source['sequence'])
    # The older decision stays recoverable verbatim even after the later correction.
    assert original['role'] == source['role'] and 'Decision: export CSV with UTF-8 BOM.' in original['content']
    later = await store.query_conversations(None, query('events', after=10))
    assert 'digest' not in later


@pytest.mark.asyncio
async def test_latest_completed_checkpoint_survives_todo_heavy_digest_within_budget():
    store = Store()
    driver = store.runtime.driver
    # Old open-work excerpts and many older task results crowd the bounded digest.
    digest = {'tasks': [{'at': f'2026-10-{day:02d}T00:00:00+00:00', 'status': 'incomplete',
                         'summary': f'Older synthetic step {day} ' * 8} for day in range(1, 12)],
              'entries': [{'kind': 'open', 'text': f'TODO: synthetic stale item {index} ' + 'x' * 120,
                           'sources': [{'role': 'user', 'sequence': index}]} for index in range(1, 40)]}
    latest = ('Completed: synthetic export "v2" at C:\\\\out\\\\导出.csv; 剩余: none. '
              'Artifacts: report.md; validation: pytest -k export passed.')
    digest['tasks'].append({'at': '2026-10-12T00:00:00+00:00', 'status': 'completed', 'summary': latest})
    driver.conversation.update(digest=json.dumps(digest, ensure_ascii=False), summary=latest, status='completed')
    driver.append('user', 'Recent synthetic "quoted" \\ message')

    context = (await store.query_conversations(None, query('context')))['context']
    assert context['latest_checkpoint'] == {'status': 'completed', 'summary': latest, 'truncated': False}
    assert context['summary_role'] == 'historical'
    assert context['summary'] == ''
    assert context['messages'][0]['content'] == 'Recent synthetic "quoted" \\ message'
    assert len(json.dumps(context, ensure_ascii=False, separators=(',', ':')).encode()) <= 2000
    # Raw history and the stored digest remain readable in full.
    page = await store.query_conversations(None, query('events'))
    assert len(page['digest']['entries']) == 39


@pytest.mark.asyncio
async def test_interrupted_checkpoint_stays_incomplete_and_absent_checkpoint_is_null():
    store = Store()
    driver = store.runtime.driver
    driver.append('user', 'Hello')
    context = (await store.query_conversations(None, query('context')))['context']
    assert context['latest_checkpoint'] is None
    driver.conversation.update(summary='Interrupted after step 2; step 3 remains.', status='incomplete')
    context = (await store.query_conversations(None, query('context')))['context']
    assert context['latest_checkpoint']['status'] == 'incomplete'


@pytest.mark.asyncio
async def test_history_page_reports_absent_digest_and_legacy_summary_recovery():
    store = Store()
    store.runtime.driver.conversation['summary'] = 'Legacy synthetic summary'
    store.runtime.driver.append('user', 'Hello')
    page = await store.query_conversations(None, query('events'))
    assert page['digest'] is None
    context = await store.query_conversations(None, query('context'))
    assert context['context']['summary'] == ''
    assert context['context']['latest_checkpoint']['summary'] == 'Legacy synthetic summary'
    store.runtime.driver.conversation['digest'] = json.dumps({'tasks': [], 'notes': ['旧请求']}, ensure_ascii=False)
    context = await store.query_conversations(None, query('context'))
    assert context['context']['summary'] == ''
    assert (await store.query_conversations(None, query('events')))['digest']['notes'] == ['旧请求']


@pytest.mark.asyncio
async def test_context_pages_past_tool_events_and_compacted_range_to_three_user_turns():
    store = Store()
    driver = store.runtime.driver
    for turn in range(4):
        driver.append('user', f'user {turn}')
        driver.append('assistant', f'assistant {turn}')
        driver.append('user', 'User-shaped tool payload', kind='tool_result')
        driver.append('assistant', 'Assistant-shaped checkpoint', kind='checkpoint')
        for index in range(30):
            driver.append('tool', f'tool {turn}-{index}', kind='tool_result')
        driver.append('summary', f'checkpoint {turn}', kind='checkpoint')
    driver.conversation['compacted_through'] = driver.conversation['revision'] - 1
    context = (await store.query_conversations(None, query('context')))['context']
    assert [event['content'] for event in context['messages']] == [
        'user 1', 'assistant 1', 'user 2', 'assistant 2', 'user 3', 'assistant 3']
    assert context['truncated'] is True and context['scan_truncated'] is False
    assert context['revision'] == driver.conversation['revision']
    assert context['omitted_sequence'] == context['messages'][0]['sequence'] - 1
    for message in context['messages']:
        page = await store.query_conversations(None, query('events', after=message['sequence'] - 1, limit=1))
        assert page['events'][0]['content'] == message['content']


@pytest.mark.asyncio
async def test_context_revision_snapshot_excludes_append_between_pages():
    store = Store()
    driver = store.runtime.driver
    driver.append('user', 'original user')
    for index in range(65):
        driver.append('tool', str(index), kind='tool_result')
    snapshot = driver.conversation['revision']
    execute = driver.execute_query
    mutated = False
    async def append_during_read(statement, **params):
        nonlocal mutated
        if 'HAS_EVENT' in statement and not mutated:
            mutated = True
            driver.append('user', 'concurrent later user')
            driver.conversation.update(summary='Concurrent checkpoint', status='completed')
        return await execute(statement, **params)
    driver.execute_query = append_during_read
    context = (await store.query_conversations(None, query('context')))['context']
    assert context['revision'] == snapshot
    assert [message['content'] for message in context['messages']] == ['original user']
    assert context['truncated'] is False
    assert context['latest_checkpoint'] is None
    full = await store.query_conversations(None, query('events', after=context['revision'], limit=1))
    assert full['summary'] == 'Concurrent checkpoint' and full['revision'] > context['revision']


@pytest.mark.asyncio
@pytest.mark.parametrize('limit_name, limit', [('CONTEXT_SCAN_EVENTS', 55), ('CONTEXT_DECODE_BYTES', 1600)])
async def test_context_safety_caps_report_real_omission(monkeypatch, limit_name, limit):
    import fuli_graph.store_agent_conversations as module
    monkeypatch.setattr(module, limit_name, limit)
    store = Store()
    driver = store.runtime.driver
    driver.append('user', 'older user')
    for index in range(70):
        driver.append('tool', f'tool {index}', kind='tool_result')
    driver.append('assistant', 'newest visible')
    context = (await store.query_conversations(None, query('context')))['context']
    assert context['scan_truncated'] is True and context['truncated'] is True
    assert [message['content'] for message in context['messages']] == ['newest visible']
    assert 1 <= context['omitted_sequence'] < driver.conversation['revision']
