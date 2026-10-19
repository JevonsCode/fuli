"""A submit whose answer was lost is found again by its idempotency key.

A local scheduler that crashed after submitting cannot know whether the task
exists. The Provider derives a task's ID from the submit's idempotency key, so
the same key reads that task back, or reliably reports that none exists.
"""

from types import SimpleNamespace
from typing import Annotated

import httpx
import pytest
from fastapi import Depends, FastAPI

from fuli_graph.project_agent_routes import register_project_agent_routes
from fuli_graph.project_agent_task_models import ProjectAgentTaskSubmit
from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks
from fuli_graph.store_transactions import TransactionQueryDriver
from test_project_agent_execution_summary import PublicTaskReadStore, task_row

ACTOR = {'id': 'principal-a'}
KEY = 'schedule:weekly-notes:2026-10-18T00:00:00.000Z'


class StopAtTaskRead(Exception):
    pass


class RecordingTransaction:
    """Grants the project and records every task read with its parameters."""

    def __init__(self, answer_task_read):
        self.task_reads = []
        self.answer_task_read = answer_task_read

    async def run(self, query, **parameters):
        if 'task_id' in parameters:
            self.task_reads.append(parameters)
            rows = self.answer_task_read()
        else:
            rows = [{'project': {'project_id': parameters['project_id']}}]

        async def records():
            for row in rows:
                yield row
        return records()


class LookupStore(StoreProjectAgentTasks):
    def __init__(self, transaction):
        self.runtime = SimpleNamespace(driver=TransactionQueryDriver(transaction))
        self.settings = SimpleNamespace(provider_mode='personal', provider_id='provider-1')

    def _require_personal(self):
        return None

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}


def stop_at_task_read():
    raise StopAtTaskRead()


@pytest.mark.asyncio
async def test_lookup_reads_exactly_the_task_a_submit_with_that_key_creates():
    submitted = RecordingTransaction(stop_at_task_read)
    with pytest.raises(StopAtTaskRead):
        await LookupStore(submitted).submit_project_agent_task(ACTOR, ProjectAgentTaskSubmit(
            personal_space_id='space-a', personal_project_id='project-a', idempotency_key=KEY,
            title='Weekly reading notes', objective='Organise the notes.', work_kind='writing',
            routing_reason='Scheduled task.',
        ))
    looked_up = RecordingTransaction(lambda: [])

    found = await LookupStore(looked_up).find_project_agent_task_by_idempotency_key(
        ACTOR, 'space-a', 'project-a', KEY,
    )

    assert found is None
    assert looked_up.task_reads[0]['task_id'] == submitted.task_reads[0]['task_id']
    assert looked_up.task_reads[0]['personal_project_id'] == 'project-a'
    next_slot = RecordingTransaction(lambda: [])
    await LookupStore(next_slot).find_project_agent_task_by_idempotency_key(
        ACTOR, 'space-a', 'project-a', 'schedule:weekly-notes:2026-10-25T00:00:00.000Z',
    )
    assert next_slot.task_reads[0]['task_id'] != submitted.task_reads[0]['task_id']


@pytest.mark.asyncio
async def test_lookup_returns_the_existing_task():
    found = await LookupStore(RecordingTransaction(lambda: [task_row()])).find_project_agent_task_by_idempotency_key(
        ACTOR, 'space-a', 'project-a', KEY,
    )

    assert found.task_id == 'task-a'
    assert found.status == 'running'


@pytest.mark.asyncio
async def test_lookup_route_answers_none_or_the_compact_task():
    task = await PublicTaskReadStore(task_row()).get_project_agent_task(ACTOR, 'space-a', 'task-a')
    tasks = {KEY: task}
    calls = []

    async def find(actor, space, project, key):
        calls.append((space, project, key))
        return tasks.get(key)

    async def actor():
        return ACTOR

    app = FastAPI()
    register_project_agent_routes(
        app, SimpleNamespace(find_project_agent_task_by_idempotency_key=find), Annotated[dict, Depends(actor)],
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://fixture',
    ) as client:
        params = {'personal_space_id': 'space-a', 'personal_project_id': 'project-a'}
        hit = await client.get('/v1/project-agent-task-lookup', params={**params, 'idempotency_key': KEY})
        miss = await client.get('/v1/project-agent-task-lookup', params={**params, 'idempotency_key': 'schedule:other'})
        short = await client.get('/v1/project-agent-task-lookup', params={**params, 'idempotency_key': 'short'})

    assert hit.status_code == 200, hit.text
    assert hit.json()['task']['task_id'] == 'task-a'
    assert hit.json()['task']['events'] == []
    assert miss.status_code == 200, miss.text
    assert miss.json() == {'task': None}
    assert short.status_code == 422
    assert calls == [('space-a', 'project-a', KEY), ('space-a', 'project-a', 'schedule:other')]
