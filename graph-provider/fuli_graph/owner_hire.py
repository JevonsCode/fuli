"""The owner of `global` makes the FLA a follower's project recruited
(docs/runner-roles-design.md §12; global_replica.RECRUITMENT_ON_OWNER).

The roster is `global`, so a computer whose `global` is a copy never makes an
FLA: its project keeps the recruitment and waits, and asks the computer it
follows to make the FLA under the recruitment's proposed agent_id. The next copy
of `global` brings the FLA back, and the follower finishes its recruitment with
its own records (replica_recruitment_completion.py).

Here only the FLA is made, never changed: made once, with what a single computer
writes on an FLA when it hires (occupation, recruitment, when and why, and where
the recruitment came from); asked again for the same recruitment, the same FLA
is answered; an agent_id another FLA holds is refused, as is a name another FLA
is called by (the person cancels that recruitment and recruits again). No
recruitment record is made here: the recruitment is the follower's project's.
"""
from typing import Literal
from unicodedata import category

from fastapi import HTTPException
from pydantic import Field, field_validator, model_validator

from .fixed_roles import SYSTEM_ROLE_AGENT_IDS
from .model_base import StrictModel
from .models import SourceApplication
from .name_identity import display_name
from .project_agent_employee_numbers import EMPLOYEE_NUMBER_LOCK
from .project_agent_models import ProjectAgentProfile, ProjectAgentRecord, ProjectAgentUpsert
from .project_agent_occupation_models import ProjectAgentOccupationInput
from .project_write_gate import project_targets
from .provider_values import now_utc, stable_uuid
from .replica_write_guard import refuse_global_write
from .store_occupation_catalog import require_active_occupations
from .store_project_agent_naming import require_free_proposed_name
from .store_transactions import query_store_transaction
from .system_hr_identity import LEGACY_HR_AGENT_ID

# What only the Provider makes, never a hire.
RESERVED_AGENT_IDS = frozenset({*SYSTEM_ROLE_AGENT_IDS, LEGACY_HR_AGENT_ID})


class OwnerHireRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    # The follower's recruitment and the agent_id it proposed (both stable_uuid under the shared provider_id).
    recruitment_id: str = Field(min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    task_id: str | None = Field(default=None, min_length=1, max_length=128)
    recruitment_source_application: SourceApplication | None = None
    profile: ProjectAgentProfile
    occupation: ProjectAgentOccupationInput
    reason: str = Field(min_length=1, max_length=2048)
    # Where the recruitment came from, as the roster shows it: the follower's
    # device name from the host's pairing record, and the project name it reported.
    origin_computer: str = Field(min_length=1, max_length=128)
    origin_project: str = Field(min_length=1, max_length=256)
    # The follower's certificate fingerprint: which computer it was, whatever it is called later.
    origin_fingerprint: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')

    @field_validator('profile')
    @classmethod
    def an_ordinary_fla(cls, profile: ProjectAgentProfile) -> ProjectAgentProfile:
        # The coordinator and HR types belong to the fixed roles alone.
        if profile.agent_type not in ('durable', 'temporary'):
            raise ValueError('a hire is a durable or temporary FLA')
        if profile.status != 'active' or profile.test_source is not None or profile.cleanup_eligible:
            raise HTTPException(422, {'code': 'invalid_hire_profile',
                                      'message': 'An owner hire requires an active, non-test FLA.'})
        return profile

    @model_validator(mode='after')
    def temporary_task_required(self):
        if self.profile.agent_type == 'temporary' and not (self.task_id or '').strip():
            raise HTTPException(422, {'code': 'temporary_task_required',
                                      'message': 'A temporary FLA needs the task it belongs to.'})
        return self


class OwnerHireResult(StrictModel):
    outcome: Literal['created', 'existing']
    agent: ProjectAgentRecord


def _origin(request: OwnerHireRequest) -> str:
    """Where the recruitment came from, kept in the FLA's recruitment reason (no field of its own)."""
    computer = request.origin_computer + (f'（{request.origin_fingerprint}）' if request.origin_fingerprint else ' ')
    origin = f'来自 {computer}的项目 {request.origin_project} 的招聘：{request.reason}'
    return display_name(''.join(' ' if category(char) in {'Cc', 'Cf', 'Cs'} else char for char in origin))[:4096]


async def hire_for_owner_recruitment(store, actor, request: OwnerHireRequest) -> OwnerHireResult:
    await _authorized(store, actor, request.personal_space_id)
    refuse_global_write(store, 'an FLA of the roster')
    if request.agent_id in RESERVED_AGENT_IDS:
        raise HTTPException(409, {
            'code': 'agent_id_reserved',
            'message': f'{request.agent_id} is one of FULI\'s fixed roles, never hired. Nothing was written. '
                       '这是 FULI 的固定角色，不能招聘。'})
    # Only the roster is written, and the roster is `global`: no project's
    # records change, however many copies or frozen projects this graph holds.
    with project_targets(request.personal_space_id, []):
        async with query_store_transaction(store) as scoped:
            held = await _held_agent(scoped, request)
            if held is not None:
                if held['recruitment_id'] != request.recruitment_id:
                    raise HTTPException(409, {
                        'code': 'agent_id_taken',
                        'message': f'Another FLA already has agent_id {request.agent_id}; this recruitment cannot '
                                   'make it. Nothing was written. 这个 agent_id 已属于另一位 FLA，没有建。'})
                if held['status'] == 'archived':
                    raise HTTPException(409, {'code': 'agent_archived',
                                              'message': 'The FLA made for this recruitment has been archived.'})
                created = False
            else:
                await require_active_occupations(scoped, request.personal_space_id,
                                                 [request.occupation.role, *request.occupation.tags])
                await require_free_proposed_name(scoped, request.personal_space_id, request.agent_id, request.profile)
                await scoped.upsert_project_agent(actor, ProjectAgentUpsert(
                    personal_space_id=request.personal_space_id, agent_id=request.agent_id,
                    profile=request.profile, occupation=request.occupation,
                ), recruitment_id=request.recruitment_id)
                await _record_hire(scoped, request)
                created = True
    agent = await store.get_project_agent(actor, request.personal_space_id, None, request.agent_id)
    return OwnerHireResult(outcome='created' if created else 'existing', agent=agent)


async def _authorized(store, actor, personal_space_id) -> None:
    """Who may hire here, said with a code: the caller tells every refusal from
    a Provider too old to have this route (a 404 without one)."""
    try:
        store._require_personal()
        await store.authorize(actor, personal_space_id, 'maintainer')
    except HTTPException as error:
        if isinstance(error.detail, dict):
            raise
        code = 'space_access_denied' if error.status_code == 403 else 'personal_provider_required'
        raise HTTPException(error.status_code, {'code': code, 'message': str(error.detail)}) from None


async def _held_agent(scoped, request) -> dict | None:
    """None when no FLA holds the agent_id yet, else its recruitment and current status.
    Under the space's employee-number lock, which every FLA's creation takes, so two
    hires of one agent_id never both find it free."""
    records, _, _ = await scoped.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
        ''' + EMPLOYEE_NUMBER_LOCK + '''
        OPTIONAL MATCH (agent:FuliProjectAgent {id: $id})
        RETURN agent IS NOT NULL AS found, agent.status AS status, coalesce(agent.recruitment_id, '') AS recruitment_id
        ''',
        personal_space_id=request.personal_space_id,
        id=stable_uuid(scoped.settings.provider_id, request.personal_space_id, 'project-agent', request.agent_id),
    )
    return dict(records[0]) if records[0]['found'] else None


async def _record_hire(scoped, request) -> None:
    """What a single computer writes on its FLA when it finishes a hire
    (store_recruitment_fulfillment.py), written by the owner as it makes the FLA.
    A temporary FLA keeps the task binding it needs on the follower."""
    await scoped.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
              (agent:FuliProjectAgent {agent_id: $agent_id})
        SET agent.occupation_role = $occupation_role,
            agent.occupation_tags = $occupation_tags,
            agent.occupation_updated_at = $updated_at,
            agent.occupation_recruitment_id = $recruitment_id,
            agent.recruitment_id = $recruitment_id,
            agent.recruited_at = $updated_at,
            agent.recruitment_reason = $recruitment_reason,
            agent.recruitment_source_application = $source_application,
            agent.temporary_task_id = $temporary_task_id
        ''',
        personal_space_id=request.personal_space_id, agent_id=request.agent_id,
        occupation_role=request.occupation.role, occupation_tags=request.occupation.tags,
        recruitment_id=request.recruitment_id, recruitment_reason=_origin(request),
        updated_at=now_utc(), source_application=request.recruitment_source_application,
        temporary_task_id=request.task_id if request.profile.agent_type == 'temporary' else None,
    )


def register_owner_hire_route(application, store, Actor) -> None:
    # For the console's own process on the owner of `global`, delivering a
    # follower's recruitment; no Agent tool reaches it.
    @application.post('/v1/project-agents/owner-hire', response_model=OwnerHireResult)
    async def owner_hire(request: OwnerHireRequest, actor: Actor) -> OwnerHireResult:
        return await hire_for_owner_recruitment(store, actor, request)
