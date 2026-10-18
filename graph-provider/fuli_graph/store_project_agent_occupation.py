"""Explicit, human-set occupation for one project Agent."""

from fastapi import HTTPException

from .project_agent_models import ProjectAgentRecord
from .project_agent_occupation_models import (
    ProjectAgentOccupation,
    ProjectAgentOccupationUpdate,
)
from .provider_values import native_datetime, now_utc
from .system_hr_identity import LEGACY_HR_AGENT_ID, resolve_hr_alias
from .system_agents import SYSTEM_ASSISTANT_AGENT_ID
from .occupation_catalog import BUILTIN_AGENT_OCCUPATIONS, BUILTIN_OCCUPATION_KEYS
from .store_occupation_catalog import OCCUPATION_LOCK, active_occupation_predicate, occupation_error, require_active_occupations


def occupation_from_agent_node(raw: dict) -> ProjectAgentOccupation | None:
    """Read the stored occupation; agents never edited by a person have none."""
    builtin_role = BUILTIN_AGENT_OCCUPATIONS.get(raw.get('agent_id'))
    updated_at = raw.get('occupation_updated_at') or (raw.get('created_at') if builtin_role else None)
    if updated_at is None or not (builtin_role or raw.get('occupation_role')):
        return None
    return ProjectAgentOccupation(
        role=builtin_role or raw.get('occupation_role'),
        tags=[] if builtin_role else list(raw.get('occupation_tags') or []),
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
        if agent_id in BUILTIN_AGENT_OCCUPATIONS or agent_id == LEGACY_HR_AGENT_ID:
            occupation_error(409, 'occupation_locked', 'The built-in Agent occupation is locked.')
        if (request.role == 'assistant') != (agent_id == SYSTEM_ASSISTANT_AGENT_ID):
            raise HTTPException(422, 'assistant occupation is reserved for the fixed global assistant')
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        agent_id = await resolve_hr_alias(self, request.personal_space_id, agent_id)
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            ''' + OCCUPATION_LOCK + '''
            WITH space WHERE ''' + active_occupation_predicate() + '''
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
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
            occupation_keys=[request.role, *request.tags],
            builtin_occupation_keys=BUILTIN_OCCUPATION_KEYS,
            updated_at=now_utc(),
        )
        if not records:
            await require_active_occupations(self, request.personal_space_id, [request.role, *request.tags])
            raise HTTPException(status_code=404, detail='active project Agent not found')
        return await self.get_project_agent(
            actor,
            request.personal_space_id,
            None,
            agent_id,
        )
