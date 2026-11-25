"""A person renaming one Agent, FULI's own roles included (rec#11 D-89), and
the list of every rename in a space.

Only the shown name changes: identity, role, memory and history stay with the
agent_id, and the old name joins its name history (project_agent_name_history.py).
A name someone else is called by is refused with who that is, where they work
and free names. The naming rules live in store_project_agent_naming.py.
"""
import json

from fastapi import HTTPException
from neo4j.exceptions import ConstraintError

from .project_agent_models import (
    ProjectAgentNameChange, ProjectAgentNameChanges, ProjectAgentNameChangesSeen, ProjectAgentProfile,
    ProjectAgentRecord, ProjectAgentRename, ProjectAgentRenamed,
)
from .project_agent_name_history import name_history, with_former_name
from .project_agent_names import NameTaken, profile_shown_name
from .project_write_gate import project_targets
from .provider_values import native_datetime, now_utc
from .replica_write_guard import refuse_global_write
from .system_agents import SYSTEM_PROFILES
from .store_project_agent_naming import (
    clear_stale_name_keys, lost_name_race, name_identity, name_taken, renamed_profile, space_agent_names,
)
from .system_hr_identity import resolve_hr_alias

# The most renames the list returns, newest first.
NAME_CHANGES_LIMIT = 200


def renamed_row(personal_space_id: str, agent_id: str, stored: str, history_json: str | None,
                profile: dict, change: ProjectAgentNameChange | None) -> dict:
    """One Agent's new name as write_agent_names stores it: over the profile
    read (``stored``), with the old name in its history when the name changed."""
    validated = ProjectAgentProfile.model_validate(profile)
    return {'agent_id': agent_id, 'stored': stored, 'profile_json': validated.model_dump_json(),
            'name_history_json': with_former_name(history_json, change) if change else history_json,
            **name_identity(personal_space_id, agent_id, validated)}


async def write_agent_names(driver, personal_space_id: str, rows: list[dict], updated_at) -> bool:
    """Every row's name at once, or none: each lands only over the profile it
    was read from, so a concurrent edit is never lost. A name another Agent took
    meanwhile raises the graph's ConstraintError; one held only by a key that
    no longer says its Agent's name (clear_stale_name_keys) is freed and the
    write tried once more."""
    try:
        return await _write_agent_names(driver, personal_space_id, rows, updated_at)
    except ConstraintError as error:
        if not lost_name_race(error) or not await clear_stale_name_keys(
                driver, personal_space_id, [row['display_name_key'] for row in rows if row['display_name_key']]):
            raise
    return await _write_agent_names(driver, personal_space_id, rows, updated_at)


async def _write_agent_names(driver, personal_space_id: str, rows: list[dict], updated_at) -> bool:
    records, _, _ = await driver.execute_query(
        '''
        UNWIND $rows AS row
        MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
              (agent:FuliProjectAgent {agent_id: row.agent_id})
        WHERE agent.profile_json = row.stored
        WITH collect({agent: agent, row: row}) AS hits
        WHERE size(hits) = $count
        UNWIND hits AS hit
        WITH hit.agent AS agent, hit.row AS row
        SET agent.profile_json = row.profile_json, agent.name_history_json = row.name_history_json,
            agent.display_name_space_id = row.display_name_space_id,
            agent.display_name_key = row.display_name_key, agent.updated_at = $updated_at
        RETURN count(agent) AS written
        ''',
        personal_space_id=personal_space_id, rows=rows, count=len(rows), updated_at=updated_at,
    )
    return bool(records) and records[0]['written'] == len(rows)


class StoreProjectAgentRename:
    async def rename_project_agent(
        self,
        actor: dict,
        agent_id: str,
        request: ProjectAgentRename,
    ) -> ProjectAgentRecord:
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        refuse_global_write(self, "an FLA's name")
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
        old_name, new_name = profile_shown_name(agent_id, before), profile_shown_name(agent_id, profile)
        change = ProjectAgentNameChange(name=old_name, until=updated_at, reason='renamed') \
            if new_name != old_name else None
        row = renamed_row(request.personal_space_id, agent_id, stored, records[0]['name_history_json'],
                          profile, change)
        try:
            with project_targets(request.personal_space_id, []):
                written = await write_agent_names(self.runtime.driver, request.personal_space_id, [row], updated_at)
        except ConstraintError as error:
            if not lost_name_race(error):
                raise
            # Another Agent took this name between the check and the write.
            names = await space_agent_names(self, request.personal_space_id)
            try:
                renamed_profile(names, agent_id, before, request.display_name)
            except NameTaken as taken:
                raise await name_taken(self, request.personal_space_id, names, agent_id,
                                       request.display_name, taken.alternatives) from None
            written = False
        if not written:
            raise HTTPException(409, 'agent_profile_changed: the Agent changed while it was renamed; try again')
        return await self.get_project_agent(actor, request.personal_space_id, None, agent_id)

    async def list_agent_name_changes(self, actor: dict, personal_space_id: str) -> ProjectAgentNameChanges:
        """Every rename in the space, newest first: a person's, and each name the
        person settled for FLAs that shared it (with who kept it and why), and up
        to when the person has seen the latter."""
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'reader')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent)
            RETURN space.agent_renames_seen_at AS seen_until,
                   collect({agent_id: agent.agent_id, profile_json: agent.profile_json, status: agent.status,
                            name_history_json: agent.name_history_json}) AS agents
            ''',
            personal_space_id=personal_space_id, routing_='r',
        )
        agents = [row for row in (records[0]['agents'] if records else []) if row['agent_id']]
        shown = {row['agent_id']: profile_shown_name(row['agent_id'], json.loads(row['profile_json'] or '{}'))
                 for row in agents}
        changes = sorted(((row, change) for row in agents for change in name_history(row['name_history_json'])),
                         key=lambda item: item[1].until, reverse=True)[:NAME_CHANGES_LIMIT]
        return ProjectAgentNameChanges(
            seen_until=native_datetime(records[0]['seen_until']) if records else None,
            items=[ProjectAgentRenamed(
                agent_id=row['agent_id'], display_name=shown[row['agent_id']], status=row['status'] or 'active',
                change=change, kept_by_name=shown.get(change.kept_by_agent_id) or (
                    SYSTEM_PROFILES[change.kept_by_agent_id]().name
                    if change.kept_by_agent_id in SYSTEM_PROFILES else None),
            ) for row, change in changes])

    async def mark_agent_name_changes_seen(self, actor: dict,
                                           request: ProjectAgentNameChangesSeen) -> ProjectAgentNameChanges:
        """The person has seen the settled names up to ``until`` (知道了 on the
        FLAs page): stored with the space, so every console agrees."""
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            WHERE space.agent_renames_seen_at IS NULL OR space.agent_renames_seen_at < $until
            SET space.agent_renames_seen_at = $until
            ''',
            personal_space_id=request.personal_space_id, until=request.until,
        )
        return await self.list_agent_name_changes(actor, request.personal_space_id)
