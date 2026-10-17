"""Authenticated task-result observation and on-demand project weight reads."""

from typing import Annotated

from fastapi import Query

from .personal_project_access import authorize_personal_project
from .project_memory_usage import (
    ProjectMemoryUsageCreate, read_project_memory_usage, record_project_memory_usage,
)


def register_project_memory_usage_routes(application, store, Actor):
    @application.post('/v1/project-memory-usage')
    async def record_usage(request: ProjectMemoryUsageCreate, actor: Actor):
        return await record_project_memory_usage(store, actor, request)

    @application.get('/v1/project-memory-usage')
    async def read_usage(actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[str | None, Query(min_length=1, max_length=128)] = None):
        store._require_personal()
        space = await store.authorize(actor, personal_space_id, 'reader')
        if personal_project_id:
            await authorize_personal_project(store, actor, space, personal_project_id)
        return await read_project_memory_usage(store, personal_space_id, personal_project_id)
