"""Public contracts for private, versioned Agent working memory.

All identities and content in this module are synthetic test fixtures.
"""

import pytest
from pydantic import ValidationError

from fuli_graph.project_agent_memory_models import ProjectAgentMemoryWrite


def memory_request(**changes):
    values = {
        'personal_space_id': 'memory-test-space',
        'personal_project_id': 'sample-project',
        'agent_id': 'engineer',
        'expected_revision': 0,
        'idempotency_key': 'checkpoint-001',
        'source_application': 'codex',
        'memory': {
            'summary': 'The sample project uses a local graph.',
            'decisions': ['Keep project facts separate from private working notes.'],
            'open_threads': ['Verify recovery in a second client.'],
            'next_actions': ['Run the shared-context acceptance test.'],
        },
    }
    return ProjectAgentMemoryWrite.model_validate({**values, **changes})


def test_working_memory_is_project_agent_scoped_and_versioned():
    request = memory_request()

    assert request.personal_project_id == 'sample-project'
    assert request.agent_id == 'engineer'
    assert request.expected_revision == 0
    assert request.memory.open_threads == ['Verify recovery in a second client.']
    assert request.source_application == 'codex'


@pytest.mark.parametrize('memory', [
    {'summary': '   '},
    {'summary': 'x' * 4001},
    {'summary': 'bounded', 'open_threads': ['x'] * 13},
    {'summary': 'api_key=synthetic-private-key'},
    {'summary': 'bounded', 'raw_transcript': 'not permitted'},
    {'summary': '有界摘要', 'decisions': ['多' * 1000] * 12},
])
def test_working_memory_rejects_unbounded_sensitive_or_raw_inputs(memory):
    with pytest.raises(ValidationError):
        memory_request(memory=memory)
