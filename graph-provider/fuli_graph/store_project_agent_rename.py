"""A person renaming one Agent, FULI's own roles included (rec#11 D-89).

Only the shown name changes: identity, role, memory and history stay with the
agent_id, and the old name joins its name history (project_agent_name_history.py).
A name someone else is called by is refused with who that is, where they work
and free names. The naming rules live in store_project_agent_naming.py.
"""
import json

from fastapi import HTTPException
from neo4j.exceptions import ConstraintError

from .project_agent_models import (
    ProjectAgentNameChange, ProjectAgentProfile, ProjectAgentRecord, ProjectAgentRename, ProjectAgentRenamed,
)
from .project_agent_name_history import former_name, name_history, with_former_name
from .project_agent_names import NameTaken, agent_display_name
from .provider_values import now_utc
from .system_agents import SYSTEM_PROFILES
from .store_project_agent_naming import (
    lost_name_race, name_identity, name_taken, renamed_profile, space_agent_names,
)
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
            RETURN agent.profile_json AS profile_json, agent.name_history_json AS name_history_json
            ''',
            personal_space_id=request.personal_space_id,
            agent_id=agent_id,
            routing_='r',
        )
        if not records:
            raise HTTPException(status_code=404, detail='active project Agent not found')
        stored = records[0]['profile_json'] or '{}'
        before = json.loads(stored)
        try:
            profile = renamed_profile(names, agent_id, before, request.display_name)
        except NameTaken as error:
            raise await name_taken(self, request.personal_space_id, names, agent_id, request.display_name,
                                   error.alternatives) from None
        updated_at = now_utc()
        old_name = agent_display_name(agent_id, before.get('name') or '', before.get('display_name'))
        new_name = agent_display_name(agent_id, profile.get('name') or '', profile.get('display_name'))
        history = records[0]['name_history_json']
        if new_name != old_name:
            history = with_former_name(history, ProjectAgentNameChange(
                name=old_name, until=updated_at, reason='renamed'))
        validated = ProjectAgentProfile.model_validate(profile)
        # Written only over the profile just read, so a concurrent edit is never lost.
        try:
            written, _, _ = await self.runtime.driver.execute_query(
                '''
                MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
                      (agent:FuliProjectAgent {agent_id: $agent_id})
                WHERE agent.profile_json = $stored
                SET agent.profile_json = $profile_json, agent.name_history_json = $name_history_json,
                    agent.display_name_space_id = $display_name_space_id,
                    agent.display_name_key = $display_name_key, agent.updated_at = $updated_at
                RETURN agent.agent_id AS agent_id
                ''',
                personal_space_id=request.personal_space_id,
                agent_id=agent_id,
                stored=stored,
                profile_json=validated.model_dump_json(),
                name_history_json=history,
                updated_at=updated_at,
                **name_identity(request.personal_space_id, agent_id, validated),
            )
        except ConstraintError as error:
            if not lost_name_race(error):
                raise
            # Another Agent took this name between the check and the write.
            names = await space_agent_names(self, request.personal_space_id)
            try:
                renamed_profile(names, agent_id, before, request.display_name)
            except NameTaken as taken:
                raise await name_taken(self, request.personal_space_id, names, agent_id, request.display_name,
                                       taken.alternatives) from None
            raise HTTPException(409, 'agent_profile_changed: the Agent changed while it was renamed; '
                                     'try again') from None
        if not written:
            raise HTTPException(409, 'agent_profile_changed: the Agent changed while it was renamed; try again')
        return await self.get_project_agent(actor, request.personal_space_id, None, agent_id)

    async def list_agent_name_changes(self, actor: dict, personal_space_id: str) -> list[ProjectAgentRenamed]:
        """The Agents FULI renamed because another had their name, while the
        rename is recent (原名 still shown), newest first, each with who kept it."""
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'reader')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent)
            RETURN agent.agent_id AS agent_id, agent.profile_json AS profile_json, agent.status AS status,
                   agent.name_history_json AS name_history_json
            ''',
            personal_space_id=personal_space_id, routing_='r',
        )
        now = now_utc()
        shown, renamed = {}, []
        for row in records:
            profile = json.loads(row['profile_json'] or '{}')
            shown[row['agent_id']] = agent_display_name(row['agent_id'], profile.get('name') or '',
                                                        profile.get('display_name'))
            history = name_history(row['name_history_json'])
            if history and history[-1].reason == 'duplicate_name' and former_name(history, now):
                renamed.append((row, history[-1]))
        renamed.sort(key=lambda item: item[1].until, reverse=True)
        return [ProjectAgentRenamed(
            agent_id=row['agent_id'], display_name=shown[row['agent_id']], status=row['status'] or 'active',
            change=change, kept_by_name=shown.get(change.kept_by_agent_id) or (
                SYSTEM_PROFILES[change.kept_by_agent_id]().name if change.kept_by_agent_id in SYSTEM_PROFILES else None),
        ) for row, change in renamed]

