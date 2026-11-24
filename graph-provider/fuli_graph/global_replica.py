"""A graph whose `global` is a read-only copy of another computer's
(docs/runner-roles-design.md D1, §12 "A follower adopts the host's space ID").

On a follower `global` has one owner, the computer it follows; Node says so
at every start of this Provider (config.global_replica, from its routes
store). Then nothing here writes a default record of `global`: the system
FLAs, the recruitment policy and the tidy-ups on them come with the owner's
copy (scope_import.py), and until the first copy arrives a call that needs
them is told so, never answered with an internal error.

The defaults are the one exception to "a copy never covers this computer's
own records": a graph that made them before it knew (a Provider started
before it was a follower's, a retry after a failure midway) hands them to
the first copy of `global` (is_system_default).
"""
from fastapi import HTTPException

from .fixed_roles import SYSTEM_ROLE_AGENT_IDS
from .provider_values import stable_uuid

# The relationships the defaults are hung on the space by, and handed over with them.
DEFAULT_LINKS = frozenset({'HAS_PROJECT_AGENT_IDENTITY', 'HAS_PROJECT_AGENT_RECRUITMENT_POLICY'})


def is_system_default(label: str, properties: dict, space_id: str, provider_id: str) -> bool:
    """A record only the Provider itself makes, under an ID it derives:

    - a fixed role (FuliProjectAgent): agent_id one of SYSTEM_ROLE_AGENT_IDS,
      system_managed true, and id = stable_uuid(provider_id, space_id,
      'project-agent', agent_id), as ensure_system_identity makes it. Only
      ensure_system_identity sets system_managed true; an FLA the person hires
      is created with system_managed false (upsert_project_agent), and no
      other agent_id derives this id. The person can edit a fixed role's
      profile, but not on a graph whose `global` is a copy: there every call
      that writes `global` goes to its owner, so what such a role holds here
      is what the defaults wrote;
    - the space's recruitment policy (FuliProjectAgentRecruitmentPolicy of
      this personal_space_id): made only by the start's MERGE, and nothing
      but that MERGE ever writes one.

    Callers check it only while `global` is a copy (config.global_replica).
    """
    if label == 'FuliProjectAgent':
        agent_id = properties.get('agent_id')
        return (agent_id in SYSTEM_ROLE_AGENT_IDS and properties.get('system_managed') is True
                and properties.get('id') == stable_uuid(provider_id, space_id, 'project-agent', agent_id))
    if label == 'FuliProjectAgentRecruitmentPolicy':
        return properties.get('personal_space_id') == space_id
    return False


async def require_synced_global(store, space_id: str) -> None:
    """While `global` is a copy, the fixed roles are read, never made: a call
    that needs them before the first copy arrived is told so (409)."""
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
              (agent:FuliProjectAgent)
        WHERE agent.agent_id IN $roles
        RETURN count(DISTINCT agent.agent_id) AS roles
        ''',
        space_id=space_id, roles=list(SYSTEM_ROLE_AGENT_IDS), routing_='r',
    )
    if records and records[0]['roles'] == len(SYSTEM_ROLE_AGENT_IDS):
        return
    raise HTTPException(status_code=409, detail={
        'code': 'global_not_synced',
        'message': 'Global (habits, the FLA roster, the fixed roles) belongs to the computer this one follows and '
                   'has not been copied here from it yet. Calls that go to that computer are not affected. '
                   '全局（习惯、FLA 名册、固定角色）归跟随的那台电脑，还没从它同步过来；转发到那台电脑的调用不受影响。'})
