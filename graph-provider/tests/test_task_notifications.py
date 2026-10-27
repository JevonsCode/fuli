import asyncio
from typing import Annotated
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI, HTTPException

from fuli_graph.project_agent_routes import register_project_agent_routes
from fuli_graph.project_agent_task_models import ProjectAgentTaskActivityCreate


class Store:
    def _require_personal(self):
        pass

    async def authorize(self, actor, space, role):
        if actor['space'] != space:
            raise HTTPException(403, 'Space access required')
        return {'id': space, 'kind': 'personal'}

    async def record_project_agent_task_activity(self, actor, request):
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        if request.summary == 'Reject this write':
            raise HTTPException(409, 'Revision conflict')
        return SimpleNamespace(task_id=request.task_id)


def endpoints():
    app = FastAPI()
    async def actor():
        return {'space': 'space-a'}
    register_project_agent_routes(app, Store(), Annotated[dict, Depends(actor)], Annotated[dict, Depends(actor)])
    routes = {route.path: route.endpoint for route in app.routes}
    assert '/v1/project-agent-task-events' in routes, 'Task updates need an authenticated notification stream'
    return routes['/v1/project-agent-task-events'], routes['/v1/project-agent-tasks/{task_id}/events']


def activity(space='space-a', summary='Saved progress'):
    return ProjectAgentTaskActivityCreate(personal_space_id=space, personal_project_id='project',
        task_id='task-a', idempotency_key='synthetic-notification', status='running', summary=summary)


@pytest.mark.asyncio
async def test_committed_activity_notifies_only_its_space_and_reconnect_requests_resync():
    subscribe, write = endpoints()
    response = await subscribe(actor={'space': 'space-a'}, personal_space_id='space-a')
    stream = response.body_iterator
    assert 'event: ready' in await anext(stream)
    await write('task-a', activity(), actor={'space': 'space-a'})
    assert '"taskId":"task-a"' in await anext(stream)
    other = await subscribe(actor={'space': 'space-b'}, personal_space_id='space-b')
    other_stream = other.body_iterator
    await anext(other_stream)
    waiting = asyncio.create_task(anext(other_stream))
    await write('task-a', activity(), actor={'space': 'space-a'})
    await asyncio.sleep(0)
    assert not waiting.done(), 'An unrelated space must not receive task identifiers'
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    await stream.aclose()
    reconnected = await subscribe(actor={'space': 'space-a'}, personal_space_id='space-a')
    assert 'event: ready' in await anext(reconnected.body_iterator)
    await reconnected.body_iterator.aclose()


@pytest.mark.asyncio
async def test_denied_reads_failed_writes_and_revoked_access_do_not_deliver_updates():
    subscribe, write = endpoints()
    with pytest.raises(HTTPException) as denied:
        await subscribe(actor={'space': 'other'}, personal_space_id='space-a')
    assert denied.value.status_code == 403
    actor = {'space': 'space-a'}
    response = await subscribe(actor=actor, personal_space_id='space-a')
    stream = response.body_iterator
    await anext(stream)
    with pytest.raises(HTTPException):
        await write('task-a', activity(summary='Reject this write'), actor=actor)
    waiting = asyncio.create_task(anext(stream))
    await asyncio.sleep(0)
    assert not waiting.done()
    actor['space'] = 'revoked'
    await write('task-a', activity(), actor={'space': 'space-a'})
    with pytest.raises(HTTPException):
        await waiting


@pytest.mark.asyncio
async def test_burst_updates_coalesce_to_resync_instead_of_losing_another_task():
    subscribe, write = endpoints()
    response = await subscribe(actor={'space': 'space-a'}, personal_space_id='space-a')
    stream = response.body_iterator
    await anext(stream)
    await write('task-a', activity(), actor={'space': 'space-a'})
    await write('task-a', activity(), actor={'space': 'space-a'})
    assert '"taskId":null' in await anext(stream)
    await stream.aclose()
