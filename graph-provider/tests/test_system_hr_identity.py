"""Pure identity-policy checks; no local graph or user data."""
import pytest
from fastapi import HTTPException
from fuli_graph.project_agent_models import ProjectAgentProfile, ProjectAgentUpsert
from fuli_graph.system_hr_identity import merged_hr_profile
from test_project_agents import StoreStub, SequentialDriver


def profile(**changes):
    return ProjectAgentProfile(name='Bole', responsibility='Manage synthetic staffing.',
                               agent_type='hr', **changes).model_dump(mode='json')


def test_merge_keeps_capabilities_without_widening_client_permissions():
    result = merged_hr_profile(
        profile(capabilities=['staffing'], allowed_clients=['codex', 'cursor']),
        profile(capabilities=['audit', 'staffing'], allowed_clients=['codex']),
    )
    assert result.name == result.display_name == 'Bole'
    assert result.capabilities == ['staffing', 'audit']
    assert result.allowed_clients == ['codex']


@pytest.mark.asyncio
async def test_obsolete_hr_id_cannot_be_recreated_even_as_another_type():
    store = StoreStub(SequentialDriver([]))
    with pytest.raises(HTTPException, match='moved to employee.bole') as error:
        await store.upsert_project_agent({'id': 'principal-1'}, ProjectAgentUpsert(
            personal_space_id='personal-space', agent_id='fuli-project-hr',
            profile=ProjectAgentProfile(name='Legacy', responsibility='Synthetic role.'),
        ))
    assert error.value.status_code == 409
    assert store.runtime.driver.calls == []
