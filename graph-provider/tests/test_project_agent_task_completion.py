"""Completing a task: the revision it reports must be the one that passed verification (rec#123)."""
import pytest
from fastapi import HTTPException

from fuli_graph.project_agent_task_models import ProjectAgentTaskActivityCreate
from test_project_agent_tasks import ActivityStore, task_request


@pytest.mark.asyncio
@pytest.mark.parametrize(('gate', 'artifact_revision', 'says'), [
    # No revision: say what to pass, and that a task without files names what it delivered.
    ('passed', None, r'Pass the artifactRevision \(commit, or digest/ID of what you delivered\)'),
    # Another revision passed: name both, so the Agent completes with the verified one or verifies its own.
    ('passed', 'changed-revision', 'passed for revision previous-revision, not changed-revision'),
    # Nothing passed yet: name the revision, the gate and the tool, or the person's review.
    ('failed', 'previous-revision', r'previous-revision not verified \(gate failed\)'),
    (None, 'previous-revision', r'\(gate not run\).*record_agent_verification.*awaiting_review'),
    # The longest revisions and gate still fit, with the person's own route (rec#123).
    ('verification_required', 'r' * 160, r'task close route\.$'),
])
async def test_new_task_cannot_complete_without_its_exact_verified_revision(gate, artifact_revision, says):
    store = ActivityStore({
        'task': {'task_id': 'task-a', 'personal_project_id': 'project-a',
                 'status': 'running', 'revision': 1, 'verification_required': task_request().verification_required,
                 'quality_gate': gate, 'verified_artifact_revision': 'previous-revision'},
        'participant_rows': [{'agent_id': 'agent-a', 'role': 'lead'}], 'event_rows': [],
    })
    request = ProjectAgentTaskActivityCreate(
        personal_space_id='personal-space', personal_project_id='project-a', task_id='task-a',
        idempotency_key='complete-unverified-artifact', status='completed', summary='Done.',
        agent_id='agent-a', artifact_revision=artifact_revision,
    )
    with pytest.raises(HTTPException, match=says) as refused:
        await store.record_project_agent_task_activity({'id': 'principal'}, request)
    # The Agent sees at most 240 characters of a refusal.
    assert len(refused.value.detail) <= 240
    assert store.runtime.driver.event_calls == []


@pytest.mark.asyncio
async def test_a_task_completes_with_the_revision_that_passed_verification():
    store = ActivityStore({
        'task': {'task_id': 'task-a', 'personal_project_id': 'project-a', 'status': 'running', 'revision': 1,
                 'verification_required': True, 'quality_gate': 'passed',
                 'verified_artifact_revision': 'config-digest-1'},
        'participant_rows': [{'agent_id': 'agent-a', 'role': 'lead'}], 'event_rows': [],
    }, event_rows=[{'same_payload': True, 'applied_transition': True}])
    request = ProjectAgentTaskActivityCreate(
        personal_space_id='personal-space', personal_project_id='project-a', task_id='task-a',
        idempotency_key='complete-verified-digest', status='completed', summary='Synced; digest verified.',
        agent_id='agent-a', artifact_revision='config-digest-1',
    )
    assert await store.record_project_agent_task_activity({'id': 'principal'}, request) == 'updated-task'
