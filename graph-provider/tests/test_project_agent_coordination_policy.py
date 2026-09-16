from types import SimpleNamespace
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from fuli_graph.project_agent_coordination_models import (
    ProjectAgentCoordinationPolicyUpdate,
)
from fuli_graph.store_project_agent_coordination_policy import (
    StoreProjectAgentCoordinationPolicy,
)


class PolicyDriver:
    def __init__(self, policy=None):
        self.policy = policy
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if 'RETURN project' in query:
            return ([{'project': {'project_id': 'activity-intake'}}], None, None)
        if 'RETURN policy' in query:
            return ([{'policy': self.policy}], None, None)
        return ([], None, None)


class PolicyStore(StoreProjectAgentCoordinationPolicy):
    def __init__(self, policy=None):
        self.settings = SimpleNamespace(
            provider_id='provider',
            provider_mode='personal',
        )
        self.runtime = SimpleNamespace(driver=PolicyDriver(policy))

    def _require_personal(self):
        return None

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}

    async def get_project_agent(self, actor, space_id, project_id, agent_id):
        return SimpleNamespace(profile=SimpleNamespace(status='active', agent_type='temporary' if agent_id == 'temp' else 'durable',
            capabilities=['fuli.employee:jefa'] if agent_id == 'manager' else []),
            assignments=[SimpleNamespace(status='active', personal_project_id=project_id)])


@pytest.mark.asyncio
async def test_project_coordination_policy_defaults_both_switches_on():
    store = PolicyStore()

    policy = await store.get_project_agent_coordination_policy(
        {'id': 'principal'},
        'personal-space',
        'activity-intake',
    )

    assert policy.ask_before_recruitment is True
    assert policy.auto_reuse_previous_agent is True
    assert policy.auto_grow_team is True
    assert policy.updated_at is None


@pytest.mark.asyncio
async def test_project_coordination_policy_persists_both_switches_together():
    store = PolicyStore()

    policy = await store.update_project_agent_coordination_policy(
        {'id': 'principal'},
        ProjectAgentCoordinationPolicyUpdate(
            personal_space_id='personal-space',
            personal_project_id='activity-intake',
            ask_before_recruitment=False,
            auto_reuse_previous_agent=False,
        ),
    )

    assert policy.ask_before_recruitment is False
    assert policy.auto_reuse_previous_agent is False
    write = next(
        parameters
        for query, parameters in store.runtime.driver.calls
        if 'HAS_PROJECT_AGENT_COORDINATION_POLICY' in query
        and 'SET policy.ask_before_recruitment' in query
    )
    assert write['ask_before_recruitment'] is False
    assert write['auto_reuse_previous_agent'] is False


@pytest.mark.asyncio
async def test_team_is_scoped_and_preserved_by_legacy_switch_updates():
    store = PolicyStore({'team_lead_agent_id': 'lead', 'team_member_agent_ids': ['member'], 'auto_grow_team': False})
    policy = await store.update_project_agent_coordination_policy({'id': 'principal'}, ProjectAgentCoordinationPolicyUpdate(
        personal_space_id='personal-space', personal_project_id='activity-intake', auto_reuse_previous_agent=False))
    assert policy.team_lead_agent_id == 'lead'
    assert policy.team_member_agent_ids == ['member']
    assert not policy.auto_reuse_previous_agent
    assert not policy.auto_grow_team


@pytest.mark.asyncio
async def test_team_keeps_employees_as_peers_and_requires_a_leader():
    store = PolicyStore()
    for fields in [{'team_lead_agent_id': 'manager'}, {'team_lead_agent_id': 'lead', 'team_member_agent_ids': ['manager']},
                   {'team_member_agent_ids': ['member']}, {'team_lead_agent_id': 'temp'},
                   {'team_lead_agent_id': 'lead', 'team_member_agent_ids': ['temp']}]:
        with pytest.raises(HTTPException) as error:
            await store.update_project_agent_coordination_policy({'id': 'principal'}, ProjectAgentCoordinationPolicyUpdate(
                personal_space_id='personal-space', personal_project_id='activity-intake', **fields))
        assert error.value.status_code == 422


@pytest.mark.asyncio
async def test_stale_policy_update_cannot_replace_a_team():
    store = PolicyStore({'updated_at': datetime(2026, 9, 16, tzinfo=UTC)})
    with pytest.raises(HTTPException) as error:
        await store.update_project_agent_coordination_policy({'id': 'principal'}, ProjectAgentCoordinationPolicyUpdate(
            personal_space_id='personal-space', personal_project_id='activity-intake',
            team_lead_agent_id='lead', expected_updated_at=datetime(2026, 9, 15, tzinfo=UTC)))
    assert error.value.status_code == 409
    assert not any('SET policy.ask_before_recruitment' in query for query, _ in store.runtime.driver.calls)


def test_team_cannot_repeat_a_role():
    for fields in [{'team_member_agent_ids': ['member', 'member']},
                   {'team_lead_agent_id': 'lead', 'team_member_agent_ids': ['lead']}]:
        with pytest.raises(ValidationError):
            ProjectAgentCoordinationPolicyUpdate(personal_space_id='space', personal_project_id='project', **fields)
