"""Authenticated host ports; deliberately absent from the worker business tools."""

from typing import Annotated

from fastapi import APIRouter, Header, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import SecretStr

from .project_agent_worker_models import WorkerRunClose, WorkerRunPrepare, WorkerRunScope, WorkerRunSession, WorkerRunResult


class WorkerRunRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def without_request_values(request):
            try:
                return await handler(request)
            except RequestValidationError as error:
                # Even a malformed request must not echo a misplaced capability.
                return JSONResponse(status_code=422, content={'detail': [
                    {key: item[key] for key in ('loc', 'msg', 'type') if key in item}
                    for item in error.errors()]})
        return without_request_values


def register_project_agent_worker_routes(application, store, Actor):
    router = APIRouter(route_class=WorkerRunRoute)

    @router.put('/v1/project-agent-worker-runs')
    async def prepare_run(request: WorkerRunPrepare, actor: Actor):
        return await store.prepare_project_agent_worker_run(actor, request)

    @router.post('/v1/project-agent-worker-runs/{run_id}/start-claim')
    async def claim_start(run_id: str, request: WorkerRunScope, actor: Actor,
        x_fuli_worker_capability: Annotated[SecretStr | None, Header()] = None):
        return await store.claim_project_agent_worker_start(actor, run_id, request, x_fuli_worker_capability)

    @router.put('/v1/project-agent-worker-runs/{run_id}/session')
    async def seal_session(run_id: str, request: WorkerRunSession, actor: Actor,
        x_fuli_worker_capability: Annotated[SecretStr | None, Header()] = None):
        return await store.seal_project_agent_worker_session(actor, run_id, request, x_fuli_worker_capability)

    @router.post('/v1/project-agent-worker-runs/{run_id}/contexts')
    async def admit_context(run_id: str, request: WorkerRunSession, actor: Actor,
        x_fuli_worker_capability: Annotated[SecretStr | None, Header()] = None):
        return await store.admit_project_agent_worker_context(actor, run_id, request, x_fuli_worker_capability)

    @router.get('/v1/project-agent-worker-runs/{run_id}')
    async def read_run(run_id: str, actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[str, Query(min_length=1, max_length=128)],
        x_fuli_worker_capability: Annotated[SecretStr | None, Header()] = None):
        return await store.get_project_agent_worker_run(actor, run_id, WorkerRunScope(
            personal_space_id=personal_space_id, personal_project_id=personal_project_id), x_fuli_worker_capability)

    @router.post('/v1/project-agent-worker-runs/{run_id}/close')
    async def close_run(run_id: str, request: WorkerRunClose, actor: Actor,
        x_fuli_worker_capability: Annotated[SecretStr | None, Header()] = None):
        return await store.close_project_agent_worker_run(actor, run_id, request, x_fuli_worker_capability)

    @router.post('/v1/project-agent-worker-runs/{run_id}/dispatch')
    async def dispatch_prompt(run_id: str, request: WorkerRunScope, actor: Actor,
        x_fuli_worker_capability: Annotated[SecretStr | None, Header()] = None):
        return await store.dispatch_project_agent_worker_prompt(actor, run_id, request, x_fuli_worker_capability)

    @router.post('/v1/project-agent-worker-runs/{run_id}/result')
    async def record_result(run_id: str, request: WorkerRunResult, actor: Actor,
        x_fuli_worker_capability: Annotated[SecretStr | None, Header()] = None):
        return await store.record_project_agent_worker_result(actor, run_id, request, x_fuli_worker_capability)

    @router.get('/v1/project-agent-tasks/{task_id}/runs')
    async def task_runs(task_id: str, actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[str, Query(min_length=1, max_length=128)],
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        cursor: Annotated[str | None, Query(min_length=1, max_length=128)] = None):
        return await store.list_project_agent_task_runs(actor, WorkerRunScope(
            personal_space_id=personal_space_id, personal_project_id=personal_project_id), task_id,
            limit=limit, cursor=cursor)

    @router.post('/v1/project-agent-worker-runs/{run_id}/revoke')
    async def revoke_run(run_id: str, request: WorkerRunClose, actor: Actor):
        return await store.close_project_agent_worker_run(actor, run_id, request, revoke=True)

    application.include_router(router)
