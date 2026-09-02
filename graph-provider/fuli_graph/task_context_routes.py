from typing import Annotated

from fastapi import Query

from .models import SourceApplication
from .task_context_models import TaskContextBegin, TaskContextCheckpoint


def register_task_context_routes(application, store, Actor):
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
