"""Settling the names FLAs of a space share, when the person chooses to.

The FLAs page shows the plan (project_agent_name_fixes.py): every shared name,
who keeps it, what the others become and why. The person may change who keeps
a name or leave a rename out, and one apply renames the rest at once, each
through the ordinary rename write (store_project_agent_rename.py) with the old
name in its history; an FLA is renamed back the same way, since its old name is
free again. Until then nothing changes and everything keeps working: a shared
name only makes `#FLA <name>` ask.

The plan reads the space once: names first, and only when some are shared the
work of those Agents, each figure summed in one query rather than per Agent.
"""
import json

from fastapi import HTTPException
from neo4j.exceptions import ConstraintError

from .name_identity import identity_key
from .project_agent_models import NameFixApply, NameFixPlan, ProjectAgentNameChange, WorkingProject
from .project_agent_name_fixes import NameHolder, called_by, name_fix_plan, shared_names
from .project_agent_name_history import name_history
from .project_agent_names import is_generated_nickname, profile_shown_name
from .provider_values import now_utc, stored_epoch
from .store_project_agent_naming import lost_name_race, working_projects
from .store_project_agent_rename import renamed_row, write_agent_names
from .temporary_project_scope import is_temporary_project

# A lead FULI hired by itself is put on its project through a hiring task;
# that task is no work of its own (default_project_lead.py).
_HIRING_TITLE = '接任项目负责人'

_NAMES = '''
MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
      (agent:FuliProjectAgent)
RETURN agent.agent_id AS agent_id, agent.profile_json AS profile_json, agent.status AS status,
       agent.test_source AS test_source, agent.cleanup_eligible AS cleanup_eligible,
       agent.name_history_json AS name_history_json, agent.created_at AS created_at,
       agent.updated_at AS updated_at
'''

_WORK = '''
MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
      (agent:FuliProjectAgent)
WHERE agent.agent_id IN $agent_ids
OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask)-[:HAS_PARTICIPANT]->(agent)
WHERE coalesce(task.staffing_intent, '') <> 'default_lead' AND coalesce(task.title, '') <> $hiring_title
WITH space, agent, count(DISTINCT task) AS tasks
OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]->(project:FuliPersonalProject)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
      (:FuliProjectAgentAssignment {status: 'active'})-[:ASSIGNED_AGENT]->(agent)
RETURN agent.agent_id AS agent_id, tasks,
       collect(DISTINCT project {.project_id, .name, .scope_type, .profile_json}) AS projects
'''

_TURNS = '''
MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
      (:FuliTaskContextSession)-[:HAS_CONTEXT]->(turn:FuliTaskContext)
WHERE turn.project_agent_id IN $agent_ids
RETURN turn.project_agent_id AS agent_id, count(DISTINCT turn) AS turns, max(turn.created_at) AS last_turn
'''


class StoreProjectAgentNameFixes:
    async def agent_name_fix_plan(self, actor: dict, personal_space_id: str, keep: list[str]) -> NameFixPlan:
        """How the names FLAs share would be settled; reading it changes nothing."""
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'reader')
        groups = name_fix_plan(await self._name_holders(personal_space_id), frozenset(keep))
        return NameFixPlan(groups=groups, renames=sum(not member.keeps for group in groups
                                                      for member in group.members))

    async def apply_agent_name_fixes(self, actor: dict, request: NameFixApply) -> NameFixPlan:
        """Renames exactly the FLAs the person agreed to, to the names they saw,
        all at once; anything changed since they looked refuses the whole apply."""
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        stored = {}
        holders = await self._name_holders(request.personal_space_id, stored)
        groups = name_fix_plan(holders, frozenset(request.keep))
        planned = {member.agent_id: (group, member) for group in groups for member in group.members
                   if not member.keeps}
        if any(planned.get(agent_id, (None, None))[1] is None
               or planned[agent_id][1].new_name != name for agent_id, name in request.renames.items()):
            raise _changed('the FLAs or their names changed since the list was read')
        until = now_utc()
        rows = []
        for agent_id in sorted(request.renames):
            group, member = planned[agent_id]
            profile_json, history_json = stored[agent_id]
            profile = json.loads(profile_json or '{}')
            keeper = next(item for item in group.members if item.keeps)
            rows.append(renamed_row(request.personal_space_id, agent_id, profile_json or '{}', history_json,
                                    {**profile, 'display_name': member.new_name},
                                    ProjectAgentNameChange(name=member.name, until=until, reason='duplicate_name',
                                                           kept_by_agent_id=keeper.agent_id,
                                                           gave_way=member.gave_way)))
        try:
            written = await write_agent_names(self.runtime.driver, request.personal_space_id, rows, until)
        except ConstraintError as error:
            if not lost_name_race(error):
                raise
            written = False
        if not written:
            raise _changed('an FLA changed while its name was settled')
        await self._key_keepers(request.personal_space_id, [
            item for group in groups for item in group.members if item.keeps])
        return await self.agent_name_fix_plan(actor, request.personal_space_id, request.keep)

    async def _key_keepers(self, personal_space_id: str, keepers) -> None:
        """The FLA that keeps a name now holds it in the graph too, unless another
        still shares it (a rename the person left out)."""
        await self.runtime.driver.execute_query(
            '''
            UNWIND $rows AS row
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: row.agent_id})
            WHERE agent.display_name_key IS NULL
              AND NOT EXISTS {
                MATCH (other:FuliProjectAgent {display_name_space_id: $personal_space_id,
                                               display_name_key: row.key})
              }
            SET agent.display_name_space_id = $personal_space_id, agent.display_name_key = row.key
            ''',
            personal_space_id=personal_space_id,
            rows=[{'agent_id': item.agent_id, 'key': identity_key(item.name)} for item in keepers],
        )

    async def _name_holders(self, personal_space_id: str, stored: dict | None = None) -> list[NameHolder]:
        """Every Agent of the space as the plan reads it; the work figures only
        for Agents that share a name. ``stored`` collects each one's profile and
        history as read, for a write over exactly that."""
        driver = self.runtime.driver
        records, _, _ = await driver.execute_query(_NAMES, personal_space_id=personal_space_id, routing_='r')
        rows = {}
        for record in records:
            profile = json.loads(record['profile_json'] or '{}')
            shown = profile_shown_name(record['agent_id'], profile)
            rows[record['agent_id']] = (record, profile, shown)
            if stored is not None:
                stored[record['agent_id']] = (record['profile_json'], record['name_history_json'])
        sharing = {holder.agent_id for group in shared_names(
            [NameHolder(agent_id, shown, names=called_by(agent_id, shown))
             for agent_id, (_, _, shown) in rows.items()]).values() for holder in group}
        if not sharing:
            return []
        ids = sorted(sharing)
        work, _, _ = await driver.execute_query(_WORK, personal_space_id=personal_space_id, agent_ids=ids,
                                                hiring_title=_HIRING_TITLE, routing_='r')
        turns, _, _ = await driver.execute_query(_TURNS, personal_space_id=personal_space_id, agent_ids=ids,
                                                 routing_='r')
        work = {row['agent_id']: row for row in work}
        turns = {row['agent_id']: row for row in turns}
        holders = []
        for agent_id in ids:
            record, profile, shown = rows[agent_id]
            history = name_history(record['name_history_json'])
            projects = working_projects((work.get(agent_id) or {}).get('projects') or [])
            turned = turns.get(agent_id) or {}
            holders.append(NameHolder(
                agent_id=agent_id, name=shown, status=record['status'] or 'active',
                test=bool(record['test_source'] or record['cleanup_eligible']),
                person_named=bool(history and history[-1].reason == 'renamed') or not is_generated_nickname(shown),
                temporary_only=bool(projects) and all(
                    is_temporary_project(item['project_id'], item['scope_type'], item['name'])
                    for item in projects),
                work=int((work.get(agent_id) or {}).get('tasks') or 0) + int(turned.get('turns') or 0),
                recent=max(stored_epoch(turned.get('last_turn')), stored_epoch(record['updated_at'])),
                created=stored_epoch(record['created_at']),
                projects=tuple(WorkingProject(**item) for item in projects),
                names=called_by(agent_id, shown)))
        return holders


def _changed(why: str) -> HTTPException:
    return HTTPException(409, {'code': 'agent_name_fixes_changed',
                               'message': f'agent_name_fixes_changed: {why}; read the list again'})

