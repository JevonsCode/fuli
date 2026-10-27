"""Each Agent's person-like name, unique within its personal space.

A new Agent is named when it is written (Bole's recruitment and direct
creation alike); an existing Agent keeps its name unless a person changes it.
A given name another Agent already uses is refused with free alternatives,
so the caller can choose another (in the person's naming style, when set).
A recruitment's proposed name is checked when it is proposed; one taken by
the time the Agent is provisioned falls back to a generated name. The naming
rules themselves live in project_agent_names.py.
"""
import json

from fastapi import HTTPException

from .name_identity import identity_key
from .project_agent_names import (
    NameTaken, agent_display_name, free_nicknames, new_agent_display_name, title_like, unique_nickname,
)
from .system_agents import SYSTEM_PROFILES
from .system_hr_identity import LEGACY_HR_AGENT_ID

# FULI's own roles keep the names the Provider gives them.
SYSTEM_NAMED = frozenset({*SYSTEM_PROFILES, LEGACY_HR_AGENT_ID})


async def space_agent_names(store, personal_space_id: str) -> dict[str, tuple[str, str | None]]:
    """Every Agent of the space, archived ones included: agent_id -> (role name, stored nickname)."""
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
              [:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent)
        RETURN agent.agent_id AS agent_id, agent.profile_json AS profile_json
        ''',
        personal_space_id=personal_space_id,
        routing_='r',
    )
    names = {}
    for row in records:
        profile = json.loads(row['profile_json'] or '{}')
        names[row['agent_id']] = (profile.get('name') or '', profile.get('display_name'))
    return names


def _taken(names, agent_id):
    return {identity_key(agent_display_name(other, name, nickname))
            for other, (name, nickname) in names.items() if other != agent_id}


def _name_taken(alternatives):
    return HTTPException(409, 'agent_name_taken: another Agent in this personal space already uses this name; '
                              f'free names: {", ".join(alternatives)}. Choose one or propose another.')


async def with_person_name(store, request, *, recruitment_id=None):
    """The upsert with the nickname it stores: generated or numbered for a new
    Agent, kept when an update omits it, refused when it duplicates another's."""
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
                raise _name_taken(error.alternatives) from None
            nickname = unique_nickname(request.agent_id, taken)
    elif profile.display_name is None:
        nickname = names[request.agent_id][1]
    else:
        nickname = profile.display_name
        current = agent_display_name(request.agent_id, *names[request.agent_id])
        if identity_key(nickname) != identity_key(current) and identity_key(nickname) in taken:
            raise _name_taken(free_nicknames(request.agent_id, taken))
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
        raise _name_taken(error.alternatives) from None


async def with_rename_suggestion(store, record):
    """The record with a free nickname offered when its shown name reads as a job."""
    if (record.agent_id in SYSTEM_NAMED or record.profile.status == 'archived'
            or record.profile.agent_type in {'coordinator', 'hr'} or not title_like(record.profile.display_name)):
        return record
    names = await space_agent_names(store, record.personal_space_id)
    return record.model_copy(update={
        'name_suggestion': unique_nickname(record.agent_id, _taken(names, record.agent_id))})
