import pytest
from pydantic import ValidationError

from fuli_graph.agent_conversation_models import ConversationPolicy, ConversationEvent
from fuli_graph.conversation_context import pack_context, archived


def test_default_archive_policy_is_seven_days():
    policy = ConversationPolicy()
    assert policy.idle_days == 7
    assert policy.context_budget == 2000
    assert archived('2026-01-01T00:00:00+00:00', 7, now='2026-01-08T00:00:00+00:00')
    assert not archived('2026-01-01T00:00:00+00:00', 7, now='2026-01-07T23:59:59+00:00')


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
