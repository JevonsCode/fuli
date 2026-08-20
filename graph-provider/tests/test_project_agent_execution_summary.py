from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from fuli_graph.project_agent_models import ProjectAgentProfile
from fuli_graph.project_agent_task_models import ProjectAgentTaskActivityCreate
from fuli_graph.store_project_agent_task_recruitment import (
    StoreProjectAgentTaskRecruitment,
)
from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks


class ReadDriver:
    def __init__(self, responses):
        self.responses = list(responses)

    async def execute_query(self, query, **parameters):
        return (self.responses.pop(0) if self.responses else [], None, None)


class PublicTaskReadStore(StoreProjectAgentTasks):
    def __init__(self, row):
        # get_project_agent_task is the public read seam; the driver responses
        # model the task read followed by project authorization.
        self.runtime = SimpleNamespace(
            driver=ReadDriver([[row], [{'project': {'project_id': 'project-a'}}]])
        )
        self.settings = SimpleNamespace(
            provider_mode='personal',
            provider_id='provider-1',
        )

    def _require_personal(self):
        return None

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}


class PublicRecruitmentReadStore(StoreProjectAgentTaskRecruitment):
    def __init__(self, recruitment):
        self.runtime = SimpleNamespace(
            driver=ReadDriver([[{'recruitment': recruitment}]])
        )
        self.settings = SimpleNamespace(provider_mode='personal')

    def _require_personal(self):
        return None

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}


def task_row(*, final_status='running'):
    created_at = datetime(2026, 8, 17, tzinfo=UTC)
    profile = ProjectAgentProfile(
        name='布鲁内尔',
        occupation_emoji='🧱',
        responsibility='负责后端与数据工程。',
        capabilities=['backend'],
    )
    return {
        'task': {
            'task_id': 'task-a',
            'personal_space_id': 'space-a',
            'personal_project_id': 'project-a',
            'title': 'Parallel verification',
            'objective': 'Verify two concrete workers.',
            'work_kind': 'verification',
            'required_capabilities': ['backend'],
            'duration': 'ongoing',
            'staffing_intent': 'reuse_preferred',
            'status': final_status,
            'revision': 4,
            'routing_outcome': 'assigned_existing',
            'routing_reason': 'exact_work_kind',
            'routing_explanation': 'exact work kind',
            'coordinator_agent_id': 'coordinator-a',
            'complexity': 'simple',
            'created_at': created_at,
            'updated_at': created_at + timedelta(seconds=4),
        },
        'participant_rows': [{
            'agent_id': 'agent-a',
            'agent_name': '布鲁内尔',
            'occupation_emoji': '🧱',
            'role': 'lead',
            'status': final_status,
            'profile_json': profile.model_dump_json(),
            'joined_at': created_at,
            'updated_at': created_at + timedelta(seconds=4),
        }],
        'event_rows': [
            {
                'event_id': 'worker-one-complete',
                'task_id': 'task-a',
                'agent_id': 'agent-a',
                'status': 'running',
                'actor_kind': 'agent',
                'summary': 'Worker one completed its bounded slice.',
                'source_application': 'codex',
                'actual_model_provider': 'openai',
                'actual_model': 'gpt-worker-one',
                'actual_executor_id': 'executor-codex',
                'worker_id': 'worker-one',
                'worker_label': 'Codex worker',
                'worker_occupation_emoji': '🔧',
                'worker_status': 'completed',
                'created_at': created_at + timedelta(seconds=1),
            },
            {
                'event_id': 'worker-two-complete',
                'task_id': 'task-a',
                'agent_id': 'agent-a',
                'status': 'running',
                'actor_kind': 'agent',
                'summary': 'Worker two completed its bounded slice.',
                'source_application': 'claude_code',
                'actual_model_provider': 'anthropic',
                'actual_model': 'claude-worker-two',
                'actual_executor_id': 'executor-claude',
                'worker_id': 'worker-two',
                'worker_label': 'Claude worker',
                'worker_occupation_emoji': '🧪',
                'worker_status': 'completed',
                'created_at': created_at + timedelta(seconds=2),
            },
            # This is a real task event, but not a worker event.  It must not
            # create an extra synthetic participant row.
            {
                'event_id': 'unrelated-agent-event',
                'task_id': 'task-a',
                'agent_id': 'agent-not-assigned',
                'status': 'completed',
                'actor_kind': 'agent',
                'summary': 'Must not leak into this task summary.',
                'created_at': created_at + timedelta(seconds=3),
            },
        ],
        'decision': None,
    }


@pytest.mark.asyncio
async def test_task_detail_exposes_two_observed_workers_under_one_agent():
    task = await PublicTaskReadStore(task_row()).get_project_agent_task(
        {'id': 'principal-a'},
        'space-a',
        'task-a',
    )

    assert len(task.execution_summary) == 2
    assert {(item.worker_id, item.executor_id) for item in task.execution_summary} == {
        ('worker-one', 'executor-codex'),
        ('worker-two', 'executor-claude'),
    }
    assert {item.source_application for item in task.execution_summary} == {
        'codex',
        'claude_code',
    }
    assert all(item.agent_id == 'agent-a' for item in task.execution_summary)
    assert all(item.agent_name == '布鲁内尔' for item in task.execution_summary)
    assert all(item.occupation_emoji == '🧱' for item in task.execution_summary)
    assert {item.status for item in task.execution_summary} == {'completed'}


@pytest.mark.asyncio
async def test_configured_participant_without_execution_event_has_no_summary_row():
    row = task_row()
    row['event_rows'] = []
    task = await PublicTaskReadStore(row).get_project_agent_task(
        {'id': 'principal-a'},
        'space-a',
        'task-a',
    )

    assert task.execution_summary == []


@pytest.mark.asyncio
async def test_agent_linked_legacy_running_event_remains_execution_evidence():
    row = task_row()
    row['event_rows'] = [{
        'event_id': 'legacy-running',
        'task_id': 'task-a',
        'agent_id': 'agent-a',
        'status': 'running',
        'actor_kind': 'agent',
        'summary': 'Legacy Agent reported real work without a worker ID.',
        'source_application': 'codex',
        'created_at': datetime(2026, 8, 17, tzinfo=UTC),
    }]
    task = await PublicTaskReadStore(row).get_project_agent_task(
        {'id': 'principal-a'},
        'space-a',
        'task-a',
    )

    assert len(task.execution_summary) == 1
    assert task.execution_summary[0].worker_id is None
    assert task.execution_summary[0].work_summary.startswith('Legacy Agent')


@pytest.mark.asyncio
async def test_recruitment_directory_preserves_the_proposed_occupation_emoji():
    profile = ProjectAgentProfile(
        name='招聘的后端 Agent',
        occupation_emoji='🧱',
        responsibility='负责后端与数据工程。',
    )
    timestamp = datetime(2026, 8, 17, tzinfo=UTC)
    recruitment = {
        'id': 'recruitment-a',
        'recruitment_id': 'recruitment-a',
        'personal_space_id': 'space-a',
        'personal_project_id': 'project-a',
        'task_id': 'task-a',
        'coordinator_agent_id': 'coordinator-a',
        'hr_agent_id': 'hr-a',
        'position_kind': 'durable',
        'work_kind': 'backend',
        'required_capabilities': ['backend'],
        'reason_code': 'explicit_new_agent',
        'reason': 'Need backend coverage.',
        'status': 'requested',
        'confirmation_mode': 'automatic',
        'proposed_agent_id': 'proposed-a',
        'proposed_profile_json': profile.model_dump_json(),
        'occupation_emoji': '🧱',
        'cleanup_eligible': False,
        'revision': 0,
        'created_at': timestamp,
        'updated_at': timestamp,
    }

    result = await PublicRecruitmentReadStore(recruitment).list_project_agent_recruitments(
        {'id': 'principal-a'},
        'space-a',
    )

    assert result[0].proposed_profile.occupation_emoji == '🧱'


@pytest.mark.parametrize(
    'occupation_emoji',
    ['developer', 'backend worker', '🧱 developer', '🧱\nworker'],
)
def test_profile_rejects_non_emoji_or_multiword_occupation_text(occupation_emoji):
    with pytest.raises(ValueError, match='emoji'):
        ProjectAgentProfile(
            name='Builder',
            occupation_emoji=occupation_emoji,
            responsibility='Build project work.',
        )


@pytest.mark.parametrize('occupation_emoji', ['🧑‍💻', '🧱', '🧑🏽‍💻'])
def test_profile_accepts_common_emoji_sequences_and_strips_outer_space(
    occupation_emoji,
):
    profile = ProjectAgentProfile(
        name='Builder',
        occupation_emoji=f'  {occupation_emoji}  ',
        responsibility='Build project work.',
    )

    assert profile.occupation_emoji == occupation_emoji


def test_worker_activity_rejects_text_and_accepts_emoji_sequence():
    common = {
        'personal_space_id': 'space-a',
        'personal_project_id': 'project-a',
        'task_id': 'task-a',
        'idempotency_key': 'emoji-activity-1',
        'status': 'running',
        'summary': 'Worker update.',
        'agent_id': 'agent-a',
        'worker_id': 'worker-a',
    }

    with pytest.raises(ValueError, match='emoji'):
        ProjectAgentTaskActivityCreate(
            **common,
            worker_occupation_emoji='developer',
        )

    activity = ProjectAgentTaskActivityCreate(
        **common,
        worker_occupation_emoji=' 🧑🏽‍💻 ',
    )
    assert activity.worker_occupation_emoji == '🧑🏽‍💻'
