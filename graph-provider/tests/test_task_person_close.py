"""The person completes or cancels a task themself, or an FLA relays their words (rec#123)."""

from types import SimpleNamespace
from typing import Annotated

import pytest
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from fuli_graph.project_agent_routes import register_project_agent_routes
from fuli_graph.project_agent_task_models import ProjectAgentTaskActivityCreate, ProjectAgentTaskPersonClose
from test_project_agent_tasks import ActivityStore
from test_task_blockers import PERSON, BlockerStore, blocked_row

SESSION_B = '66666666-7777-4888-9999-000000000000'


class CloseStore(BlockerStore):
    def __init__(self, row):
        super().__init__(row)
        # Shared with the transaction's shallow copy of the store.
        self.closed_loans = []

    async def close_task_agent_loans(self, actor, space_id, task_id):
        self.closed_loans.append(task_id)


def close(status='completed', **changes):
    return ProjectAgentTaskPersonClose(**{
        'personal_space_id': 'personal-space', 'personal_project_id': 'project-a', 'status': status,
        'summary': '「这个任务做完了，可以关掉」', 'relayed_by': 'agent-b', 'source_application': 'claude_code',
        'source_session_id': SESSION_B} | changes)


def verified_row(status='running'):
    row = blocked_row()
    row['task'] = row['task'] | {'status': status, 'verification_required': True, 'quality_gate': None}
    return row


@pytest.mark.asyncio
@pytest.mark.parametrize('status', ['completed', 'cancelled'])
async def test_the_person_closes_a_verified_task_without_a_revision_or_participating_agent(status):
    store = CloseStore(verified_row())
    task = await store.close_task_by_person(PERSON, 'task-a', close(status))
    assert task['task_id'] == 'task-a'
    [written] = store.runtime.driver.writes('CREATE (event:FuliProjectAgentTaskEvent')
    # The person's event, naming the FLA that relayed their words and where.
    assert (written['status'], written['summary'], written['relayed_by']) == (
        status, '「这个任务做完了，可以关掉」', 'agent-b')
    assert (written['application'], written['session_id'], written['cleared_by']) == ('claude_code', SESSION_B, None)
    [query] = [query for query, _ in store.runtime.driver.calls if 'CREATE (event:FuliProjectAgentTaskEvent' in query]
    assert "actor_kind: 'human'" in query and 'task.completed_at = $updated_at' in query
    assert 'participant.ended_at = $updated_at' in query
    # Loans close and a temporary Agent is archived, as for any finished task.
    assert store.closed_loans == ['task-a'] and store.runtime.driver.writes("agent_type: 'temporary'")


@pytest.mark.asyncio
async def test_closing_a_blocked_task_ends_its_block_and_its_requests():
    store = CloseStore(blocked_row())
    await store.close_task_by_person(PERSON, 'task-a', close('cancelled', relayed_by=None, source_application=None,
                                                             source_session_id=None))
    [written] = store.runtime.driver.writes('CREATE (event:FuliProjectAgentTaskEvent')
    assert (written['cleared_by'], written['relayed_by']) == ('person', None)
    [closed] = store.runtime.driver.writes('FuliAgentAttention')
    assert closed['kinds'] == ['blocked', 'question']


@pytest.mark.asyncio
async def test_only_the_human_review_channel_closes_and_a_finished_task_stays_finished():
    store = CloseStore(verified_row())
    with pytest.raises(HTTPException) as refused:
        await store.close_task_by_person({'id': 'principal'}, 'task-a', close())
    assert refused.value.status_code == 403
    finished = CloseStore(verified_row('completed'))
    with pytest.raises(HTTPException) as again:
        await finished.close_task_by_person(PERSON, 'task-a', close('cancelled'))
    assert again.value.status_code == 409 and 'already completed' in again.value.detail
    assert store.runtime.driver.writes('CREATE (event') == finished.runtime.driver.writes('CREATE (event') == []
    with pytest.raises(ValidationError):
        close('failed')


@pytest.mark.asyncio
async def test_an_agents_own_completion_still_needs_the_verified_revision_and_names_the_persons_route():
    store = ActivityStore(verified_row())
    request = ProjectAgentTaskActivityCreate(
        personal_space_id='personal-space', personal_project_id='project-a', task_id='task-a',
        idempotency_key='own-completion', status='completed', summary='Done.', agent_id='agent-a')
    with pytest.raises(HTTPException) as refused:
        await store.record_project_agent_task_activity({'id': 'principal'}, request)
    assert 'task close route' in refused.value.detail and len(refused.value.detail) <= 240
    assert store.runtime.driver.event_calls == []
    with pytest.raises(ValidationError, match='task close route'):
        ProjectAgentTaskActivityCreate(
            personal_space_id='personal-space', personal_project_id='project-a', task_id='task-a',
            idempotency_key='no-agent', status='completed', summary='Done.')


@pytest.mark.asyncio
@pytest.mark.parametrize('status', ['cancelled', 'completed', 'running', 'blocked'])
async def test_an_agents_activity_never_writes_the_persons_event(status):
    # rec#123 review: actorKind human (a completion counts as 人确认) comes only on the human-review channel.
    store = ActivityStore(verified_row())
    request = ProjectAgentTaskActivityCreate(
        personal_space_id='personal-space', personal_project_id='project-a', task_id='task-a',
        idempotency_key='as-the-person', status=status, summary='The person wants this stopped.',
        agent_id='agent-a', actor_kind='human')
    with pytest.raises(HTTPException) as refused:
        await store.record_project_agent_task_activity({'id': 'principal'}, request)
    assert refused.value.status_code == 403 and 'task close route' in refused.value.detail
    assert len(refused.value.detail) <= 240
    assert store.runtime.driver.event_calls == []


def test_the_close_route_takes_only_the_human_review_actor():
    async def actor():
        return {'id': 'principal'}

    async def human(x_fuli_human_review_token: Annotated[str | None, Header()] = None):
        if x_fuli_human_review_token != 'synthetic-proof':
            raise HTTPException(403, 'independent human review proof required')
        return {'id': 'principal', '_human_review_verified': True}

    calls = []

    async def close_task_by_person(actor_value, task_id, request):
        calls.append((task_id, request.status))
        return {'task_id': task_id, 'personal_space_id': 'personal-space', 'personal_project_id': 'project-a',
                'title': 'Synthetic', 'objective': 'Synthetic', 'work_kind': 'implementation',
                'status': request.status}

    app = FastAPI()
    register_project_agent_routes(app, SimpleNamespace(close_task_by_person=close_task_by_person),
                                  Annotated[dict, Depends(actor)], Annotated[dict, Depends(human)])
    client = TestClient(app)
    body = {'personal_space_id': 'personal-space', 'personal_project_id': 'project-a', 'status': 'completed',
            'summary': 'Done.'}
    assert client.post('/v1/project-agent-tasks/task-a/close', json=body).status_code == 403
    assert calls == []
