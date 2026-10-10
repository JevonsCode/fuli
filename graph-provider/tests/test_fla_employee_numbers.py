from datetime import UTC, datetime

import pytest

from fuli_graph.project_agent_models import ProjectAgentProfile
from fuli_graph.store_project_agents import StoreProjectAgents


@pytest.mark.parametrize(('number', 'label'), [(1, '000001'), (999999, '999999'), (1000000, '1000000')])
def test_employee_number_projection_preserves_identity_and_expands(number, label):
    now = datetime(2026, 1, 1, tzinfo=UTC)
    raw = {'agent_id': 'stable-agent', 'employee_number': number,
           'created_at': now, 'updated_at': now,
           'profile_json': ProjectAgentProfile(name='Synthetic member', responsibility='Synthetic work').model_dump_json()}
    record = StoreProjectAgents()._project_agent_from_row({'agent': raw}, 'space', None)
    assert record.agent_id == 'stable-agent'
    assert record.employee_number == label
