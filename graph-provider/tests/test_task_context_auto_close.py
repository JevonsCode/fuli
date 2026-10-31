import pytest

from fuli_graph.task_context_auto_close import routine_fallback_eligible


BASE = {'entry_via': 'tool', 'source_application': 'codex', 'checkpoint': None}


@pytest.mark.parametrize('change', [
    {'entry_via': None}, {'entry_via': 'hook'}, {'source_application': 'other'},
    {'checkpoint': {'phase': 'prepare', 'disposition': 'capture_candidates'}},
    {'checkpoint': {'phase': 'complete'}}, {'agent_memory_scope': 'task_only'},
    {'coordination_task_id': 'owned-task'}, {'coordination_task_ids': ['owned-task']},
    {'activity_origin': {'kind': 'ai_internal'}},
])
def test_unknown_claimed_and_internal_contexts_do_not_qualify(change):
    assert not routine_fallback_eligible({**BASE, **change})


@pytest.mark.parametrize('source_application', ['kiro', 'antigravity'])
def test_mcp_only_clients_with_their_own_source_qualify(source_application):
    assert routine_fallback_eligible({**BASE, 'source_application': source_application})


def test_employee_summary_requirement_accepts_only_a_reported_auto_close():
    assert routine_fallback_eligible({**BASE, 'work_log_required': True})
    assert not routine_fallback_eligible(BASE, protected=True)
    assert not routine_fallback_eligible(BASE, claimed=True)
