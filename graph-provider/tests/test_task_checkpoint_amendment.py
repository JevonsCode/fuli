"""Checkpoint amendments without a graph: the request model and the append rule (rec#85).

Synthetic values only.
"""

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from fuli_graph.task_checkpoint_amendment import MAX_AMENDMENTS, checkpoint_amendment
from fuli_graph.task_context_models import TaskCheckpointAmendment


def amendment(**changes):
    return TaskCheckpointAmendment.model_validate({
        'personal_space_id': 'space-1', 'source_application': 'codex',
        'disposition': 'retain_nothing', 'reason': 'Corrected synthetic outcome.',
        'fingerprint': 'b' * 64, 'work_log': {'status': 'completed', 'summary': 'Replied after the late message.'},
        **changes,
    })


def completed(**changes):
    return {'phase': 'complete', 'disposition': 'retain_nothing', 'fingerprint': 'a' * 64,
            'reason': 'Premature synthetic outcome.',
            'work_log': {'status': 'no_change', 'summary': 'Nothing to do.'}, **changes}


def test_amendment_model_takes_only_reason_and_work_log():
    with pytest.raises(ValidationError):
        amendment(capture_results=[])
    with pytest.raises(ValidationError):
        amendment(agent_memory={'expected_revision': 0, 'memory': {'summary': 'x'}})
    with pytest.raises(ValidationError):
        amendment(knowledge_usage=[])
    with pytest.raises(ValidationError):
        amendment(reason='token sk-ant-api03-' + 'a' * 40)
    assert amendment(work_log=None).work_log is None


def test_amendment_appends_beside_the_original_and_replays_by_fingerprint():
    entry = checkpoint_amendment(completed(), amendment())
    assert entry['fingerprint'] == 'b' * 64
    assert entry['work_log'] == {'status': 'completed', 'summary': 'Replied after the late message.'}
    assert entry['reason'] == 'Corrected synthetic outcome.' and entry['amended_at']
    # The same amendment again, or the original's own input, adds nothing.
    assert checkpoint_amendment(completed(amendments=[entry]), amendment()) is None
    assert checkpoint_amendment(completed(), amendment(fingerprint='a' * 64)) is None


def test_amendment_needs_a_completed_checkpoint_with_its_disposition():
    with pytest.raises(HTTPException) as prepared:
        checkpoint_amendment(completed(phase='prepare'), amendment())
    assert prepared.value.status_code == 409 and 'completed checkpoint' in prepared.value.detail
    with pytest.raises(HTTPException) as missing:
        checkpoint_amendment({}, amendment())
    assert missing.value.status_code == 409
    with pytest.raises(HTTPException) as changed:
        checkpoint_amendment(completed(), amendment(disposition='capture_candidates'))
    assert 'capture decisions cannot change' in changed.value.detail


def test_amendments_are_bounded():
    kept = [{'fingerprint': str(index) * 64} for index in range(MAX_AMENDMENTS)]
    with pytest.raises(HTTPException) as full:
        checkpoint_amendment(completed(amendments=kept), amendment())
    assert full.value.status_code == 409 and 'new task context' in full.value.detail
