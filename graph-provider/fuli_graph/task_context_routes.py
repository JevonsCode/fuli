from typing import Annotated

from fastapi import Query

from .models import SourceApplication
from .task_context_models import TaskContextBegin, TaskContextCheckpoint, TaskContextAdoptAgent


def register_task_context_routes(application, store, Actor):
    @application.get('/v1/task-context-sessions/recent')
    async def recent_sessions(actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        project_agent_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[str | None, Query(min_length=1, max_length=128)] = None,
        limit: Annotated[int, Query(ge=1, le=20)] = 5):
        return await store.recent_agent_sessions(
            actor, personal_space_id, project_agent_id, personal_project_id, limit,
        )

    @application.get('/v1/task-context-sessions/current')
    async def current_context(actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        session_id: Annotated[str, Query(min_length=1, max_length=256)],
        source_application: SourceApplication):
        return await store.current_task_context(actor, personal_space_id, session_id, source_application)

    @application.put('/v1/task-contexts/{token}/agent')
    async def adopt_agent(token: str, request: TaskContextAdoptAgent, actor: Actor):
        return await store.adopt_task_context_agent(actor, token, request)

    @application.put('/v1/task-contexts')
    async def begin_context(request: TaskContextBegin, actor: Actor):
        return await store.begin_task_context(actor, request)

    @application.get('/v1/task-contexts/{token}')
    async def get_context(token: str, actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        source_application: SourceApplication):
        return await store.get_task_context(actor, personal_space_id, token, source_application)

    @application.put('/v1/task-contexts/{token}/checkpoint')
    async def checkpoint_context(token: str, request: TaskContextCheckpoint, actor: Actor):
        return await store.checkpoint_task_context(actor, token, request)

    @application.get('/v1/task-context-sessions/checkpoint')
    async def verify_checkpoint(actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        session_id: Annotated[str, Query(min_length=1, max_length=256)],
        source_application: SourceApplication):
        return await store.verify_task_checkpoint(
            actor, personal_space_id, session_id, source_application,
        )
