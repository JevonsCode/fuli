"""Each Agent's person-like name, unique within its personal space.

A new Agent is named when it is written (Bole's recruitment and direct
creation alike); an existing Agent keeps its name unless a person changes it.
A given name another Agent already uses is refused with free alternatives,
so the caller can choose another (in the person's naming style, when set).
A recruitment's proposed name is checked when it is proposed; one taken by
the time the Agent is provisioned falls back to a generated name. The naming
rules themselves live in project_agent_names.py.

The check reads the space's names before the write; the graph holds the rule
itself (AGENT_NAME_RULES): every Agent of the person, FULI's own roles
included, stores the identity key of its shown name, unique per space
(name_identity), so two writes racing for one name cannot both commit. A
role's built-in name is reserved by the check (renamed_profile), and so is
another Agent's 原名 while `#FLA` still reaches it by that name. An FLA that
already shared its name before this rule writes without a key (UNKEYED) until
the person settles the name (store_project_agent_name_fixes.py). A key an
older FULI left on an Agent it renamed no longer says its name; it is cleared
at start and whenever it blocks a write (clear_stale_name_keys).

A refusal names who is called that and where they work, and offers free names.
"""
import json
from datetime import UTC

from fastapi import HTTPException
from neo4j.exceptions import ConstraintError

from .name_identity import identity_key
from .project_agent_name_history import free_from, name_history, recent_change
from .project_agent_names import (
    NameTaken, agent_display_name, free_nicknames, new_agent_display_name, profile_shown_name, title_like,
    unique_nickname,
)
from .provider_values import now_utc
from .system_agents import SYSTEM_PROFILES
from .system_hr_identity import LEGACY_HR_AGENT_ID
from .temporary_project_scope import project_reference, stored_project_name

# FULI's own roles keep the names the Provider gives them.
SYSTEM_NAMED = frozenset({*SYSTEM_PROFILES, LEGACY_HR_AGENT_ID})


class SpaceNames(dict):
    """agent_id -> (role name, stored nickname) for every Agent of a space,
    archived ones included; ``former`` holds each Agent's latest rename while
    its old name is still its 原名 (project_agent_name_history.py)."""

    def __init__(self, names=(), former=None):
        super().__init__(names)
        self.former = dict(former or {})


async def space_agent_names(store, personal_space_id: str) -> SpaceNames:
    """Every Agent of the space, archived ones included, with recent 原名."""
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
              [:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent)
        RETURN agent.agent_id AS agent_id, agent.profile_json AS profile_json,
               agent.name_history_json AS name_history_json
        ''',
        personal_space_id=personal_space_id,
        routing_='r',
    )
    names, now = SpaceNames(), now_utc()
    for row in records:
        profile = json.loads(row['profile_json'] or '{}')
        names[row['agent_id']] = (profile.get('name') or '', profile.get('display_name'))
        change = recent_change(name_history(row.get('name_history_json')), now)
        if change:
            names.former[row['agent_id']] = change
    return names


def _former(names) -> dict:
    return names.former if isinstance(names, SpaceNames) else {}


def _taken(names, agent_id, *, former=True):
    """Every name another Agent is called by: its shown name, a built-in
    role's own name, which it still answers to after a rename, and a 原名,
    which `#FLA` still reaches for FORMER_NAME_DAYS (unless ``former`` is off)."""
    return {identity_key(agent_display_name(other, name, nickname))
            for other, (name, nickname) in names.items() if other != agent_id} | {
        identity_key(SYSTEM_PROFILES[other]().name) for other in SYSTEM_PROFILES if other != agent_id} | ({
        identity_key(change.name) for other, change in _former(names).items() if other != agent_id}
        if former else set())


def name_identity(personal_space_id: str, agent_id: str, profile) -> dict:
    """The stored identity of the Agent's shown name, which the graph keeps
    unique per space (AGENT_NAME_RULES). A built-in role stores the name it is
    shown by now too; its built-in one stays reserved by the check."""
    shown = agent_display_name(agent_id, profile.name, profile.display_name)
    return {'display_name_space_id': personal_space_id, 'display_name_key': identity_key(shown)}


# An FLA that shared its name with another before names were unique stores no
# identity on its writes until the person settles the name on the FLAs page
# (store_project_agent_name_fixes.py): the write itself goes through.
UNKEYED = {'display_name_space_id': None, 'display_name_key': None}


def lost_name_race(error: Exception) -> bool:
    """Whether a write failed because another Agent holds the same name identity."""
    return isinstance(error, ConstraintError) and 'display_name_key' in str(error)


async def clear_stale_name_keys(driver, personal_space_id: str | None = None, keys=None) -> int:
    """Clear stored name identities that no longer match the Agent's shown
    name, in every space or one, for every key or the given ones: FULI 22
    renames an Agent without updating its key, which would otherwise keep its
    old name from anyone else after an upgrade. Only the key fields change, and
    only over the profile read; the next write keys the Agent again."""
    records, _, _ = await driver.execute_query(
        '''
        MATCH (agent:FuliProjectAgent)
        WHERE agent.display_name_key IS NOT NULL
          AND ($space_id IS NULL OR agent.display_name_space_id = $space_id)
          AND ($keys IS NULL OR agent.display_name_key IN $keys)
        RETURN agent.agent_id AS agent_id, agent.display_name_space_id AS space_id,
               agent.display_name_key AS key, agent.profile_json AS profile_json
        ''',
        space_id=personal_space_id, keys=None if keys is None else list(keys), routing_='r',
    )
    stale = [dict(row) for row in records if identity_key(
        profile_shown_name(row['agent_id'], json.loads(row['profile_json'] or '{}'))) != row['key']]
    if not stale:
        return 0
    cleared, _, _ = await driver.execute_query(
        '''
        UNWIND $rows AS row
        MATCH (agent:FuliProjectAgent {agent_id: row.agent_id, display_name_space_id: row.space_id,
                                       display_name_key: row.key})
        WHERE coalesce(agent.profile_json, '') = coalesce(row.profile_json, '')
        SET agent.display_name_space_id = null, agent.display_name_key = null
        RETURN count(agent) AS cleared
        ''',
        rows=stale,
    )
    return cleared[0]['cleared'] if cleared else 0


def keeps_its_name(names, agent_id: str, display_name: str | None) -> bool:
    """Whether a write leaves an existing Agent called what it was: a clash on
    its identity then means an Agent that already shared the name, never a race."""
    if agent_id not in names:
        return False
    current = agent_display_name(agent_id, *names[agent_id])
    return identity_key(display_name or current) == identity_key(current)


async def name_taken(store, personal_space_id, names, agent_id, name, alternatives) -> HTTPException:
    """The refusal of a name someone else is called by: who, the projects they
    work in, and free names, as fields (the console reads them) and in one
    sentence (what an Agent reads)."""
    key = identity_key(name)
    holders = [other for other, (role, nickname) in names.items()
               if other != agent_id and identity_key(agent_display_name(other, role, nickname)) == key]
    holders += [other for other in SYSTEM_PROFILES if other != agent_id and other not in holders
                and identity_key(SYSTEM_PROFILES[other]().name) == key]
    # Someone whose 原名 it still is: free once that name stops being one.
    formerly = {other: change for other, change in _former(names).items()
                if other != agent_id and other not in holders and identity_key(change.name) == key}
    holders += list(formerly)
    projects = await _working_projects(store, personal_space_id, holders) if holders else {}
    used_by = [{'agent_id': other, 'name': _called(names, other), 'projects': projects.get(other, []),
                **({'former_name': formerly[other].name, 'free_from': _instant(free_from(formerly[other]))}
                   if other in formerly else {})}
               for other in holders]
    said = ' | '.join(f'{item["name"]} ({item["agent_id"]})'
                      + (f' in {", ".join(_referred(item["projects"]))}' if item['projects'] else '')
                      + (f', its former name, free after {item["free_from"]}' if 'free_from' in item else '')
                      for item in used_by)
    return HTTPException(409, {
        'code': 'agent_name_taken',
        'message': 'agent_name_taken: another Agent in this personal space already uses this name; '
                   + (f'used by: {said}; ' if said else '')
                   + f'free names: {", ".join(alternatives)}. Choose one or propose another.',
        'used_by': used_by, 'free_names': list(alternatives),
    })


def _instant(moment) -> str:
    """The exact time, with its offset: a date alone reads differently in
    each time zone, so the console shows it in the person's own."""
    moment = moment if moment.tzinfo else moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).isoformat(timespec='seconds')


def _called(names, agent_id):
    if agent_id in names:
        return agent_display_name(agent_id, *names[agent_id])
    return SYSTEM_PROFILES[agent_id]().name


async def _working_projects(store, personal_space_id, agent_ids) -> dict[str, list[str]]:
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-[:CONTAINS_PROJECT]->
              (project:FuliPersonalProject)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
              (:FuliProjectAgentAssignment {status: 'active'})-[:ASSIGNED_AGENT]->(agent:FuliProjectAgent)
        WHERE agent.agent_id IN $agent_ids
        RETURN agent.agent_id AS agent_id,
               collect(DISTINCT project {.project_id, .name, .scope_type, .profile_json}) AS projects
        ''',
        personal_space_id=personal_space_id, agent_ids=agent_ids, routing_='r',
    )
    return {row['agent_id']: working_projects(row['projects']) for row in records}


def working_projects(rows) -> list[dict]:
    """The projects an Agent works in, as fields the console names in its own
    language (a temporary project stores no name), in the order of how text
    FULI writes refers to them."""
    projects = [{'project_id': row['project_id'], 'name': stored_project_name(row.get('name'), row.get('profile_json')),
                 'scope_type': row.get('scope_type')} for row in rows]
    return sorted(projects, key=lambda item: (project_reference(item['project_id'], item['name']), item['project_id']))


def _referred(projects) -> list[str]:
    return [project_reference(item['project_id'], item['name']) for item in projects]


async def with_person_name(store, request, *, recruitment_id=None):
    """The upsert with the nickname it stores: generated for a new Agent (or
    its role name when that reads as a person and is free), kept when an
    update omits it, refused when it duplicates another's."""
    if request.agent_id in SYSTEM_NAMED:
        return request
    names = await space_agent_names(store, request.personal_space_id)
    taken = _taken(names, request.agent_id)
    profile = request.profile
    if request.agent_id not in names:
        try:
            nickname = new_agent_display_name(request.agent_id, profile.name, profile.display_name, taken)
        except NameTaken as error:
            if recruitment_id is None:
                raise await name_taken(store, request.personal_space_id, names, request.agent_id,
                                       profile.display_name, error.alternatives) from None
            nickname = unique_nickname(request.agent_id, taken)
    elif profile.display_name is None:
        nickname = names[request.agent_id][1]
    else:
        nickname = profile.display_name
        current = agent_display_name(request.agent_id, *names[request.agent_id])
        if identity_key(nickname) != identity_key(current) and identity_key(nickname) in taken:
            raise await name_taken(store, request.personal_space_id, names, request.agent_id, nickname,
                                   free_nicknames(request.agent_id, taken))
    return request.model_copy(update={'profile': profile.model_copy(update={'display_name': nickname})})


async def require_free_proposed_name(store, personal_space_id, agent_id, profile):
    """Refuse a recruitment whose proposed nickname another Agent uses, before
    anything is written, so the recruiter proposes another."""
    if not profile.display_name:
        return
    names = await space_agent_names(store, personal_space_id)
    try:
        new_agent_display_name(agent_id, profile.name, profile.display_name, _taken(names, agent_id))
    except NameTaken as error:
        raise await name_taken(store, personal_space_id, names, agent_id, profile.display_name,
                               error.alternatives) from None


async def with_rename_suggestion(store, record):
    """The record with a free nickname offered when its shown name reads as a job."""
    if (record.agent_id in SYSTEM_NAMED or record.profile.status == 'archived'
            or record.profile.agent_type in {'coordinator', 'hr'} or not title_like(record.profile.display_name)):
        return record
    names = await space_agent_names(store, record.personal_space_id)
    return record.model_copy(update={
        'name_suggestion': unique_nickname(record.agent_id, _taken(names, record.agent_id))})


def renamed_profile(names, agent_id: str, profile: dict, display_name: str | None) -> dict:
    """The stored profile with the name a person chose (rec#11 D-89).

    Every Agent can be renamed, FULI's own roles included; identity stays the
    agent_id. A role keeps its built-in name as a second name people may still
    call it by, so no other Agent may take that name, and None gives the role
    its built-in name back. Any other Agent always has a name of its own. A
    name someone else is called by raises NameTaken with free alternatives.
    """
    if display_name is None:
        if agent_id not in SYSTEM_PROFILES:
            raise HTTPException(422, 'agent_name_required: only a built-in role can go back to its own name')
        return {key: value for key, value in profile.items() if key != 'display_name'}
    taken = _taken(names, agent_id)
    # A change of case or spacing keeps the Agent's own name, even while it is
    # also another's 原名 (the one that kept a shared name, after a fix).
    checked = _taken(names, agent_id, former=False) if keeps_its_name(names, agent_id, display_name) else taken
    if identity_key(display_name) in checked:
        raise NameTaken(free_nicknames(agent_id, taken))
    return {**profile, 'display_name': display_name}
