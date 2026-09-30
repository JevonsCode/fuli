from types import SimpleNamespace
from typing import Annotated

import httpx
import pytest
from fastapi import Depends, FastAPI

from fuli_graph.project_agent_routes import register_project_agent_routes
from test_project_agent_execution_summary import PublicTaskReadStore, task_row


@pytest.mark.asyncio
async def test_task_detail_can_omit_history_without_losing_worker_evidence():
    task = await PublicTaskReadStore(task_row()).get_project_agent_task(
        {'id': 'principal-a'}, 'space-a', 'task-a',
    )
    calls = []

    async def read(actor, space, task_id, **options):
        calls.append((actor, space, task_id, options))
        return task

    async def actor():
        return {'id': 'principal-a'}

    app = FastAPI()
    register_project_agent_routes(
        app, SimpleNamespace(get_project_agent_task=read), Annotated[dict, Depends(actor)],
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://fixture',
    ) as client:
        compact = await client.get('/v1/project-agent-tasks/task-a', params={
            'personal_space_id': 'space-a', 'personal_project_id': 'project-a',
            'include_events': 'false',
        })
        assert compact.status_code == 200, compact.text
        assert compact.json()['events'] == []
        assert len(compact.json()['execution_summary']) == 2
        assert calls[-1][-1] == {'personal_project_id': 'project-a'}
        detailed = await client.get('/v1/project-agent-tasks/task-a', params={
            'personal_space_id': 'space-a',
        })
        assert detailed.status_code == 200, detailed.text
        assert len(detailed.json()['events']) == len(task.events) > 0
        assert compact.json()['execution_summary'] == detailed.json()['execution_summary']
