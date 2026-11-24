"""Transport boundary for every rename in a space and for settling shared names."""

from typing import Annotated

from fastapi import Query

from .project_agent_models import NameFixApply, NameFixPlan, ProjectAgentNameChanges, ProjectAgentNameChangesSeen


def register_project_agent_name_routes(application, store, Actor):
    @application.get('/v1/project-agent-name-changes', response_model=ProjectAgentNameChanges)
    async def list_agent_name_changes(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ):
        return await store.list_agent_name_changes(actor, personal_space_id)

    @application.put('/v1/project-agent-name-changes/seen', response_model=ProjectAgentNameChanges)
    async def mark_agent_name_changes_seen(request: ProjectAgentNameChangesSeen, actor: Actor):
        return await store.mark_agent_name_changes_seen(actor, request)

    @application.get('/v1/project-agent-name-fixes', response_model=NameFixPlan)
    async def agent_name_fix_plan(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        keep: Annotated[list[str], Query(max_length=500)] = [],
    ):
        return await store.agent_name_fix_plan(actor, personal_space_id, keep)

    @application.post('/v1/project-agent-name-fixes/apply', response_model=NameFixPlan)
    async def apply_agent_name_fixes(request: NameFixApply, actor: Actor):
        return await store.apply_agent_name_fixes(actor, request)
