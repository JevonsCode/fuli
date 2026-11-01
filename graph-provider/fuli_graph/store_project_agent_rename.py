"""A person renaming one Agent, FULI's own roles included (rec#11 D-89).

Only the shown name changes: identity, role, memory and history stay with the
agent_id. The naming rules live in store_project_agent_naming.py.
"""
import json

from fastapi import HTTPException

from .project_agent_models import ProjectAgentProfile, ProjectAgentRecord, ProjectAgentRename
from .provider_values import now_utc
from .store_project_agent_naming import renamed_profile, space_agent_names
from .system_hr_identity import resolve_hr_alias


class StoreProjectAgentRename:
    async def rename_project_agent(
        self,
        actor: dict,
        agent_id: str,
        request: ProjectAgentRename,
    ) -> ProjectAgentRecord:
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        agent_id = await resolve_hr_alias(self, request.personal_space_id, agent_id)
        names = await space_agent_names(self, request.personal_space_id)
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            WHERE coalesce(agent.status, 'active') <> 'archived'
            RETURN agent.profile_json AS profile_json
            ''',
            personal_space_id=request.personal_space_id,
            agent_id=agent_id,
            routing_='r',
        )
        if not records:
            raise HTTPException(status_code=404, detail='active project Agent not found')
        stored = records[0]['profile_json'] or '{}'
        profile = renamed_profile(names, agent_id, json.loads(stored), request.display_name)
        # Written only over the profile just read, so a concurrent edit is never lost.
        written, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            WHERE agent.profile_json = $stored
            SET agent.profile_json = $profile_json, agent.updated_at = $updated_at
            RETURN agent.agent_id AS agent_id
            ''',
            personal_space_id=request.personal_space_id,
            agent_id=agent_id,
            stored=stored,
            profile_json=ProjectAgentProfile.model_validate(profile).model_dump_json(),
            updated_at=now_utc(),
        )
        if not written:
            raise HTTPException(409, 'agent_profile_changed: the Agent changed while it was renamed; try again')
        return await self.get_project_agent(actor, request.personal_space_id, None, agent_id)
