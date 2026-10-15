import pytest
from pydantic import ValidationError

from fuli_graph.agent_conversation_models import ConversationPolicy, ConversationEvent
from fuli_graph.conversation_context import (
    add_task_result, fold_messages, pack_context, render_digest,
)


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
    text = render_digest(digest)
    assert text.startswith('[2026-10-09 completed] result 8')
    assert 'Earlier requests:\n- 修复登录跳转' in text
    assert '- 新请求标题 [request, user #3]' in text
    assert 'tool output' not in text


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
def test_context_json_stays_within_budget_for_escaped_and_unicode_summaries(summary):
    import json
    for budget in (512, 4000):
        result = pack_context(summary, [{'role': 'user', 'content': 'recent "quoted" \\ message'}], budget)
        assert len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()) <= budget
        assert result['truncated'] is True
        # The newest end of the legacy summary is kept verbatim.
        assert result['summary'] and summary.endswith(result['summary'])


@pytest.mark.parametrize('checkpoint', ['\\' * 3000, '"完成"\n' * 600, 'done ' * 500],
                         ids=['backslashes', 'quoted-multibyte', 'ascii'])
def test_latest_checkpoint_is_bounded_with_escapes_and_reports_truncation(checkpoint):
    import json
    for budget in (512, 4000):
        result = pack_context('TODO: stale excerpt\n' * 300, [{'role': 'user', 'content': 'recent'}], budget,
                              {'status': 'completed', 'summary': checkpoint})
        assert len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()) <= budget
        latest = result['latest_checkpoint']
        assert latest['status'] == 'completed' and latest['truncated'] is True
        # The checkpoint keeps its beginning, so completed work is never cut first.
        assert latest['summary'] and checkpoint.startswith(latest['summary'].removesuffix('…'))
        assert result['summary_role'] == 'historical'


def test_short_checkpoint_is_kept_verbatim_and_context_without_one_is_null():
    result = pack_context('', [], 512, {'status': 'incomplete', 'summary': 'Step 3 remains.'})
    assert result['latest_checkpoint'] == {'status': 'incomplete', 'summary': 'Step 3 remains.', 'truncated': False}
    assert pack_context('x', [], 512)['latest_checkpoint'] is None


def test_rejects_private_reasoning_and_unbounded_policy():
    with pytest.raises(ValidationError):
        ConversationEvent(event_id='x', role='reasoning', content='private')
    with pytest.raises(ValidationError):
        ConversationPolicy(context_budget=1000000)
    with pytest.raises(ValidationError):
        ConversationPolicy(compact_after_kb=1)
