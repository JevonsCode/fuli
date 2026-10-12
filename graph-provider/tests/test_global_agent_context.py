"""Global Agent scope is explicit and never a project wildcard."""
import pytest
from pydantic import ValidationError
from fuli_graph.agent_conversation_models import ConversationQuery
from fuli_graph.project_agent_memory_models import ProjectAgentMemoryWrite
from fuli_graph.task_context_models import TaskContextBegin


def test_global_agent_contracts_accept_no_project():
    scope = dict(personal_space_id='synthetic-space', agent_id='engineer')
    assert ConversationQuery(**scope).personal_project_id is None
    assert ProjectAgentMemoryWrite(**scope, expected_revision=0,
        idempotency_key='global-checkpoint', source_application='codex',
        memory={'summary': 'Independent global context.'}).personal_project_id is None
    assert TaskContextBegin(personal_space_id='synthetic-space', project_agent_id='engineer',
        source_application='codex', session_id='synthetic-session',
        token='fuli-task-global-1234').personal_project_id is None


@pytest.mark.parametrize('project_id', ['', 'x' * 129])
def test_invalid_project_is_not_silently_treated_as_global(project_id):
    with pytest.raises(ValidationError):
        ConversationQuery(personal_space_id='synthetic-space', agent_id='engineer',
            personal_project_id=project_id)
