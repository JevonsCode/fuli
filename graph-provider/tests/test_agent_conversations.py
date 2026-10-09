import pytest
from pydantic import ValidationError

from fuli_graph.agent_conversation_models import ConversationPolicy, ConversationEvent
from fuli_graph.conversation_context import (
    add_task_result, fold_messages, pack_context, render_digest, request_note,
)


def test_default_policy_compacts_by_size_and_accepts_old_idle_day_policies():
    policy = ConversationPolicy()
    assert policy.compact_after_kb == 64
    assert policy.context_budget == 4000
    legacy = ConversationPolicy.model_validate_json('{"idle_days":7,"context_budget":1000,"enabled":false}')
    assert legacy.model_dump() == {'compact_after_kb': 64, 'context_budget': 1000, 'enabled': False}


def test_digest_keeps_task_results_and_folded_request_notes_bounded():
    digest = {}
    for index in range(20):
        digest = add_task_result(digest, f'2026-10-{index + 1:02d}T00:00:00+00:00', 'completed', f'result {index}')
    assert [task['summary'] for task in digest['tasks']] == [f'result {index}' for index in range(8, 20)]
    digest = fold_messages(digest, [
        {'role': 'user', 'content': '\n  修复登录跳转\n附带日志'},
        {'role': 'assistant', 'content': 'done'},
        {'role': 'user', 'content': 'x' * 400},
        {'role': 'tool', 'content': 'tool output'},
    ])
    assert digest['notes'][0] == '修复登录跳转'
    assert len(digest['notes'][1]) == 160
    text = render_digest(digest)
    assert text.startswith('[2026-10-09 completed] result 8')
    assert 'Earlier requests:\n- 修复登录跳转' in text
    assert request_note('   ') == ''


def test_context_budget_counts_multibyte_and_never_returns_tool_payloads():
    result = pack_context('任务摘要' * 1000, [
        {'role': 'user', 'content': '你好' * 1000},
        {'role': 'tool', 'content': 'large tool data'},
    ], 1000)
    import json
    assert len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()) <= 1000
    assert all(item['role'] != 'tool' for item in result['messages'])
    assert result['truncated']


def test_rejects_private_reasoning_and_unbounded_policy():
    with pytest.raises(ValidationError):
        ConversationEvent(event_id='x', role='reasoning', content='private')
    with pytest.raises(ValidationError):
        ConversationPolicy(context_budget=1000000)
    with pytest.raises(ValidationError):
        ConversationPolicy(compact_after_kb=1)
