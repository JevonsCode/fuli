from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from fuli_graph.project_agent_occupation_models import ProjectAgentOccupationUpdate
from fuli_graph.project_agent_recruitment_occupation import recruitment_occupation
from fuli_graph.default_project_lead import default_lead_profile
from fuli_graph.store_project_agent_occupation import occupation_from_agent_node
from fuli_graph.store_project_agents import StoreProjectAgents
from fuli_graph.project_agent_models import ProjectAgentAssignmentCreate, ProjectAgentUpsert
from fuli_graph.system_agents import SYSTEM_PROFILES, ensure_system_identity


@pytest.mark.parametrize('role', [None, ''])
def test_occupation_requires_primary_role(role):
    with pytest.raises(ValidationError):
        ProjectAgentOccupationUpdate(personal_space_id='space', role=role)


@pytest.mark.parametrize('role', ['lead', 'assistant'])
def test_occupation_supports_new_roles(role):
    assert ProjectAgentOccupationUpdate(personal_space_id='space', role=role).role == role


def test_legacy_unclassified_occupation_remains_readable():
    assert occupation_from_agent_node({'occupation_updated_at': datetime.now(UTC)}) is None


def test_default_lead_delegates_instead_of_claiming_implementation_skills():
    profile = default_lead_profile('Synthetic')
    assert 'implementation' not in profile.work_kinds
    assert '代码实现' not in profile.capabilities
    assert {'planning', 'delegation', 'integration', 'reporting'} <= set(profile.work_kinds)


@pytest.mark.asyncio
async def test_assistant_is_fourth_builtin_with_task_only_memory():
    assert 'employee.assistant' in SYSTEM_PROFILES
    driver = SimpleNamespace(execute_query=AsyncMock(return_value=([], None, None)))
    await ensure_system_identity(driver, 'provider', 'space', 'employee.assistant')
    written = driver.execute_query.call_args_list[1]
    assert written.kwargs['memory_scope'] == 'task_only'
    assert written.kwargs['occupation_role'] == 'assistant'


@pytest.mark.asyncio
async def test_assistant_cannot_be_assigned_or_recruited():
    store = StoreProjectAgents()
    store._require_personal = lambda: None
    store.authorize = AsyncMock(side_effect=AssertionError('must reject before any graph access'))
    with pytest.raises(HTTPException, match='global'):
        await store.create_project_agent_assignment({}, ProjectAgentAssignmentCreate(
            personal_space_id='space', personal_project_id='project', agent_id='employee.assistant',
            idempotency_key='assign-assistant', responsibility='Help', reason='test',
        ))
    with pytest.raises(HTTPException, match='system'):
        await store.upsert_project_agent({}, ProjectAgentUpsert(
            personal_space_id='space', agent_id='employee.assistant',
            profile={'name': 'Assistant', 'responsibility': 'Help'},
        ), recruitment_id='recruit')


def test_recruitment_requires_explicit_occupation_and_default_lead_is_lead():
    from fuli_graph.project_agent_task_models import ProjectAgentTaskSubmit
    from fuli_graph.store_project_agent_task_recruitment import StoreProjectAgentTaskRecruitment
    request = ProjectAgentTaskSubmit(
        personal_space_id='space', personal_project_id='project', idempotency_key='test-recruit',
        title='Build', objective='Build the sample', work_kind='custom-work', routing_reason='test',
    )
    with pytest.raises(HTTPException, match='occupation'):
        StoreProjectAgentTaskRecruitment._normalized_recruitment_profile(request)
    explicit = ProjectAgentTaskSubmit.model_validate({**request.model_dump(),
        'recruitment_occupation': {'role': 'engineering'}})
    assert StoreProjectAgentTaskRecruitment._normalized_recruitment_profile(explicit)[0] == 'durable'
    lead = request.model_copy(update={'staffing_intent': 'default_lead'})
    assert StoreProjectAgentTaskRecruitment._normalized_recruitment_profile(lead)[0] == 'durable'


@pytest.mark.asyncio
async def test_recruitment_commits_role_and_audit_together():
    from fuli_graph.store_project_agent_task_recruitment import StoreProjectAgentTaskRecruitment
    store = StoreProjectAgentTaskRecruitment()
    store.runtime = SimpleNamespace(driver=SimpleNamespace(execute_query=AsyncMock(return_value=([{'recruitment': {}}], None, None))))
    store.upsert_project_agent = AsyncMock()
    store.create_project_agent_assignment = AsyncMock()
    store._assignment_candidates = AsyncMock(return_value=[{'agent_id': 'new-agent'}])
    # A temporary worker bypasses permanent team enrollment.
    raw = dict(personal_space_id='space', personal_project_id='project', proposed_agent_id='new-agent',
               recruitment_id='recruit', provisioning_claim_id='claim', reason='test', work_kind='implementation',
               occupation_role='engineering', occupation_tags=['testing'],
               proposed_profile_json='{"name":"Sample","responsibility":"Build","agent_type":"temporary"}')
    await store._provision_recruitment_transaction({}, raw)
    write = store.runtime.driver.execute_query.call_args
    assert write.kwargs['occupation_role'] == 'engineering'
    assert write.kwargs['occupation_tags'] == ['testing']
    assert 'agent.occupation_role = $occupation_role' in write.args[0]
    assert 'agent.occupation_recruitment_id = $recruitment_id' in write.args[0]


def test_bole_assigns_known_work_kind_an_audited_primary_role():
    from fuli_graph.project_agent_task_models import ProjectAgentTaskSubmit
    from fuli_graph.store_project_agent_task_recruitment import StoreProjectAgentTaskRecruitment
    request = ProjectAgentTaskSubmit(personal_space_id='space', personal_project_id='project',
        idempotency_key='test-role', title='Build', objective='Build', work_kind='implementation', routing_reason='test')
    assert recruitment_occupation(request).role == 'engineering'


@pytest.mark.asyncio
async def test_global_assistant_cannot_access_long_term_memory():
    from fuli_graph.project_agent_access import authorize_project_agent
    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=AsyncMock(
        return_value=([{'agent': {'status': 'active', 'memory_scope': 'task_only'}}], None, None)))))
    with pytest.raises(HTTPException, match='long-term memory'):
        await authorize_project_agent(store, {}, {'id': 'space'}, None, 'employee.assistant',
                                      allow_global=True, require_memory=True)


@pytest.mark.asyncio
async def test_global_assistant_is_readable_without_project():
    store = StoreProjectAgents()
    store._require_personal = lambda: None
    store.authorize = AsyncMock(return_value={'id': 'space'})
    store._project_agent_rows = AsyncMock(return_value=[{'agent_id': 'employee.assistant'}])
    store._project_agent_from_row = lambda row, space, project: {**row, 'personal_project_id': project}
    result = await store.get_project_agent({}, 'space', None, 'employee.assistant')
    assert result == {'agent_id': 'employee.assistant', 'personal_project_id': None}


@pytest.mark.parametrize('kind', ['engineering', 'testing', 'management', 'lead'])
def test_recruitment_accepts_canonical_role_work_kinds(kind):
    from fuli_graph.project_agent_task_models import ProjectAgentTaskSubmit
    from fuli_graph.store_project_agent_task_recruitment import StoreProjectAgentTaskRecruitment
    request = ProjectAgentTaskSubmit(personal_space_id='space', personal_project_id='project',
        idempotency_key='test-role', title='Task', objective='Task', work_kind=kind, routing_reason='test')
    assert recruitment_occupation(request).role == kind


@pytest.mark.parametrize('explicit', [False, True])
def test_bole_cannot_recruit_another_assistant_identity(explicit):
    from fuli_graph.project_agent_task_models import ProjectAgentTaskSubmit
    from fuli_graph.store_project_agent_task_recruitment import StoreProjectAgentTaskRecruitment
    request = ProjectAgentTaskSubmit(personal_space_id='space', personal_project_id='project',
        idempotency_key='test-assistant', title='Help', objective='Help', work_kind='assistant', routing_reason='test',
        recruitment_occupation={'role': 'assistant'} if explicit else None)
    with pytest.raises(HTTPException, match='global'):
        StoreProjectAgentTaskRecruitment._normalized_recruitment_profile(request)


@pytest.mark.asyncio
async def test_assistant_occupation_is_reserved_for_the_global_identity():
    from fuli_graph.store_project_agent_occupation import StoreProjectAgentOccupation
    store = StoreProjectAgentOccupation()
    store._require_personal = lambda: None
    store.authorize = AsyncMock()
    with pytest.raises(HTTPException, match='reserved'):
        await store.update_project_agent_occupation({}, 'another-agent',
            ProjectAgentOccupationUpdate(personal_space_id='space', role='assistant'))


def test_direct_creation_and_legacy_decision_accept_explicit_occupation():
    from fuli_graph.project_agent_task_models import ProjectAgentRecruitmentDecision
    created = ProjectAgentUpsert(personal_space_id='space', agent_id='new',
        profile={'name': 'New', 'responsibility': 'Build'}, occupation={'role': 'engineering'})
    assert created.occupation.role == 'engineering'
    decision = ProjectAgentRecruitmentDecision(personal_space_id='space', personal_project_id='project',
        recruitment_id='legacy', expected_revision=0, decision='approve', reason='Choose explicit role',
        occupation={'role': 'research'})
    assert decision.occupation.role == 'research'


@pytest.mark.asyncio
async def test_new_direct_identity_without_role_is_blocked_before_merge():
    store = StoreProjectAgents()
    store._require_personal = lambda: None
    store.authorize = AsyncMock(return_value={'id': 'space'})
    store.settings = SimpleNamespace(provider_id='provider')
    store.runtime = SimpleNamespace(driver=SimpleNamespace(execute_query=AsyncMock(return_value=([], None, None))))
    with pytest.raises(HTTPException, match='occupation.role'):
        await store.upsert_project_agent({}, ProjectAgentUpsert(personal_space_id='space', agent_id='new',
            profile={'name': 'New', 'responsibility': 'Build'}))
    query = store.runtime.driver.execute_query.call_args.args[0]
    assert query.index('WHERE existing IS NOT NULL OR $occupation_role IS NOT NULL') < query.index('MERGE (agent:')
    assert store.runtime.driver.execute_query.call_args.kwargs['occupation_role'] is None


@pytest.mark.asyncio
async def test_legacy_recruitment_approval_can_record_explicit_role_before_provisioning():
    from test_project_agent_parallel_recruitment import AtomicDecisionStore
    from fuli_graph.project_agent_task_models import ProjectAgentRecruitmentDecision
    store = AtomicDecisionStore()
    await store.decide_project_agent_recruitment({'id': 'principal'}, ProjectAgentRecruitmentDecision(
        personal_space_id='personal-space', personal_project_id='project-a', recruitment_id='recruitment-approval',
        expected_revision=0, decision='approve', reason='Choose missing role', occupation={'role': 'research'}))
    query, parameters = store.runtime.driver.calls[1]
    assert parameters['occupation_role'] == 'research'
    assert "ELSE 'approval_choice' END" in query
    assert "recruitment.status = 'requested' AND recruitment.occupation_role IS NULL" in query
