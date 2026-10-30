import pytest
from pydantic import ValidationError

from fuli_graph.agent_conversation_models import ConversationPolicy, ConversationEvent
from fuli_graph.conversation_context import (
    add_delivery_proofs, add_task_result, fold_messages, pack_context,
)


def test_delivery_proofs_name_only_the_asking_sessions_records_and_never_spend_the_budget():
    import hashlib
    import json
    events = [
        {'sequence': 1, 'role': 'user', 'content': 'xxx', 'event_id': 'jsonl-v1:10:0:0',
         'session_id': 'c', 'source_application': 'codex'},
        {'sequence': 2, 'role': 'user', 'content': 'zzz', 'event_id': 'jsonl-v1:10:0:0',
         'session_id': 'h', 'source_application': 'claude_code'},
        {'sequence': 3, 'role': 'assistant', 'content': '长' * 400, 'event_id': 'jsonl-v1:90:0:0',
         'session_id': 'c', 'source_application': 'claude_code'},
    ]
    budget = 700
    context = pack_context('', events, budget, conversation_id='c-1', revision=3)
    add_delivery_proofs(context, events, 'codex', 'c')
    [newest] = context['messages']
    assert newest['truncated'] is True and len(newest['content'].encode()) < len(('长' * 400).encode())
    # The hash is of the whole message, not of the delivered prefix.
    assert newest['content_sha256'] == hashlib.sha256(('长' * 400).encode()).hexdigest()
    whole = add_delivery_proofs(pack_context('', events, 16000, conversation_id='c-1', revision=3),
                                events, 'codex', 'c')
    assert [item['sequence'] for item in whole['messages']] == [1, 2, 3]
    # Only codex session c's own record; the same session ID from another
    # client and another session are never own.
    assert [item.get('own_event') for item in whole['messages']] == ['jsonl-v1:10:0:0', None, None]
    # Proofs are added after packing: the packed window is the one the budget chose.
    plain = pack_context('', events, budget, conversation_id='c-1', revision=3)
    assert json.dumps(plain, ensure_ascii=False, separators=(',', ':')).encode().__len__() <= budget
    assert [item['content'] for item in plain['messages']] == [item['content'] for item in context['messages']]


def test_default_policy_compacts_by_size_and_accepts_old_idle_day_policies():
    policy = ConversationPolicy()
    assert policy.compact_after_kb == 64
    assert policy.context_budget == 4000
    legacy = ConversationPolicy.model_validate_json('{"idle_days":7,"context_budget":1000,"enabled":false}')
    assert legacy.model_dump() == {'compact_after_kb': 64, 'context_budget': 1000, 'enabled': False}


def test_digest_keeps_task_results_bounded_and_legacy_request_notes_readable():
    digest = {}
    for index in range(20):
        digest = add_task_result(digest, f'2026-10-{index + 1:02d}T00:00:00+00:00', 'completed', f'result {index}')
    assert [task['summary'] for task in digest['tasks']] == [f'result {index}' for index in range(8, 20)]
    # Digests saved before extractive folding carried first-line request notes only.
    digest = fold_messages({**digest, 'notes': ['修复登录跳转']}, [
        {'role': 'user', 'content': '\n  新请求标题\n附带日志', 'sequence': 3},
        {'role': 'tool', 'content': 'tool output', 'sequence': 4},
    ])
    assert digest['tasks'][0]['summary'] == 'result 8'
    assert digest['notes'] == ['修复登录跳转']
    assert digest['entries'] == [{'kind': 'request', 'text': '新请求标题', 'sources': [{'role': 'user', 'sequence': 3}]}]


def test_context_budget_counts_multibyte_and_never_returns_tool_payloads():
    result = pack_context('任务摘要' * 1000, [
        {'role': 'user', 'content': '你好' * 1000},
        {'role': 'tool', 'content': 'large tool data'},
    ], 1000)
    import json
    assert len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()) <= 1000
    assert all(item['role'] != 'tool' for item in result['messages'])
    assert result['truncated']


@pytest.mark.parametrize('summary', ['\\' * 2000, '"引号"\n' * 800, '任务' * 3000],
                         ids=['backslashes', 'quoted-multibyte', 'multibyte'])
def test_default_context_omits_legacy_digest_and_keeps_recent_raw(summary):
    import json
    for budget in (512, 4000):
        event = {'sequence': 4, 'role': 'user', 'content': 'recent "quoted" \\ message'}
        result = pack_context(summary, [event], budget)
        assert len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()) <= budget
        assert result['summary'] == ''
        assert result['messages'] == [event]
        assert result['truncated'] is False


@pytest.mark.parametrize('checkpoint', ['\\' * 3000, '"完成"\n' * 600, 'done ' * 1000],
                         ids=['backslashes', 'quoted-multibyte', 'ascii'])
def test_latest_checkpoint_is_bounded_with_escapes_and_reports_truncation(checkpoint):
    import json
    for budget in (512, 4000):
        result = pack_context('TODO: stale excerpt\n' * 300,
                              [{'sequence': 6, 'role': 'user', 'content': 'recent'}], budget,
                              {'status': 'completed', 'summary': checkpoint},
                              conversation_id='synthetic-source', revision=7)
        assert len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()) <= budget
        latest = result['latest_checkpoint']
        assert latest['status'] == 'completed' and latest['truncated'] is True
        # The checkpoint keeps its beginning, so completed work is never cut first.
        assert latest['summary'] and checkpoint.startswith(latest['summary'].removesuffix('…'))
        assert result['summary_role'] == 'historical'
        assert result['conversation_id'] == 'synthetic-source'
        assert result['revision'] == 7


def test_checkpoint_uses_available_budget_before_raw_and_never_skips_a_newer_message():
    checkpoint = {'status': 'completed', 'summary': 'Checkpoint ' * 90}
    result = pack_context('Old digest', [
        {'sequence': 1, 'role': 'user', 'content': 'old small message'},
        {'sequence': 2, 'role': 'assistant', 'content': 'newest ' * 1000},
    ], 1600, checkpoint, conversation_id='source', revision=2)
    assert result['latest_checkpoint'] == {**checkpoint, 'truncated': False}
    assert all(message['sequence'] == 2 for message in result['messages'])
    assert result['truncated'] is True
    assert result['omitted_sequence'] == 2
    assert not any(message['content'] == 'old small message' for message in result['messages'])


@pytest.mark.parametrize('content', ['中文😀"\\\n' * 1000, 'latest ' * 1000])
def test_truncated_newest_message_keeps_sequence_and_exact_prefix_under_whole_json_budget(content):
    import json
    result = pack_context('', [{'sequence': 9, 'role': 'assistant', 'content': content}], 512,
                          conversation_id='source', revision=10)
    assert len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()) <= 512
    assert result['truncated'] is True and result['omitted_sequence'] == 9
    assert result['messages'][0]['sequence'] == 9
    assert result['messages'][0]['truncated'] is True
    assert content.startswith(result['messages'][0]['content'].removesuffix('…'))


def test_short_checkpoint_is_kept_verbatim_and_context_without_one_is_null():
    result = pack_context('', [], 512, {'status': 'incomplete', 'summary': 'Step 3 remains.'})
    assert result['latest_checkpoint'] == {'status': 'incomplete', 'summary': 'Step 3 remains.', 'truncated': False}
    assert pack_context('x', [], 512)['latest_checkpoint'] is None


def test_minimum_budget_includes_long_source_anchor_flags_and_escaped_checkpoint():
    import json
    sequence = 2 ** 53 - 1
    checkpoint = {'status': 'incomplete', 'summary': '😀"\\\n' * 500}
    result = pack_context('', [{'sequence': sequence, 'role': 'user', 'content': 'recent'}], 512,
                          checkpoint, conversation_id='s' * 128, revision=sequence,
                          omitted_sequence=sequence - 1, scan_truncated=True)
    assert len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()) <= 512
    assert result['latest_checkpoint']['truncated'] and result['truncated'] and result['scan_truncated']
    assert result['conversation_id'] == 's' * 128 and result['revision'] == sequence
    assert result['omitted_sequence'] == sequence


def test_rejects_private_reasoning_and_unbounded_policy():
    with pytest.raises(ValidationError):
        ConversationEvent(event_id='x', role='reasoning', content='private')
    with pytest.raises(ValidationError):
        ConversationPolicy(context_budget=1000000)
    with pytest.raises(ValidationError):
        ConversationPolicy(compact_after_kb=1)
