"""Explicit, human-set occupation for one project Agent."""

from fastapi import HTTPException

from .project_agent_models import ProjectAgentRecord
from .project_agent_occupation_models import (
    ProjectAgentOccupation,
    ProjectAgentOccupationUpdate,
)
from .provider_values import native_datetime, now_utc
from .system_hr_identity import resolve_hr_alias
from .system_agents import SYSTEM_ASSISTANT_AGENT_ID


def occupation_from_agent_node(raw: dict) -> ProjectAgentOccupation | None:
    """Read the stored occupation; agents never edited by a person have none."""
    updated_at = raw.get('occupation_updated_at')
    if updated_at is None or not raw.get('occupation_role'):
        return None
    return ProjectAgentOccupation(
        role=raw.get('occupation_role'),
        tags=list(raw.get('occupation_tags') or []),
        updated_at=native_datetime(updated_at),
    )


class StoreProjectAgentOccupation:
    async def update_project_agent_occupation(
        self,
        actor: dict,
        agent_id: str,
        request: ProjectAgentOccupationUpdate,
    ) -> ProjectAgentRecord:
        """Replace the occupation as one explicit edit; the profile is untouched."""

        self._require_personal()
        if (request.role == 'assistant') != (agent_id == SYSTEM_ASSISTANT_AGENT_ID):
            raise HTTPException(422, 'assistant occupation is reserved for the fixed global assistant')
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        agent_id = await resolve_hr_alias(self, request.personal_space_id, agent_id)
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            WHERE coalesce(agent.status, 'active') <> 'archived'
            SET agent.occupation_role = $role,
                agent.occupation_tags = $tags,
                agent.occupation_updated_at = $updated_at
            RETURN agent.agent_id AS agent_id
            ''',
            personal_space_id=request.personal_space_id,
            agent_id=agent_id,
            role=request.role,
            tags=list(request.tags),
            updated_at=now_utc(),
        )
        if not records:
            raise HTTPException(status_code=404, detail='active project Agent not found')
        return await self.get_project_agent(
            actor,
            request.personal_space_id,
            None,
            agent_id,
        )
