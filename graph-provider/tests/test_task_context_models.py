from copy import deepcopy

import pytest
from pydantic import ValidationError

from fuli_graph.task_context_models import TaskContextBegin, TaskContextCheckpoint


def test_task_context_begin_preserves_bounded_host_session_provenance():
    value = TaskContextBegin.model_validate({
        'personal_space_id': 'space-1',
        'personal_project_id': 'project-1',
        'project_agent_id': 'agent-1',
        'session_id': 'logical-session',
        'source_application': 'claude_code',
        'source_session_id': 'mcp-host-session',
        'token': 'fuli-task-12345678',
        'turn_id': 'turn-1',
    })

    assert value.source_session_id == 'mcp-host-session'
    assert value.model_dump(mode='json')['source_session_id'] == 'mcp-host-session'


def scoped_checkpoint():
    return {
        'personal_space_id': 'space-1', 'source_application': 'codex',
        'phase': 'complete', 'disposition': 'capture_candidates',
        'reason': 'Record the synthetic capture receipts.', 'fingerprint': 'b' * 64,
        'capture_results': [{
            'scope': 'personal_global', 'personal_project_id': None,
            'status': 'committed', 'episode_id': 'synthetic-episode',
            'entity_ids': ['synthetic-preference'], 'relationship_ids': [],
        }],
    }


def test_task_checkpoint_accepts_bounded_capture_receipts_without_knowledge_content():
    payload = scoped_checkpoint()
    value = TaskContextCheckpoint.model_validate(payload)
    assert value.model_dump(mode='json')['capture_results'] == payload['capture_results']


@pytest.mark.parametrize('change', [
    {'phase': 'prepare'}, {'disposition': 'retain_nothing'},
    {'capture_results': []},
    {'capture_results': scoped_checkpoint()['capture_results'] * 2},
    {'receipt': {'personal_project_id': 'foreign-project'}},
    {'receipt': {'status': 'capture_disabled'}},
    {'receipt': {'status': 'confirmed'}},
    {'receipt': {'summary': 'Do not retain discarded or duplicate knowledge text.'}},
])
def test_task_checkpoint_rejects_inconsistent_or_non_metadata_capture_receipts(change):
    payload = deepcopy(scoped_checkpoint())
    if 'receipt' in change:
        payload['capture_results'][0].update(change['receipt'])
    else:
        payload.update(change)
    with pytest.raises(ValidationError):
        TaskContextCheckpoint.model_validate(payload)
