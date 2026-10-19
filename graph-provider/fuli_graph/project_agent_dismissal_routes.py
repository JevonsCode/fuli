"""Transport boundary for dismissing an Agent and reading what it left behind."""

from typing import Annotated

from fastapi import Query

from .project_agent_dismissal_models import (
    DEFAULT_LESSON_LIMIT,
    MAX_LESSON_LIMIT,
    ProjectAgentDismissal,
    ProjectAgentDismissalLessons,
    ProjectAgentDismissalReceipt,
    ProjectAgentDismissalRecord,
)
from .project_agent_occupation_models import ProjectAgentOccupationKey

MAX_LESSON_OCCUPATIONS = 8


def register_project_agent_dismissal_routes(application, store, Actor):
    @application.post(
        '/v1/project-agents/{agent_id}/dismissal', response_model=ProjectAgentDismissalReceipt,
    )
    async def dismiss_project_agent(agent_id: str, request: ProjectAgentDismissal, actor: Actor):
        return await store.dismiss_project_agent(actor, agent_id, request)

    @application.get(
        '/v1/project-agents/{agent_id}/dismissal', response_model=ProjectAgentDismissalRecord,
    )
    async def get_project_agent_dismissal(
        agent_id: str, actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ):
        return await store.get_project_agent_dismissal(actor, personal_space_id, agent_id)

    @application.get(
        '/v1/project-agent-dismissal-lessons', response_model=ProjectAgentDismissalLessons,
    )
    async def list_project_agent_dismissal_lessons(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        occupation: Annotated[
            list[ProjectAgentOccupationKey], Query(max_length=MAX_LESSON_OCCUPATIONS)
        ] = [],
        personal_project_id: Annotated[str | None, Query(min_length=1, max_length=128)] = None,
        query: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
        limit: Annotated[int, Query(ge=0, le=MAX_LESSON_LIMIT)] = DEFAULT_LESSON_LIMIT,
    ):
        return await store.list_project_agent_dismissal_lessons(
            actor, personal_space_id, occupations=list(dict.fromkeys(occupation)),
            personal_project_id=personal_project_id, query=query, limit=limit,
        )
