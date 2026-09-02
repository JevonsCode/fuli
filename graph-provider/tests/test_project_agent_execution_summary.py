from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from fuli_graph.project_agent_models import ProjectAgentProfile
from fuli_graph.project_agent_task_models import (
    ProjectAgentActivityTask,
    ProjectAgentTaskActivityCreate,
    ProjectAgentTokenUsage,
    ProjectAgentWorkerRuntime,
)
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
                'source_session_id': 'claude-session-two',
                'source_session_url': 'codex://threads/01234567-89ab-cdef-0123-456789abcdef',
                'tools_used': ['pytest', 'rg'],
                'token_usage_json': ProjectAgentTokenUsage(
                    source='executor',
                    total_tokens=2048,
                    input_tokens=1800,
                    output_tokens=248,
                    cached_input_tokens=600,
                ).model_dump_json(),
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
    claude = next(
        item for item in task.execution_summary
        if item.worker_id == 'worker-two'
    )
    assert claude.source_session_id == 'claude-session-two'
    assert claude.source_session_url == (
        'codex://threads/01234567-89ab-cdef-0123-456789abcdef'
    )
    assert claude.tools_used == ['pytest', 'rg']
    assert claude.token_usage is not None
    assert claude.token_usage.source == 'executor'
    assert claude.token_usage.total_tokens == 2048
    assert claude.token_usage.cached_input_tokens == 600


@pytest.mark.asyncio
async def test_execution_summary_uses_latest_cumulative_worker_token_snapshot():
    row = task_row()
    first = row['event_rows'][0]
    first['token_usage_json'] = ProjectAgentTokenUsage(
        source='host',
        total_tokens=100,
    ).model_dump_json()
    row['event_rows'].insert(1, {
        **first,
        'event_id': 'worker-one-final-token-snapshot',
        'summary': 'Worker one reported its final cumulative usage.',
        'token_usage_json': ProjectAgentTokenUsage(
            source='host',
            total_tokens=175,
            input_tokens=150,
            output_tokens=25,
        ).model_dump_json(),
        'created_at': datetime(2026, 8, 17, 0, 0, 1, 500000, tzinfo=UTC),
    })

    task = await PublicTaskReadStore(row).get_project_agent_task(
        {'id': 'principal-a'},
        'space-a',
        'task-a',
    )

    worker = next(
        item for item in task.execution_summary
        if item.worker_id == 'worker-one'
    )
    assert worker.token_usage is not None
    assert worker.token_usage.total_tokens == 175


def worker_runtime(session_id='worker-session-a', **overrides):
    return ProjectAgentWorkerRuntime(
        **{'application': 'claude_code', 'session_id': session_id, **overrides},
    )


def worker_activity(**overrides):
    return ProjectAgentTaskActivityCreate(**{
        'personal_space_id': 'space-a', 'personal_project_id': 'project-a',
        'task_id': 'task-a', 'idempotency_key': 'worker-runtime-1',
        'status': 'running', 'summary': 'Worker update.',
        'agent_id': 'agent-a', 'worker_id': 'worker-a',
        'source_application': 'codex', 'source_session_id': 'reporter-session',
        **overrides,
    })


def test_worker_runtime_is_separate_from_host_and_not_a_model_claim():
    activity = worker_activity(workerRuntime={
        'application': 'claude_code', 'sessionId': ' worker-session ',
    })
    assert activity.worker_runtime.session_id == 'worker-session'
    assert activity.reported_client_applications == ('codex', 'claude_code')
    assert activity.source_session_id == 'reporter-session'
    assert activity.actual_model is None
    assert activity.actual_executor_id is None
    assert activity.token_usage is None


def test_worker_activity_camel_case_is_normalized_without_field_alias_metadata():
    activity = worker_activity(
        workerId='worker-a',
        workerLabel='Claude worker',
        workerOccupationEmoji='🧪',
        workerStatus='running',
        tokenUsage={'source': 'host', 'totalTokens': 25},
        workerRuntime={
            'application': 'claude_code',
            'sessionId': 'worker-session',
        },
    )
    assert activity.worker_id == 'worker-a'
    assert activity.worker_label == 'Claude worker'
    assert activity.worker_occupation_emoji == '🧪'
    assert activity.worker_status == 'running'
    assert activity.token_usage.total_tokens == 25
    assert activity.worker_runtime.session_id == 'worker-session'
    assert all(
        ProjectAgentTaskActivityCreate.model_fields[name].validation_alias is None
        for name in (
            'worker_id', 'worker_label', 'worker_occupation_emoji',
            'worker_status', 'token_usage', 'worker_runtime',
        )
    )


def test_worker_activity_rejects_conflicting_snake_and_camel_values():
    with pytest.raises(ValueError, match='conflicting worker_id and workerId'):
        worker_activity(workerId='different-worker')


@pytest.mark.parametrize('runtime', [
    {'application': 'unsupported'},
    {'application': 'claude_code', 'sessionId': '  '},
    {'application': 'claude_code', 'sessionUrl': 'javascript:alert(1)'},
    {'application': 'claude_code', 'sessionUrl': 'https://example.invalid/s?token=secret'},
    {'application': 'claude_code', 'sessionUrl': 'https://user:secret@example.invalid/s'},
    {'application': 'claude_code', 'sessionUrl': 'file:///private/session'},
    {'application': 'claude_code', 'apiKey': 'never-store-credentials'},
])
def test_worker_runtime_rejects_invalid_or_sensitive_metadata(runtime):
    with pytest.raises(ValueError):
        worker_activity(workerRuntime=runtime)


@pytest.mark.parametrize(('override', 'message'), [
    ({'worker_id': None}, 'worker ID'),
    ({'agent_id': None}, 'participating Agent ID'),
])
def test_worker_runtime_requires_an_identified_participating_worker(override, message):
    with pytest.raises(ValueError, match=message):
        worker_activity(worker_runtime=worker_runtime(), **override)


@pytest.mark.asyncio
async def test_task_read_keeps_reporting_and_worker_sessions_distinct():
    row = task_row()
    event = row['event_rows'][1]
    event.update(
        source_application='codex', source_session_id='reporter-session',
        worker_runtime_json=worker_runtime().model_dump_json(),
    )
    task = await PublicTaskReadStore(row).get_project_agent_task(
        {'id': 'principal-a'}, 'space-a', 'task-a',
    )
    summary = next(item for item in task.execution_summary if item.worker_id == 'worker-two')
    assert summary.source_application == 'codex'
    assert summary.source_session_id == 'reporter-session'
    assert summary.worker_runtime == worker_runtime()
    assert summary.worker_runtime.session_url is None
    assert task.events[1].worker_runtime == worker_runtime()


@pytest.mark.asyncio
@pytest.mark.parametrize('runtime', [
    worker_runtime('worker-session-b'),
    worker_runtime(application='cursor'),
])
async def test_reused_worker_does_not_inherit_evidence_from_another_session(runtime):
    row = task_row()
    first = row['event_rows'][1]
    first['worker_runtime_json'] = worker_runtime().model_dump_json()
    retry = {
        'event_id': 'worker-retry', 'task_id': 'task-a', 'agent_id': 'agent-a',
        'status': 'running', 'actor_kind': 'agent', 'summary': 'Retry failed before model response.',
        'worker_id': 'worker-two', 'worker_status': 'failed',
        'worker_runtime_json': runtime.model_dump_json(),
        'source_application': 'codex', 'source_session_id': 'reporter-session',
        'created_at': first['created_at'] + timedelta(seconds=10),
    }
    row['event_rows'].append(retry)
    task = await PublicTaskReadStore(row).get_project_agent_task(
        {'id': 'principal-a'}, 'space-a', 'task-a',
    )
    summary = next(item for item in task.execution_summary if item.worker_id == 'worker-two')
    assert summary.worker_runtime == runtime
    assert summary.worker_label == first['worker_label']
    assert summary.status == 'failed'
    assert summary.token_usage is None
    assert summary.tools_used is None
    assert summary.executor_id is None
    assert summary.actual_model is None
    assert summary.actual_model_provider is None
    assert summary.source_session_url is None

    # The activity projection must obey the same run boundary as task detail.
    merged = StoreProjectAgentTasks._event_with_latest_execution_evidence(
        retry, row['event_rows'],
    )
    fields = StoreProjectAgentTasks._activity_executor_fields(merged)
    assert fields['worker_runtime'] == runtime
    assert fields['worker_label'] == first['worker_label']
    assert 'token_usage' not in fields
    assert fields['tools_used'] is None
    assert fields['actual_executor_id'] is None


@pytest.mark.asyncio
async def test_same_worker_session_preserves_usage_but_accepts_empty_tools():
    row = task_row()
    first = row['event_rows'][1]
    first['worker_runtime_json'] = worker_runtime().model_dump_json()
    updated = worker_runtime(session_url='https://example.invalid/sessions/worker-session-a')
    row['event_rows'].append({
        'event_id': 'worker-link', 'task_id': 'task-a', 'agent_id': 'agent-a',
        'status': 'running', 'actor_kind': 'agent', 'summary': 'Session link reported.',
        'worker_id': 'worker-two', 'worker_runtime_json': updated.model_dump_json(),
        'tools_used': [], 'created_at': first['created_at'] + timedelta(seconds=10),
    })
    task = await PublicTaskReadStore(row).get_project_agent_task(
        {'id': 'principal-a'}, 'space-a', 'task-a',
    )
    summary = next(item for item in task.execution_summary if item.worker_id == 'worker-two')
    assert summary.worker_runtime == updated
    assert summary.token_usage.total_tokens == 2048
    assert summary.actual_model == first['actual_model']
    assert summary.tools_used == []
    merged = StoreProjectAgentTasks._event_with_latest_execution_evidence(
        row['event_rows'][-1], row['event_rows'],
    )
    assert merged['tools_used'] == []


@pytest.mark.asyncio
async def test_changed_reporter_session_does_not_reuse_previous_reporter_link():
    row = task_row()
    first = row['event_rows'][1]
    first['worker_runtime_json'] = worker_runtime().model_dump_json()
    row['event_rows'].append({
        'event_id': 'new-reporter', 'task_id': 'task-a', 'agent_id': 'agent-a',
        'status': 'running', 'actor_kind': 'agent', 'summary': 'Same worker, new reporter.',
        'worker_id': 'worker-two', 'source_application': 'codex',
        'source_session_id': 'new-reporting-session',
        'created_at': first['created_at'] + timedelta(seconds=10),
    })
    task = await PublicTaskReadStore(row).get_project_agent_task(
        {'id': 'principal-a'}, 'space-a', 'task-a',
    )
    summary = next(item for item in task.execution_summary if item.worker_id == 'worker-two')
    assert summary.source_session_id == 'new-reporting-session'
    assert summary.source_session_url is None
    assert summary.worker_runtime == worker_runtime()
    assert summary.token_usage.total_tokens == 2048


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
        source_session_url=(
            'codex://threads/01234567-89ab-cdef-0123-456789abcdef'
        ),
        tools_used=[' pytest ', 'rg'],
    )
    assert activity.worker_occupation_emoji == '🧑🏽‍💻'
    assert activity.tools_used == ['pytest', 'rg']

    with pytest.raises(ValueError, match='session URL'):
        ProjectAgentTaskActivityCreate(
            **common,
            source_session_url='javascript:alert(1)',
        )


@pytest.mark.parametrize(
    ('field', 'value'),
    [
        ('source_session_url', 'codex://threads/01234567-89ab-cdef-0123-456789abcdef'),
        ('tools_used', ['pytest']),
    ],
)
def test_execution_evidence_requires_participating_agent(field, value):
    with pytest.raises(ValueError, match='participating Agent ID'):
        ProjectAgentTaskActivityCreate(
            personal_space_id='space-a',
            personal_project_id='project-a',
            task_id='task-a',
            idempotency_key=f'evidence-agent-{field}',
            status='running',
            summary='Worker update.',
            **{field: value},
        )


def test_activity_output_rejects_unsafe_or_empty_execution_evidence():
    common = {
        'task_id': 'task-a',
        'title': 'Evidence task',
        'status': 'completed',
        'summary': 'Done.',
        'occurred_at': datetime.now(UTC),
    }
    with pytest.raises(ValueError, match='session URL'):
        ProjectAgentActivityTask(
            **common,
            source_session_url='javascript:alert(1)',
        )
    with pytest.raises(ValueError, match='tools used'):
        ProjectAgentActivityTask(
            **common,
            tools_used=['   '],
        )
