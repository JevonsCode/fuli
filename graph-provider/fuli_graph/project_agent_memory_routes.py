"""Transport boundary for host-independent Agent working memory."""

from typing import Annotated

from fastapi import HTTPException, Query

from .project_agent_memory_models import (
    ProjectAgentMemoryRecord,
    ProjectAgentMemoryView,
    ProjectAgentMemoryWrite,
)
from .project_agent_context_models import (
    ProjectAgentContextRequest, ProjectAgentContextResolution,
)
from .task_context_routes import register_task_context_routes


def register_project_agent_memory_routes(application, store, Actor):
    register_task_context_routes(application, store, Actor)
    @application.post(
        '/v1/project-agent-context/resolve', response_model=ProjectAgentContextResolution,
    )
    async def resolve_context(request: ProjectAgentContextRequest, actor: Actor):
        return await store.resolve_project_agent_context(actor, request)

    @application.get(
        '/v1/project-agents/{agent_id}/memory', response_model=ProjectAgentMemoryView,
    )
    async def get_memory(
        agent_id: str,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[str, Query(min_length=1, max_length=128)],
        limit: Annotated[int, Query(ge=1, le=10)] = 1,
    ):
        return await store.get_project_agent_memory(
            actor, personal_space_id, personal_project_id, agent_id, limit=limit,
        )

    @application.put(
        '/v1/project-agents/{agent_id}/memory', response_model=ProjectAgentMemoryRecord,
    )
    async def write_memory(agent_id: str, request: ProjectAgentMemoryWrite, actor: Actor):
        if request.agent_id != agent_id:
            raise HTTPException(status_code=422, detail='Agent memory target does not match path')
        return await store.write_project_agent_memory(actor, request)
