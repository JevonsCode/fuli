from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.project_agent_models import (
    ProjectAgentAssignmentCreate,
    ProjectAgentAssignmentEnd,
    ProjectAgentAssignmentReplace,
    ProjectAgentProfile,
    ProjectAgentUpsert,
)
from fuli_graph.store_project_agents import StoreProjectAgents


@pytest.mark.asyncio
async def test_project_agent_upsert_creates_space_identity_and_project_assignment():
    profile = project_agent_profile()
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [{'agent': raw_agent(profile)}],
        [{'agent_id': 'activity-agent'}],
        [{'project': {'project_id': 'project-a'}}],
        [{
            'agent': raw_agent(profile),
            'assignment_rows': [{
                'assignment': raw_assignment(),
                'personal_project_id': 'project-a',
            }],
            'task_rows': [],
            'observed_clients': [],
        }],
    ])
    store = StoreStub(driver)

    result = await store.upsert_project_agent(
        {'id': 'principal-1'},
        ProjectAgentUpsert(
            personal_space_id='personal-space',
            personal_project_id='project-a',
            agent_id='activity-agent',
            profile=profile,
        ),
    )

    assert result.agent_id == 'activity-agent'
    assert result.profile.capabilities == ['活动策划', '活动复盘']
    assert result.profile.occupation_emoji == '🧱'
    assert [item.personal_project_id for item in result.assignments] == ['project-a']
    identity_query, identity_parameters = driver.calls[1]
    assignment_query, assignment_parameters = driver.calls[2]
    assert 'HAS_PROJECT_AGENT_IDENTITY' in identity_query
    assert identity_parameters['agent_id'] == 'activity-agent'
    assert identity_parameters['occupation_emoji'] == '🧱'
    assert 'HAS_PROJECT_AGENT_ASSIGNMENT' in assignment_query
    assert 'agent._task_lifecycle_lock' in assignment_query
    assert "agent.status <> 'archived'" in assignment_query
    assert assignment_parameters['personal_project_id'] == 'project-a'
    assert driver.calls[4][1]['personal_project_id'] is None


@pytest.mark.asyncio
async def test_project_agent_upsert_does_not_duplicate_an_explicit_active_assignment():
    profile = project_agent_profile()
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [{'agent': raw_agent(profile)}],
        [{'agent_id': 'activity-agent'}],
        [{'project': {'project_id': 'project-a'}}],
        [{
            'agent': raw_agent(profile),
            'assignment_rows': [{
                'assignment': raw_assignment('explicit-assignment'),
                'personal_project_id': 'project-a',
            }],
            'task_rows': [],
            'observed_clients': [],
        }],
    ])

    await StoreStub(driver).upsert_project_agent(
        {'id': 'principal-1'},
        ProjectAgentUpsert(
            personal_space_id='personal-space',
            personal_project_id='project-a',
            agent_id='activity-agent',
            profile=profile,
        ),
    )

    assignment_query = driver.calls[2][0]
    assert 'active_assignment_count' in assignment_query
    assert 'legacy_assignment_count' in assignment_query
    assert 'active_assignment_count = 0' in assignment_query
    assert "assignment.status <> 'active'" in assignment_query
    assert 'assignment.revision, 0) + 1' in assignment_query
    assert 'assignment.ended_at = NULL' in assignment_query
    assert 'assignment.end_reason = NULL' in assignment_query
    assert 'assignment.replaced_by_assignment_id = NULL' in assignment_query
    assert 'handed_off_assignment_count' in assignment_query
    assert 'handed_off_assignment.status = \'ended\'' in assignment_query
    assert 'handed_off_assignment.replaced_by_assignment_id' in assignment_query
    assert 'legacy_assignment_count > 0 OR (' in assignment_query
    assert 'AND handed_off_assignment_count = 0' in assignment_query
    assert 'agent._task_lifecycle_lock' in assignment_query
    assert "agent.status <> 'archived'" in assignment_query


@pytest.mark.asyncio
async def test_project_agent_directory_filters_by_status_and_capability():
    profile = project_agent_profile()
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [{
            'agent': raw_agent(profile),
            'assignment_rows': [],
            'task_rows': [],
            'observed_clients': [],
        }],
    ])
    store = StoreStub(driver)

    result = await store.list_project_agents(
        {'id': 'principal-1'},
        'personal-space',
        'project-a',
        status='active',
        capability='活动',
    )

    assert [item.agent_id for item in result] == ['activity-agent']
    query, parameters = driver.calls[1]
    assert 'agent.capabilities' in query
    assert 'agent.responsibility' in query
    assert parameters['status'] == 'active'
    assert parameters['capability'] == '活动'


@pytest.mark.asyncio
async def test_project_agent_directory_project_scope_filters_other_project_work_and_clients():
    profile = project_agent_profile()
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [{
            'agent': raw_agent(profile),
            'assignment_rows': [
                {
                    'assignment': raw_assignment('assignment-a'),
                    'personal_project_id': 'project-a',
                },
                {
                    'assignment': raw_assignment('assignment-b'),
                    'personal_project_id': 'project-b',
                },
            ],
            'task_rows': [
                {
                    'task_id': 'task-a',
                    'personal_project_id': 'project-a',
                    'status': 'running',
                },
                {
                    'task_id': 'task-b',
                    'personal_project_id': 'project-b',
                    'status': 'queued',
                },
            ],
            'observed_clients': ['codex', 'cursor'],
            'observed_client_rows': [
                {
                    'personal_project_id': 'project-a',
                    'source_application': 'codex',
                },
                {
                    'personal_project_id': 'project-b',
                    'source_application': 'cursor',
                },
            ],
        }],
    ])

    result = await StoreStub(driver).list_project_agents(
        {'id': 'principal-1'},
        'personal-space',
        'project-a',
    )

    assert [item.personal_project_id for item in result[0].assignments] == ['project-a']
    assert result[0].open_task_count == 1
    assert result[0].current_task_id == 'task-a'
    assert result[0].observed_clients == ['codex']


@pytest.mark.asyncio
async def test_get_project_agent_rejects_identity_not_assigned_to_requested_project():
    profile = project_agent_profile()
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [{
            'agent': raw_agent(profile),
            'assignment_rows': [{
                'assignment': raw_assignment('assignment-b'),
                'personal_project_id': 'project-b',
            }],
            'task_rows': [],
            'observed_clients': [],
        }],
    ])

    with pytest.raises(HTTPException) as error:
        await StoreStub(driver).get_project_agent(
            {'id': 'principal-1'},
            'personal-space',
            'project-a',
            'activity-agent',
        )

    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_project_agent_directory_returns_one_identity_with_many_projects():
    profile = project_agent_profile()
    driver = SequentialDriver([[
        {
            'agent': raw_agent(profile),
            'assignment_rows': [
                {
                    'assignment': raw_assignment('assignment-a'),
                    'personal_project_id': 'project-a',
                },
                {
                    'assignment': raw_assignment('assignment-b'),
                    'personal_project_id': 'project-b',
                },
            ],
            'task_rows': [],
            'observed_clients': [],
        },
    ]])
    store = StoreStub(driver)

    result = await store.list_project_agents(
        {'id': 'principal-1'},
        'personal-space',
    )

    assert len(result) == 1
    assert [item.personal_project_id for item in result[0].assignments] == [
        'project-a',
        'project-b',
    ]
    query, parameters = driver.calls[0]
    assert 'HAS_PROJECT_AGENT_IDENTITY' in query
    assert 'collect(DISTINCT {' in query
    assert 'event_task.personal_project_id' in query
    assert 'AS observed_client_rows' in query
    assert 'task_clients + collect(' not in query
    assert parameters['personal_project_id'] is None


@pytest.mark.asyncio
async def test_assignment_idempotency_conflict_cannot_attach_new_project_or_agent_edges():
    request = ProjectAgentAssignmentCreate(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        agent_id='activity-agent',
        idempotency_key='assignment-create-1',
        responsibility='负责活动方案与复盘。',
        work_kinds=['activity'],
        capabilities=['活动策划'],
        reason='Assign activity work.',
    )
    conflicting = raw_assignment('assignment-conflict')
    conflicting['payload_hash'] = 'different-payload'
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [{'project': {'project_id': 'project-a'}}],
        [{'agent': raw_agent(project_agent_profile()), 'assignment_id': None}],
        [{
            'assignment': conflicting,
            'personal_project_id': 'project-a',
            'agent_id': 'activity-agent',
            'payload_matches': False,
        }],
    ])

    with pytest.raises(HTTPException, match='different input') as error:
        await StoreStub(driver).create_project_agent_assignment(
            {'id': 'principal-1'}, request
        )

    assert error.value.status_code == 409
    mutation_query = driver.calls[-1][0]
    assert 'agent._task_lifecycle_lock' in mutation_query
    assert "WHERE agent.status = 'active'" in mutation_query
    guard_position = mutation_query.index('FOREACH')
    assert mutation_query.index(
        'MERGE (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(assignment)'
    ) > guard_position
    assert mutation_query.index(
        'MERGE (assignment)-[:ASSIGNED_AGENT]->(agent)'
    ) > guard_position


@pytest.mark.asyncio
async def test_assignment_replace_rejects_reused_key_before_mutating_edges_or_source():
    request = ProjectAgentAssignmentReplace(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        assignment_id='assignment-a',
        expected_revision=0,
        replacement_agent_id='replacement-agent',
        idempotency_key='assignment-replace-1',
        responsibility='接手活动方案与复盘。',
        work_kinds=['activity'],
        capabilities=['活动策划'],
        reason='Transfer activity work.',
    )
    ended = raw_assignment('assignment-a')
    replacement = raw_assignment('replacement-existing')
    replacement['payload_hash'] = 'different-payload'
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [{'project': {'project_id': 'project-a'}}],
        [{
            'agent': raw_agent(project_agent_profile()),
            'assignment_id': None,
        }],
        [{
            'ended': ended,
            'replacement': replacement,
            'ended_agent_id': 'activity-agent',
            'replacement_agent_id': 'replacement-agent',
            'payload_matches': False,
            'can_apply': False,
            'exact_replay': False,
        }],
    ])

    with pytest.raises(HTTPException, match='different input') as error:
        await StoreStub(driver).replace_project_agent_assignment(
            {'id': 'principal-1'}, request
        )

    assert error.value.status_code == 409
    mutation_query = driver.calls[-1][0]
    assert 'lifecycle_agent._task_lifecycle_lock' in mutation_query
    assert "replacement_agent.status = 'active'" in mutation_query
    assert "ended_agent.status = 'active'" in mutation_query
    assert 'replacement.payload_hash = $payload_hash AS payload_matches' in mutation_query
    guard_position = mutation_query.index('FOREACH')
    assert mutation_query.index('SET ended.status = \'ended\'') > guard_position
    assert mutation_query.index(
        'MERGE (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(replacement)'
    ) > guard_position


@pytest.mark.asyncio
async def test_assignment_replace_exact_replay_returns_existing_transition():
    request = ProjectAgentAssignmentReplace(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        assignment_id='assignment-a',
        expected_revision=0,
        replacement_agent_id='replacement-agent',
        idempotency_key='assignment-replace-replay',
        responsibility='接手活动方案与复盘。',
        work_kinds=['activity'],
        capabilities=['活动策划'],
        reason='Transfer activity work.',
    )
    payload_hash = StoreStub._assignment_payload_hash(request)
    ended = raw_assignment('assignment-a')
    ended.update({
        'status': 'ended',
        'revision': 1,
        'replaced_by_assignment_id': 'replacement-existing',
    })
    replacement = raw_assignment('replacement-existing')
    replacement['payload_hash'] = payload_hash
    archived_replacement_agent = raw_agent(project_agent_profile())
    archived_replacement_agent['status'] = 'archived'
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [{'project': {'project_id': 'project-a'}}],
        [{
            'agent': archived_replacement_agent,
            'assignment_id': None,
        }],
        [{
            'ended': ended,
            'replacement': replacement,
            'ended_agent_id': 'activity-agent',
            'replacement_agent_id': 'replacement-agent',
            'payload_matches': True,
            'can_apply': False,
            'exact_replay': True,
        }],
    ])

    result = await StoreStub(driver).replace_project_agent_assignment(
        {'id': 'principal-1'}, request
    )

    assert result.ended.status == 'ended'
    assert result.ended.revision == 1
    assert result.ended.replaced_by_assignment_id == 'replacement-existing'
    assert result.replacement.assignment_id == 'replacement-existing'


@pytest.mark.asyncio
async def test_assignment_end_normalizes_a_legacy_null_revision():
    request = ProjectAgentAssignmentEnd(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        assignment_id='assignment-a',
        expected_revision=0,
        reason='End a legacy assignment safely.',
    )
    ended = raw_assignment('assignment-a')
    ended.update({'status': 'ended', 'revision': 1})
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [{
            'assignment': ended,
            'personal_project_id': 'project-a',
            'agent_id': 'activity-agent',
        }],
    ])

    result = await StoreStub(driver).end_project_agent_assignment(
        {'id': 'principal-1'}, request
    )

    assert result.revision == 1
    mutation_query = driver.calls[-1][0]
    assert 'coalesce(assignment.revision, 0) = $expected_revision' in mutation_query
    assert 'assignment.revision = coalesce(assignment.revision, 0) + 1' in mutation_query


def test_project_agent_profile_rejects_duplicate_capabilities():
    with pytest.raises(ValueError, match='must be unique'):
        ProjectAgentProfile(
            name='活动 Agent',
            responsibility='负责活动业务。',
            capabilities=['活动策划', '活动策划'],
        )


def test_project_agent_profile_accepts_claude_remote_connector():
    profile = ProjectAgentProfile(
        name='远程 Claude Agent',
        responsibility='在远程 Claude 连接器中续接同一角色。',
        allowed_clients=['claude'],
    )

    assert profile.allowed_clients == ['claude']


@pytest.mark.parametrize('field', ['name', 'responsibility'])
def test_project_agent_profile_rejects_blank_required_text(field):
    values = {
        'name': '活动 Agent',
        'responsibility': '负责活动业务。',
        field: '   ',
    }
    with pytest.raises(ValueError):
        ProjectAgentProfile(**values)


def test_project_agent_upsert_rejects_blank_stable_ids():
    with pytest.raises(ValueError):
        ProjectAgentUpsert(
            personal_space_id='personal-space',
            personal_project_id='project-a',
            agent_id='   ',
            profile=project_agent_profile(),
        )


def test_project_agent_upsert_requires_dedicated_archive_operation():
    archived_profile = project_agent_profile().model_copy(
        update={'status': 'archived'}
    )

    with pytest.raises(ValueError, match='dedicated archive operation'):
        ProjectAgentUpsert(
            personal_space_id='personal-space',
            personal_project_id='project-a',
            agent_id='activity-agent',
            profile=archived_profile,
        )


@pytest.mark.asyncio
async def test_project_agent_upsert_cannot_reactivate_an_archived_identity():
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [],
    ])

    with pytest.raises(HTTPException, match='dedicated restore operation'):
        await StoreStub(driver).upsert_project_agent(
            {'id': 'principal-1'},
            ProjectAgentUpsert(
                personal_space_id='personal-space',
                personal_project_id='project-a',
                agent_id='activity-agent',
                profile=project_agent_profile(),
            ),
        )

    assert len(driver.calls) == 2
    identity_query = driver.calls[1][0]
    assert 'agent._profile_upsert_lock' in identity_query
    assert "agent.status <> 'archived'" in identity_query


@pytest.mark.asyncio
async def test_temporary_agent_cannot_bypass_hr_recruitment():
    store = StoreStub(SequentialDriver([]))
    profile = project_agent_profile().model_copy(
        update={'agent_type': 'temporary'}
    )

    with pytest.raises(HTTPException, match='audited HR recruitment'):
        await store.upsert_project_agent(
            {'id': 'principal-1'},
            ProjectAgentUpsert(
                personal_space_id='personal-space',
                agent_id='temporary-agent',
                profile=profile,
            ),
        )


@pytest.mark.asyncio
async def test_only_system_identity_can_use_coordinator_type():
    store = StoreStub(SequentialDriver([]))
    profile = project_agent_profile().model_copy(
        update={'agent_type': 'coordinator'}
    )

    with pytest.raises(HTTPException, match='system-managed identity'):
        await store.upsert_project_agent(
            {'id': 'principal-1'},
            ProjectAgentUpsert(
                personal_space_id='personal-space',
                agent_id='extra-manager',
                profile=profile,
            ),
        )


@pytest.mark.asyncio
async def test_blocked_task_is_visible_as_current_agent_work():
    profile = project_agent_profile()
    driver = SequentialDriver([[
        {
            'agent': raw_agent(profile),
            'assignment_rows': [],
            'task_rows': [{
                'task_id': 'blocked-task',
                'status': 'blocked',
                'updated_at': datetime(2026, 8, 17, tzinfo=UTC),
            }],
            'observed_clients': ['codex'],
        },
    ]])

    result = await StoreStub(driver).list_project_agents(
        {'id': 'principal-1'},
        'personal-space',
    )

    assert result[0].work_status == 'blocked'
    assert result[0].current_task_id == 'blocked-task'
    assert result[0].open_task_count == 1


@pytest.mark.asyncio
async def test_archiving_agent_preserves_history_and_ends_assignments():
    profile = project_agent_profile()
    archived = raw_agent(profile)
    archived['status'] = 'archived'
    driver = SequentialDriver([
        [{'agent': archived}],
        [{
            'agent': archived,
            'assignment_rows': [],
            'task_rows': [],
            'observed_clients': [],
        }],
    ])

    result = await StoreStub(driver).archive_project_agent(
        {'id': 'principal-1'},
        'personal-space',
        'activity-agent',
        reason='职责已移交',
    )

    assert result.profile.status == 'archived'
    assert result.work_status == 'ended'
    query, parameters = driver.calls[0]
    assert 'HAS_PARTICIPANT' in query
    assert 'agent._task_lifecycle_lock' in query
    assert query.index('agent._task_lifecycle_lock') < query.index(
        'HAS_PROJECT_AGENT_TASK'
    )
    assert 'MATCH (space)-[:CONTAINS_PROJECT]->' in query
    assert '[:HAS_PROJECT_AGENT_ASSIGNMENT]->' in query
    assert 'FuliProjectAgentAssignment' in query
    assert 'coalesce(agent.archive_reason, $reason)' in query
    assert parameters['reason'] == '职责已移交'


class StoreStub(StoreProjectAgents):
    def __init__(self, driver):
        self.runtime = SimpleNamespace(driver=driver)
        self.settings = SimpleNamespace(
            provider_mode='personal',
            provider_id='provider-1',
        )

    def _require_personal(self):
        return None

    async def authorize(self, actor, space_id, role):
        assert actor['id'] == 'principal-1'
        assert space_id == 'personal-space'
        assert role in {'reader', 'maintainer'}
        return {
            'id': 'personal-space',
            'kind': 'personal',
            'group_id': 'personal-group',
        }


class SequentialDriver:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return self.responses.pop(0), None, None


def project_agent_profile():
    return ProjectAgentProfile(
        name='活动 Agent',
        occupation_emoji='🧱',
        responsibility='负责活动方案与复盘。',
        capabilities=['活动策划', '活动复盘'],
        initial_preferences=['先给结论'],
        status='active',
    )


def raw_agent(profile):
    timestamp = datetime(2026, 8, 17, tzinfo=UTC)
    return {
        'id': 'agent-node-id',
        'agent_id': 'activity-agent',
        'profile_json': profile.model_dump_json(),
        'status': 'active',
        'created_at': timestamp,
        'updated_at': timestamp,
    }


def raw_assignment(assignment_id='assignment-a'):
    timestamp = datetime(2026, 8, 17, tzinfo=UTC)
    return {
        'id': assignment_id,
        'assignment_id': assignment_id,
        'responsibility': '负责活动方案与复盘。',
        'work_kinds': ['activity'],
        'capabilities': ['活动策划', '活动复盘'],
        'reason': 'project assignment',
        'status': 'active',
        'revision': 0,
        'assigned_at': timestamp,
        'updated_at': timestamp,
    }
