from copy import deepcopy

import pytest
from pydantic import ValidationError

from fuli_graph.task_context_models import TaskContextBegin, TaskContextCheckpoint, TaskContextCoordinationTask


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


def test_task_preference_scope_distinguishes_explicit_unspecified_from_legacy_unknown():
    payload = {'personal_space_id': 'scope-space', 'session_id': 'scope-session',
               'source_application': 'codex', 'token': 'fuli-task-scope-model'}
    scope = {'version': 1, 'work_kind': 'review', 'workflow': None}
    assert TaskContextBegin.model_validate({**payload, 'preference_scope': scope}).preference_scope.model_dump() == scope
    assert TaskContextBegin.model_validate(payload).preference_scope is None
    assert TaskContextBegin.model_validate({**payload, 'preference_scope': None}).preference_scope is None
    for invalid in [{'version': 1, 'work_kind': None}, {'version': 1, 'workflow': None},
                    {'version': 2, 'work_kind': None, 'workflow': None},
                    {'version': True, 'work_kind': None, 'workflow': None},
                    {**scope, 'workflow': 1}, {**scope, 'work_kind': ''},
                    {**scope, 'work_kind': 'x' * 129}, {**scope, 'extra': 'not-a-scope-field'}]:
        with pytest.raises(ValidationError):
            TaskContextBegin.model_validate({**payload, 'preference_scope': invalid})


def test_coordination_binding_accepts_only_scope_and_task_identity_not_owner_or_session_claims():
    payload = {'personal_space_id': 'space-1', 'personal_project_id': 'project-1',
               'source_application': 'codex', 'task_id': 'coordination-1'}
    assert TaskContextCoordinationTask.model_validate(payload).model_dump() == payload
    for extra in [{'agent_id': 'forged-owner'}, {'source_session_id': 'guessed-session'}, {'task_id': ''}]:
        with pytest.raises(ValidationError):
            TaskContextCoordinationTask.model_validate({**payload, **extra})


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


def test_worker_run_prepare_accepts_only_ids_strategy_and_host_capability_hash():
    from fuli_graph.project_agent_worker_models import WorkerRunPrepare, WorkerRunSession
    payload = {'personal_space_id': 'space-1', 'personal_project_id': 'project-1',
        'task_context_token': 'fuli-task-12345678', 'source_application': 'codex',
        'task_id': 'coordination-1', 'agent_id': 'member', 'worker_id': 'worker-1',
        'executor_id': 'executor-1', 'target_application': 'codex',
        'provider': 'openai', 'model': 'gpt-6.1-sol',
        'model_strategy': {'mode': 'deep', 'reasoning_effort': 'max'},
        'idempotency_key': 'worker-attempt-1', 'runtime_capability_hash': 'a' * 64}
    value = WorkerRunPrepare.model_validate(payload)
    assert value.model == 'gpt-6.1-sol' and value.model_strategy.reasoning_effort == 'max'
    for change in [{'worker_plan': {}}, {'runtime_capability': 'must-not-be-stored'},
                   {'runtime_capability_hash': 'bad'}, {'bootstrap_lifetime_seconds': 0}]:
        with pytest.raises(ValidationError):
            WorkerRunPrepare.model_validate({**payload, **change})
    session = {'personal_space_id': 'space-1', 'personal_project_id': 'project-1',
               'source_application': 'codex', 'session_id': 'real-worker-session'}
    assert WorkerRunSession.model_validate(session).session_id == 'real-worker-session'
    for change in [{'turn_id': 'another-prompt'}, {'project_agent_id': 'forged-owner'},
                   {'token': 'fuli-task-inherited-parent'}, {'session_id': '   '}]:
        with pytest.raises(ValidationError):
            WorkerRunSession.model_validate({**session, **change})


def test_task_context_begin_records_whether_the_lifecycle_hook_delivered_it():
    payload = {'personal_space_id': 'space-1', 'session_id': 'session-1',
               'source_application': 'claude_code', 'token': 'fuli-task-entry-via'}
    assert TaskContextBegin.model_validate(payload).model_dump(mode='json')['entry_via'] == 'tool'
    assert TaskContextBegin.model_validate({**payload, 'entry_via': 'hook'}).entry_via == 'hook'
    with pytest.raises(ValidationError):
        TaskContextBegin.model_validate({**payload, 'entry_via': 'agent'})
