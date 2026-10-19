"""Dismissal contract and refusals without a graph; the graph suite covers storage."""

from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from fuli_graph.project_agent_dismissal_models import ProjectAgentDismissal
from fuli_graph.store_project_agent_dismissal import StoreProjectAgentDismissal
from test_project_agents import SequentialDriver, StoreStub, project_agent_profile, raw_agent

HANDOFF = {'filename': 'handoff.md', 'markdown': '# Handoff\n\nKeep this trailing line.\n'}


class DismissalStore(StoreProjectAgentDismissal, StoreStub):
    pass


def request(**changes):
    return ProjectAgentDismissal(**{
        'personal_space_id': 'personal-space',
        'reason': '  Reported work as done without running the tests.  ',
        'handoff': HANDOFF, **changes,
    })


def test_a_dismissal_needs_a_real_reason_and_keeps_the_handoff_verbatim():
    dismissal = request()
    assert dismissal.reason == 'Reported work as done without running the tests.'
    assert dismissal.lessons == [dismissal.reason]
    assert dismissal.handoff.markdown == HANDOFF['markdown']
    for invalid in [{'reason': ''}, {'reason': '   '}, {'reason': 'ok'},
                    {'lessons': ['one lesson', 'two lesson', 'three lesson', 'four lesson']},
                    {'reason': 'Leaked api_key=sk-live-0123456789abcdefghijklmnop in a log'},
                    {'handoff': {'filename': 'h.md', 'markdown': 'x' * (512 * 1024 + 1)}}]:
        with pytest.raises(ValidationError):
            request(**invalid)


def test_duplicate_lessons_are_rejected_instead_of_silently_merged():
    with pytest.raises(ValidationError, match='unique'):
        request(lessons=['Run tests first.', 'run tests FIRST.'])


@pytest.mark.asyncio
@pytest.mark.parametrize('agent_id', [
    'employee.assistant', 'employee.jefa', 'employee.bole',
    'fuli-project-coordinator', 'fuli-project-hr',
])
async def test_system_roles_are_refused_before_any_graph_read(agent_id):
    driver = SequentialDriver([])
    store = DismissalStore(driver)
    with pytest.raises(HTTPException) as dismissed:
        await store.dismiss_project_agent({'id': 'principal-1'}, agent_id, request())
    with pytest.raises(HTTPException) as archived:
        await store.archive_test_project_agent(
            {'id': 'principal-1'}, 'personal-space', agent_id, reason='archived test role')
    assert dismissed.value.status_code == archived.value.status_code == 422
    assert driver.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize('row, status, message', [
    ({'outcome': 'open_tasks', 'open_task_count': 2}, 409, 'Agent has 2 open tasks'),
    ({'outcome': 'open_tasks', 'open_task_count': 1}, 409, 'Agent has 1 open task;'),
    ({'outcome': 'project_lead', 'open_task_count': 0}, 409, 'hand off the project lead'),
    ({'outcome': 'already_archived', 'open_task_count': 0}, 409, 'already archived'),
    ({'outcome': 'already_dismissed', 'open_task_count': 0}, 409, 'different reason'),
    ({'outcome': 'system_role', 'open_task_count': 0}, 422, 'system roles'),
])
async def test_each_refusal_says_what_blocks_the_dismissal(row, status, message):
    store = DismissalStore(SequentialDriver([[{**row, 'dismissal': None}]]))
    with pytest.raises(HTTPException) as refused:
        await store.dismiss_project_agent({'id': 'principal-1'}, 'engineer', request())
    assert refused.value.status_code == status
    assert message in refused.value.detail


@pytest.mark.asyncio
async def test_a_missing_agent_is_not_found():
    store = DismissalStore(SequentialDriver([[]]))
    with pytest.raises(HTTPException) as missing:
        await store.dismiss_project_agent({'id': 'principal-1'}, 'nobody', request())
    assert missing.value.status_code == 404


@pytest.mark.asyncio
async def test_the_receipt_counts_lessons_and_handoff_without_returning_the_text():
    dismissed_at = datetime(2026, 10, 20, tzinfo=UTC)
    driver = SequentialDriver([[{'outcome': 'dismissed', 'open_task_count': 0, 'dismissal': {
        'dismissal_id': 'dismissal-1', 'agent_id': 'engineer', 'agent_name': 'Engineer',
        'employee_number': 12, 'occupation_role': 'engineering', 'project_ids': ['project-a'],
        'lessons': ['Run tests first.'], 'handoff_filename': 'handoff.md',
        'handoff_characters': len(HANDOFF['markdown']), 'dismissed_at': dismissed_at}}]])
    receipt = await DismissalStore(driver).dismiss_project_agent(
        {'id': 'principal-1'}, 'engineer', request(lessons=['Run tests first.']))
    assert receipt.model_dump() == {
        'dismissal_id': 'dismissal-1', 'agent_id': 'engineer', 'agent_name': 'Engineer',
        'employee_number': '000012', 'occupation_role': 'engineering', 'project_ids': ['project-a'],
        'lesson_count': 1, 'handoff_filename': 'handoff.md',
        'handoff_characters': len(HANDOFF['markdown']), 'dismissed_at': dismissed_at,
        'replayed': False}
    query, parameters = driver.calls[0]
    assert query.index('agent._task_lifecycle_lock') < query.index('HAS_PARTICIPANT')
    assert parameters['handoff_markdown'] == HANDOFF['markdown']
    assert parameters['lessons'] == ['Run tests first.']


@pytest.mark.asyncio
async def test_lessons_need_an_occupation_or_a_project():
    driver = SequentialDriver([])
    with pytest.raises(HTTPException) as unscoped:
        await DismissalStore(driver).list_project_agent_dismissal_lessons(
            {'id': 'principal-1'}, 'personal-space', occupations=[],
            personal_project_id=None, query=None)
    assert unscoped.value.status_code == 422
    assert driver.calls == []


@pytest.mark.asyncio
async def test_a_test_role_archive_returns_the_reason_on_the_record():
    archived = raw_agent(project_agent_profile().model_copy(update={'status': 'archived'}))
    archived.update(status='archived', archive_reason='archived test role',
                    archived_at=datetime(2026, 10, 20, tzinfo=UTC))
    driver = SequentialDriver([
        [{'outcome': 'archived_now', 'open_task_count': 0}],
        [{'agent': archived, 'assignment_rows': [], 'task_rows': [], 'observed_clients': []}],
    ])
    record = await DismissalStore(driver).archive_test_project_agent(
        {'id': 'principal-1'}, 'personal-space', 'activity-agent', reason='archived test role')
    assert record.archive_reason == 'archived test role'
    assert record.archived_at == datetime(2026, 10, 20, tzinfo=UTC)
    assert record.work_status == 'ended'
