from types import SimpleNamespace

import pytest

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
