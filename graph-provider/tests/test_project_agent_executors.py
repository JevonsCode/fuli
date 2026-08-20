import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.project_agent_executor_models import (
    ProjectAgentExecutorActualReport,
    ProjectAgentExecutorAuthorization,
    ProjectAgentExecutorEvidenceIgnore,
    ProjectAgentExecutorHealthReport,
    ProjectAgentExecutorModelRecord,
    ProjectAgentExecutorOutcomeAggregate,
    ProjectAgentExecutorOutcomeEvidenceCreate,
    ProjectAgentExecutorOutcomeReset,
    ProjectAgentExecutorPreflightReport,
    ProjectAgentExecutorRegistration,
    ProjectAgentExecutorRoutingRuleCreate,
    ProjectAgentExecutorRoutingRuleRecord,
    project_agent_model_strategy_key,
)
from fuli_graph.project_agent_models import (
    ProjectAgentExecutorPolicy,
    ProjectAgentModelStrategy,
)
from fuli_graph.store_project_agent_executors import StoreProjectAgentExecutors
from fuli_graph.store_project_agent_executor_learning import (
    project_agent_executor_outcome_bucket_id,
)


UTC = timezone.utc


class StoreStub(StoreProjectAgentExecutors):
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
        assert space_id == 'space-1'
        assert role in {'reader', 'maintainer'}
        return {
            'id': space_id,
            'kind': 'personal',
            'group_id': 'group-1',
        }


class SequentialDriver:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if self.responses:
            return self.responses.pop(0), None, None
        return [], None, None


def model(*, provider='provider', name='model', capabilities=None):
    return ProjectAgentExecutorModelRecord(
        provider=provider,
        model=name,
        capabilities=capabilities or ['review'],
        strategy_modes=['balanced'],
        reasoning_efforts=['medium'],
        observed_at=datetime.now(UTC),
    )


def executor_raw(
    executor_id,
    *,
    priority=100,
    capabilities=None,
    status='registered',
    permission='authorized',
    preflight='passed',
    health='unknown',
    models=None,
):
    timestamp = datetime.now(UTC)
    return {
        'executor': {
            'executor_id': executor_id,
            'display_name': executor_id,
            'executor_kind': 'test-host',
            'registration_status': status,
            'preflight_status': preflight,
            'health_status': health,
            'health_required': False,
            'workspace_permission': permission == 'authorized',
            'capabilities': capabilities or ['review'],
            'available_models_json': json.dumps(
                [item.model_dump(mode='json') for item in (models or [model()])]
            ),
            'global_priority': priority,
            'revision': 0,
            'registered_at': timestamp,
            'updated_at': timestamp,
        },
        'permission': {'status': permission},
    }


def agent_raw(policy=None):
    from fuli_graph.project_agent_models import ProjectAgentProfile

    profile = ProjectAgentProfile(
        name='Durable Agent',
        responsibility='Review project work.',
        executor_policy=policy or ProjectAgentExecutorPolicy(),
    )
    timestamp = datetime.now(UTC)
    return {
        'agent': {
            'agent_id': 'agent-1',
            'profile_json': profile.model_dump_json(),
            'status': 'active',
            'created_at': timestamp,
            'updated_at': timestamp,
        }
    }


def registration():
    return ProjectAgentExecutorRegistration(
        personal_space_id='space-1',
        executor_id='executor-1',
        display_name='Executor 1',
        capabilities=['review'],
        idempotency_key='register-1',
    )


def actor():
    return {'id': 'principal-1'}


def outcome_raw(
    strategy: ProjectAgentModelStrategy,
    *,
    evidence_id='evidence-1',
    ignored=False,
    terminal_outcome='completed',
):
    timestamp = datetime.now(UTC)
    return {
        'evidence_id': evidence_id,
        'personal_space_id': 'space-1',
        'personal_project_id': 'project-1',
        'work_kind': 'review',
        'agent_id': 'agent-1',
        'executor_id': 'executor-1',
        'task_id': 'task-1',
        'run_id': 'run-1',
        'model_strategy_json': strategy.model_dump_json(),
        'model_strategy_key': project_agent_model_strategy_key(strategy),
        'evidence_kind': 'terminal_outcome',
        'source': 'system_terminal',
        'terminal_outcome': terminal_outcome,
        'reference_ids': [f'{evidence_id}-ref'],
        'occurred_at': timestamp,
        'created_at': timestamp,
        'ignored': ignored,
    }


def test_executor_policy_defaults_flexible_and_locked_requires_explicit_allow_list():
    assert ProjectAgentExecutorPolicy().mode == 'flexible'
    with pytest.raises(ValueError, match='explicit allow-list'):
        ProjectAgentExecutorPolicy(mode='locked')


def test_model_strategy_key_is_canonical_and_provider_neutral():
    first = ProjectAgentModelStrategy(
        mode='balanced',
        reasoning_effort='medium',
        capability_hints=['Review', 'verification'],
    )
    equivalent = ProjectAgentModelStrategy(
        mode='balanced',
        reasoning_effort='medium',
        capability_hints=['verification', 'review'],
    )
    assert project_agent_model_strategy_key(first) == project_agent_model_strategy_key(
        equivalent
    )


def test_routing_rules_are_generic_and_empty_by_default():
    rule = ProjectAgentExecutorRoutingRuleCreate(
        scope='project',
        personal_space_id='space-1',
        personal_project_id='project-1',
        work_kind='arbitrary-domain-work',
        required_capabilities=['review'],
        executor_ids=['executor-1'],
        reason='User configured this route.',
        idempotency_key='rule-123',
    )
    assert rule.work_kind == 'arbitrary-domain-work'
    assert rule.executor_ids == ['executor-1']


@pytest.mark.asyncio
async def test_register_authorize_preflight_and_health_are_persisted():
    available = model()
    raw = executor_raw('executor-1', models=[available])
    driver = SequentialDriver([
        [raw],
        [raw],
        [raw],
        [executor_raw('executor-1', health='healthy', models=[available])],
    ])
    store = StoreStub(driver)

    registered = await store.register_project_agent_executor(actor(), registration())
    assert registered.executor_id == 'executor-1'
    assert registered.permission_status == 'authorized'

    authorized = await store.authorize_project_agent_executor(
        actor(),
        ProjectAgentExecutorAuthorization(
            personal_space_id='space-1',
            executor_id='executor-1',
            status='authorized',
            reason='Workspace permission approved.',
            idempotency_key='authorize-1',
        ),
    )
    assert authorized.workspace_permission is True

    preflighted = await store.record_project_agent_executor_preflight(
        actor(),
        ProjectAgentExecutorPreflightReport(
            personal_space_id='space-1',
            executor_id='executor-1',
            status='passed',
            workspace_permission=True,
            capabilities=['review'],
            available_models=[available],
            checked_at=datetime.now(UTC),
            idempotency_key='preflight-1',
        ),
    )
    assert preflighted.preflight_status == 'passed'

    healthy = await store.record_project_agent_executor_health(
        actor(),
        ProjectAgentExecutorHealthReport(
            personal_space_id='space-1',
            executor_id='executor-1',
            status='healthy',
            checked_at=datetime.now(UTC),
            idempotency_key='health-1',
        ),
    )
    assert healthy.health_status == 'healthy'
    assert len(driver.calls) == 4
    assert 'HAS_EXECUTOR_PERMISSION' in driver.calls[1][0]
    assert 'authorization_idempotency_key' in driver.calls[1][0]
    assert 'preflight_idempotency_key' in driver.calls[2][0]
    assert 'health_idempotency_key' in driver.calls[3][0]


@pytest.mark.asyncio
async def test_archive_executor_revokes_permission_and_preserves_record():
    archived = executor_raw(
        'executor-1',
        status='disabled',
        permission='revoked',
    )
    driver = SequentialDriver([[archived]])
    result = await StoreStub(driver).archive_project_agent_executor(
        actor(),
        'space-1',
        'executor-1',
        reason='End-to-end test cleanup.',
    )

    assert result.registration_status == 'disabled'
    assert result.permission_status == 'revoked'
    query, parameters = driver.calls[0]
    assert "executor.registration_status = 'disabled'" in query
    assert "permission.status = 'revoked'" in query
    assert parameters['reason'] == 'End-to-end test cleanup.'


@pytest.mark.asyncio
async def test_archive_routing_rule_ends_it_without_deleting_audit():
    timestamp = datetime.now(UTC)
    raw = {
        'rule_id': 'rule-1',
        'scope': 'space',
        'personal_space_id': 'space-1',
        'work_kind': 'review',
        'required_capabilities': [],
        'executor_ids': ['executor-1'],
        'priority': 100,
        'reason': 'Configured preference.',
        'idempotency_key': 'rule-create-1',
        'status': 'ended',
        'revision': 1,
        'created_at': timestamp,
        'updated_at': timestamp,
    }
    driver = SequentialDriver([[{'rule': raw}]])
    result = await StoreStub(driver).archive_project_agent_executor_routing_rule(
        actor(),
        'space-1',
        'rule-1',
        reason='No longer preferred.',
    )

    assert result.status == 'ended'
    query, parameters = driver.calls[0]
    assert "rule.status = 'ended'" in query
    assert 'DETACH DELETE' not in query
    assert parameters['reason'] == 'No longer preferred.'


@pytest.mark.asyncio
async def test_flexible_route_uses_same_level_rule_and_records_selection():
    rule = {
        'rule': {
            'rule_id': 'rule-1',
            'scope': 'project',
            'personal_space_id': 'space-1',
            'personal_project_id': 'project-1',
            'work_kind': 'review',
            'required_capabilities': ['review'],
            'executor_ids': ['executor-1', 'executor-2'],
            'priority': 1,
            'reason': 'Explicit project rule.',
            'idempotency_key': 'rule-key',
            'status': 'active',
            'revision': 0,
            'created_at': datetime.now(UTC),
            'updated_at': datetime.now(UTC),
        }
    }
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [agent_raw()],
        [rule],
        [executor_raw('executor-1', priority=1), executor_raw('executor-2', priority=2)],
        [{'decision': {}}],
    ])
    result = await StoreStub(driver).resolve_project_agent_executor(
        actor(),
        personal_space_id='space-1',
        personal_project_id='project-1',
        task_id='task-1',
        agent_id='agent-1',
        work_kind='review',
        required_capabilities=['review'],
        idempotency_key='select-1',
    )
    assert result.status == 'selected'
    assert result.selected_executor_id == 'executor-1'
    assert result.matched_rule_id == 'rule-1'
    assert result.fallback_outcome == 'not_needed'
    assert result.model_strategy.mode == 'adaptive'
    assert 'FuliProjectAgentExecutorRoutingRule' in driver.calls[2][0]
    assert 'FuliProjectAgentExecutorDecision' in driver.calls[4][0]
    assert 'OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]->' in driver.calls[1][0]


@pytest.mark.asyncio
async def test_flexible_route_can_fallback_and_records_reason():
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [agent_raw()],
        [],
        [
            executor_raw('executor-1', priority=1, preflight='failed'),
            executor_raw('executor-2', priority=2),
        ],
        [{'decision': {}}],
    ])
    result = await StoreStub(driver).resolve_project_agent_executor(
        actor(),
        personal_space_id='space-1',
        personal_project_id='project-1',
        task_id='task-2',
        agent_id='agent-1',
        work_kind='unmapped-work',
        required_capabilities=['review'],
        idempotency_key='select-2',
    )
    assert result.status == 'fallback'
    assert result.selected_executor_id == 'executor-2'
    assert result.fallback_outcome == 'global_priority'
    assert 'executor-1 unavailable' in result.fallback_reason


@pytest.mark.asyncio
async def test_locked_allow_list_never_falls_back_outside_list():
    policy = ProjectAgentExecutorPolicy(
        mode='locked',
        locked_executor_ids=['executor-locked', 'executor-allowed'],
    )
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [agent_raw(policy)],
        [],
        [
            executor_raw('executor-locked', preflight='failed'),
            executor_raw('executor-allowed'),
            executor_raw('executor-outside', priority=1),
        ],
        [{'decision': {}}],
    ])
    result = await StoreStub(driver).resolve_project_agent_executor(
        actor(),
        personal_space_id='space-1',
        personal_project_id='project-1',
        task_id='task-3',
        agent_id='agent-1',
        work_kind='unmapped-work',
        required_capabilities=['review'],
        task_override=ProjectAgentExecutorPolicy(
            mode='flexible',
            preferred_executor_ids=['executor-outside'],
        ),
        idempotency_key='select-3',
    )
    assert result.status == 'selected'
    assert result.selected_executor_id == 'executor-allowed'
    assert result.candidate_executor_ids == ['executor-locked', 'executor-allowed']

    blocked_driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [agent_raw(policy)],
        [],
        [executor_raw('executor-locked', preflight='failed')],
        [{'decision': {}}],
    ])
    blocked = await StoreStub(blocked_driver).resolve_project_agent_executor(
        actor(),
        personal_space_id='space-1',
        personal_project_id='project-1',
        task_id='task-4',
        agent_id='agent-1',
        work_kind='unmapped-work',
        required_capabilities=['review'],
        idempotency_key='select-4',
    )
    assert blocked.status == 'blocked'
    assert blocked.fallback_outcome == 'blocked_locked'
    assert 'preflight' in blocked.blocked_reason


@pytest.mark.asyncio
async def test_task_executor_override_precedes_assignment_when_agent_is_flexible():
    assignment_policy = ProjectAgentExecutorPolicy(
        mode='locked',
        locked_executor_ids=['executor-assignment'],
    )
    agent = agent_raw()['agent']
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [{
            'agent': agent,
            'assignment': {
                'status': 'active',
                'work_kinds': ['review'],
                'executor_policy_json': assignment_policy.model_dump_json(),
            },
        }],
        [],
        [executor_raw('executor-task'), executor_raw('executor-assignment')],
        [{'decision': {}}],
    ])
    result = await StoreStub(driver).resolve_project_agent_executor(
        actor(),
        personal_space_id='space-1',
        personal_project_id='project-1',
        task_id='task-assignment-precedence',
        agent_id='agent-1',
        work_kind='review',
        required_capabilities=['review'],
        task_override=ProjectAgentExecutorPolicy(
            mode='flexible',
            preferred_executor_ids=['executor-task'],
        ),
        idempotency_key='select-assignment-precedence',
    )
    assert result.selected_executor_id == 'executor-task'
    assert result.model_strategy_source == 'task'


def test_actual_task_report_requires_provider_and_model_and_never_uses_vendor_strategy():
    report = ProjectAgentExecutorActualReport(
        personal_space_id='space-1',
        personal_project_id='project-1',
        task_id='task-1',
        run_id='run-1',
        agent_id='agent-1',
        executor_id='executor-1',
        provider='observed-provider',
        model='observed-model',
        matched_rule_id='rule-1',
        occurred_at=datetime.now(UTC),
        idempotency_key='actual-1',
    )
    assert report.provider == 'observed-provider'
    assert report.model == 'observed-model'


def test_outcome_learning_only_tiebreaks_same_priority_rule_candidates():
    now = datetime.now(UTC)
    rules = [
        ProjectAgentExecutorRoutingRuleRecord(
            rule_id='rule-a',
            scope='project',
            personal_space_id='space-1',
            personal_project_id='project-1',
            work_kind='review',
            executor_ids=['executor-a'],
            reason='same priority A',
            idempotency_key='rule-a-key',
            priority=10,
            created_at=now,
            updated_at=now,
        ),
        ProjectAgentExecutorRoutingRuleRecord(
            rule_id='rule-b',
            scope='project',
            personal_space_id='space-1',
            personal_project_id='project-1',
            work_kind='review',
            executor_ids=['executor-b'],
            reason='same priority B',
            idempotency_key='rule-b-key',
            priority=10,
            created_at=now,
            updated_at=now,
        ),
    ]
    executors = {
        'executor-a': StoreStub._executor_from_row(executor_raw('executor-a'), 'space-1'),
        'executor-b': StoreStub._executor_from_row(executor_raw('executor-b'), 'space-1'),
    }
    selected = StoreStub._tie_break_same_level_candidates(
        ['executor-a', 'executor-b'],
        rules,
        executors,
        {
            'executor-a': {
                'weighted_success': 0.1,
                'weighted_failure': 0.8,
                'neutral_due_to_insufficient_evidence': False,
            },
            'executor-b': {
                'weighted_success': 0.9,
                'weighted_failure': 0.0,
                'neutral_due_to_insufficient_evidence': False,
            },
        },
    )
    assert selected[0] == 'executor-b'

    rules[1] = rules[1].model_copy(update={'priority': 11})
    selected_priority = StoreStub._tie_break_same_level_candidates(
        ['executor-a', 'executor-b'],
        rules,
        executors,
        {
            'executor-b': {
                'weighted_success': 99,
                'weighted_failure': 0,
                'neutral_due_to_insufficient_evidence': False,
            }
        },
    )
    assert selected_priority[0] == 'executor-a'

    same_rule = rules[0].model_copy(update={'executor_ids': ['executor-a', 'executor-b']})
    selected_explicit_order = StoreStub._tie_break_same_level_candidates(
        ['executor-a', 'executor-b'],
        [same_rule],
        executors,
        {
            'executor-b': {
                'weighted_success': 99,
                'weighted_failure': 0,
                'neutral_due_to_insufficient_evidence': False,
            }
        },
    )
    assert selected_explicit_order == ['executor-a', 'executor-b']


@pytest.mark.asyncio
async def test_outcome_aggregate_is_decay_weighted_and_reset_is_non_destructive():
    now = datetime.now(UTC)
    evidence_rows = [
        {
            'evidence': {
                'evidence_id': 'success-1',
                'personal_space_id': 'space-1',
                'personal_project_id': 'project-1',
                'work_kind': 'review',
                'agent_id': 'agent-1',
                'executor_id': 'executor-1',
                'task_id': 'task-1',
                'evidence_kind': 'terminal_outcome',
                'source': 'system_terminal',
                'terminal_outcome': 'completed',
                'occurred_at': now - timedelta(days=1),
                'created_at': now - timedelta(days=1),
                'reference_ids': ['event-1'],
            },
            'reset': None,
        },
        {
            'evidence': {
                'evidence_id': 'terminal-failure-1',
                'personal_space_id': 'space-1',
                'personal_project_id': 'project-1',
                'work_kind': 'review',
                'agent_id': 'agent-1',
                'executor_id': 'executor-1',
                'task_id': 'task-3',
                'evidence_kind': 'terminal_outcome',
                'source': 'system_terminal',
                'terminal_outcome': 'failed',
                'occurred_at': now - timedelta(days=2),
                'created_at': now - timedelta(days=2),
                'reference_ids': ['event-3'],
            },
            'reset': None,
        },
        {
            'evidence': {
                'evidence_id': 'failure-1',
                'personal_space_id': 'space-1',
                'personal_project_id': 'project-1',
                'work_kind': 'review',
                'agent_id': 'agent-1',
                'executor_id': 'executor-1',
                'task_id': 'task-2',
                'evidence_kind': 'test_failed',
                'source': 'test_fact',
                'occurred_at': now - timedelta(days=31),
                'created_at': now - timedelta(days=31),
                'reference_ids': ['test-1'],
            },
            'reset': None,
        },
    ]
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [{'reset': None}],
        evidence_rows,
        [],
    ])
    aggregate = await StoreStub(driver).aggregate_project_agent_executor_outcomes(
        actor(),
        personal_space_id='space-1',
        personal_project_id='project-1',
        work_kind='review',
        executor_id='executor-1',
        agent_id='agent-1',
        as_of=now,
    )
    assert aggregate.sample_count == 3
    assert aggregate.success_count == 1
    assert aggregate.failure_count == 2
    assert aggregate.neutral_due_to_insufficient_evidence is False
    assert aggregate.evidence_refs == [
        'event-1', 'event-3', 'task:task-1', 'task:task-2', 'task:task-3', 'test-1',
    ]
    assert aggregate.evidence_contributions[0].decay_weight > aggregate.evidence_contributions[1].decay_weight
    assert 'FuliProjectAgentExecutorOutcomeAggregate' in driver.calls[3][0]


@pytest.mark.asyncio
async def test_outcome_aggregate_isolated_by_agent_strategy_key_even_if_driver_returns_mixed_rows():
    fast = ProjectAgentModelStrategy(mode='fast', reasoning_effort='low')
    deep = ProjectAgentModelStrategy(mode='deep', reasoning_effort='high')
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [{'reset': None}],
        [
            {'evidence': outcome_raw(fast, evidence_id='fast-evidence'), 'reset': None},
            {'evidence': outcome_raw(deep, evidence_id='deep-evidence'), 'reset': None},
        ],
        [],
    ])
    aggregate = await StoreStub(driver).aggregate_project_agent_executor_outcomes(
        actor(),
        personal_space_id='space-1',
        personal_project_id='project-1',
        work_kind='review',
        executor_id='executor-1',
        agent_id='agent-1',
        model_strategy=fast,
    )
    fast_key = project_agent_model_strategy_key(fast)
    assert aggregate.model_strategy_key == fast_key
    assert aggregate.sample_count == 1
    assert aggregate.evidence_contributions[0].evidence_id == 'fast-evidence'
    assert driver.calls[2][1]['model_strategy_key'] == fast_key
    assert 'model_strategy_key: $model_strategy_key' in driver.calls[2][0]
    assert 'OPTIONAL MATCH (reset' not in driver.calls[2][0]
    assert driver.calls[1][1]['reset_id']


@pytest.mark.asyncio
async def test_record_outcome_recomputes_the_matching_strategy_bucket_immediately():
    strategy = ProjectAgentModelStrategy(mode='fast', reasoning_effort='low')
    raw = outcome_raw(strategy)
    request = ProjectAgentExecutorOutcomeEvidenceCreate(
        personal_space_id='space-1',
        personal_project_id='project-1',
        work_kind='review',
        agent_id='agent-1',
        executor_id='executor-1',
        task_id='task-1',
        run_id='run-1',
        model_strategy=strategy,
        evidence_kind='terminal_outcome',
        source='system_terminal',
        terminal_outcome='completed',
        reference_ids=['event-1'],
        idempotency_key='evidence-fast-1',
        occurred_at=raw['occurred_at'],
    )
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [{'evidence': raw}],
        [{'project': {'project_id': 'project-1'}}],
        [{'reset': None}],
        [{'evidence': raw, 'reset': None}],
        [],
    ])
    evidence = await StoreStub(driver).record_project_agent_executor_outcome_evidence(
        actor(), request
    )
    strategy_key = project_agent_model_strategy_key(strategy)
    assert evidence.model_strategy_key == strategy_key
    assert len(driver.calls) == 6
    assert driver.calls[4][1]['model_strategy_key'] == strategy_key
    assert driver.calls[5][1]['model_strategy_key'] == strategy_key
    assert 'MERGE (aggregate:FuliProjectAgentExecutorOutcomeAggregate' in driver.calls[5][0]


@pytest.mark.asyncio
async def test_ignore_outcome_recomputes_the_matching_strategy_bucket_immediately():
    strategy = ProjectAgentModelStrategy(mode='balanced', reasoning_effort='medium')
    raw = outcome_raw(strategy, ignored=True)
    request = ProjectAgentExecutorEvidenceIgnore(
        personal_space_id='space-1',
        personal_project_id='project-1',
        agent_id='agent-1',
        evidence_id=raw['evidence_id'],
        reason='User excluded this evidence.',
        idempotency_key='ignore-fast-1',
    )
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [{'evidence': raw}],
        [{'project': {'project_id': 'project-1'}}],
        [{'reset': None}],
        [{'evidence': raw, 'reset': None}],
        [],
    ])
    evidence = await StoreStub(driver).ignore_project_agent_executor_outcome_evidence(
        actor(), request
    )
    strategy_key = project_agent_model_strategy_key(strategy)
    assert evidence.ignored is True
    assert evidence.model_strategy_key == strategy_key
    assert len(driver.calls) == 6
    assert driver.calls[4][1]['model_strategy_key'] == strategy_key
    assert driver.calls[5][1]['model_strategy_key'] == strategy_key


@pytest.mark.asyncio
async def test_reset_is_persisted_and_aggregated_in_the_matching_strategy_bucket():
    strategy = ProjectAgentModelStrategy(mode='deep', reasoning_effort='high')
    reset = ProjectAgentExecutorOutcomeReset(
        personal_space_id='space-1',
        personal_project_id='project-1',
        work_kind='review',
        agent_id='agent-1',
        executor_id='executor-1',
        model_strategy=strategy,
        reason='Reset this strategy bucket.',
        idempotency_key='reset-deep-1',
        reset_at=datetime.now(UTC),
    )
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [{}],
        [{'project': {'project_id': 'project-1'}}],
        [{'reset': None}],
        [],
        [],
    ])
    aggregate = await StoreStub(driver).reset_project_agent_executor_outcomes(
        actor(), reset
    )
    strategy_key = project_agent_model_strategy_key(strategy)
    assert aggregate is not None
    assert aggregate.model_strategy_key == strategy_key
    assert driver.calls[1][1]['model_strategy_key'] == strategy_key
    assert driver.calls[4][1]['model_strategy_key'] == strategy_key
    assert 'id: $reset_id' in driver.calls[1][0]


def test_outcome_bucket_ids_include_provider_space_and_complete_bucket():
    strategy_key = project_agent_model_strategy_key(ProjectAgentModelStrategy())
    arguments = [
        'provider-1', 'space-1', 'project-1', 'review',
        'agent-1', 'executor-1', strategy_key,
    ]
    aggregate_id = project_agent_executor_outcome_bucket_id(
        *arguments,
        bucket_kind='aggregate',
    )
    assert aggregate_id == project_agent_executor_outcome_bucket_id(
        *arguments,
        bucket_kind='aggregate',
    )
    for index, replacement in enumerate(
        ['provider-2', 'space-2', 'project-2', 'build', 'agent-2', 'executor-2', 'b' * 64]
    ):
        changed = list(arguments)
        changed[index] = replacement
        assert aggregate_id != project_agent_executor_outcome_bucket_id(
            *changed,
            bucket_kind='aggregate',
        )
    assert aggregate_id != project_agent_executor_outcome_bucket_id(
        *arguments,
        bucket_kind='reset',
    )


@pytest.mark.asyncio
async def test_list_outcome_aggregates_ignores_internal_stable_identity_fields():
    strategy = ProjectAgentModelStrategy()
    strategy_key = project_agent_model_strategy_key(strategy)
    timestamp = datetime.now(UTC)
    aggregate = ProjectAgentExecutorOutcomeAggregate(
        personal_space_id='space-1',
        personal_project_id='project-1',
        work_kind='review',
        agent_id='agent-1',
        executor_id='executor-1',
        model_strategy=strategy,
        model_strategy_key=strategy_key,
        sample_count=0,
        recent_count=0,
        success_count=0,
        rework_count=0,
        failure_count=0,
        rating_count=0,
        as_of=timestamp,
        decay_half_life_days=30,
        weighted_success=0,
        weighted_failure=0,
    )
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [{
            'aggregate': {
                'id': 'internal-id',
                'aggregate_id': 'internal-id',
                'aggregate_json': aggregate.model_dump_json(),
            }
        }],
    ])

    listed = await StoreStub(driver).list_project_agent_executor_outcome_aggregates(
        actor(),
        'space-1',
        personal_project_id='project-1',
    )

    assert listed == [aggregate]


@pytest.mark.asyncio
async def test_actual_executor_is_written_to_task_and_test_agents_can_be_archived():
    actual = ProjectAgentExecutorActualReport(
        personal_space_id='space-1',
        personal_project_id='project-1',
        task_id='task-1',
        run_id='run-1',
        agent_id='agent-1',
        executor_id='executor-1',
        provider='provider',
        model='model',
        occurred_at=datetime.now(UTC),
        idempotency_key='actual-2',
    )
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [{
            'task': {'task_id': 'task-1'},
            'agent': agent_raw()['agent'],
            **executor_raw('executor-1'),
        }],
        [{'observation': {'payload_hash': StoreStub._payload_hash(actual)}}],
        [{'archived_count': 1}],
    ])
    store = StoreStub(driver)
    result = await store.record_project_agent_executor_actual(actor(), actual)
    assert result.executor_id == 'executor-1'
    assert 'MATCH (task)-[:HAS_PARTICIPANT]->(agent)' in driver.calls[1][0]
    archived = await store.archive_test_project_agents(
        actor(),
        'space-1',
        test_source='executor-tests',
    )
    assert archived == 1
    assert 'actual_executor_id' in driver.calls[2][0]
    assert 'status = \'archived\'' in driver.calls[3][0]
    assert 'WITH space, agent' in driver.calls[3][0]
    assert '[:HAS_PROJECT_AGENT_ASSIGNMENT]' in driver.calls[3][0]


@pytest.mark.asyncio
async def test_actual_report_conflict_cannot_update_task_projection_or_edge():
    actual = ProjectAgentExecutorActualReport(
        personal_space_id='space-1',
        personal_project_id='project-1',
        task_id='task-1',
        run_id='run-1',
        agent_id='agent-1',
        executor_id='executor-1',
        provider='provider',
        model='model',
        occurred_at=datetime.now(UTC),
        idempotency_key='actual-conflict',
    )
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [{
            'task': {'task_id': 'task-1'},
            'agent': agent_raw()['agent'],
            **executor_raw('executor-1'),
        }],
        [{
            'observation': {'payload_hash': 'different-payload'},
            'payload_matches': False,
        }],
    ])

    with pytest.raises(HTTPException, match='idempotency key was reused') as error:
        await StoreStub(driver).record_project_agent_executor_actual(actor(), actual)

    assert error.value.status_code == 409
    mutation_query = driver.calls[-1][0]
    guard_position = mutation_query.index('FOREACH')
    assert mutation_query.index(
        'MERGE (task)-[:HAS_EXECUTOR_OBSERVATION]->(observation)'
    ) > guard_position
    assert mutation_query.index('SET task.actual_executor_id') > guard_position


@pytest.mark.asyncio
async def test_actual_report_exact_replay_does_not_reapply_task_projection():
    actual = ProjectAgentExecutorActualReport(
        personal_space_id='space-1',
        personal_project_id='project-1',
        task_id='task-1',
        run_id='run-1',
        agent_id='agent-1',
        executor_id='executor-1',
        provider='provider',
        model='model',
        occurred_at=datetime.now(UTC),
        idempotency_key='actual-replay',
    )
    payload_hash = StoreStub._payload_hash(actual)
    validation = [{
        'task': {'task_id': 'task-1'},
        'agent': agent_raw()['agent'],
        **executor_raw('executor-1'),
    }]
    observation = {
        'payload_hash': payload_hash,
        'projection_applied': True,
    }
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        validation,
        [{'observation': observation, 'payload_matches': True}],
        [{'project': {'project_id': 'project-1'}}],
        validation,
        [{'observation': observation, 'payload_matches': True}],
    ])
    store = StoreStub(driver)

    first = await store.record_project_agent_executor_actual(actor(), actual)
    replay = await store.record_project_agent_executor_actual(actor(), actual)

    assert replay == first
    replay_query = driver.calls[-1][0]
    assert 'AS projection_pending' in replay_query
    assert 'WHEN payload_matches AND projection_pending' in replay_query
    assert 'observation.projection_applied = true' in replay_query


@pytest.mark.asyncio
async def test_actual_report_rejects_executor_outside_locked_agent_policy():
    actual = ProjectAgentExecutorActualReport(
        personal_space_id='space-1',
        personal_project_id='project-1',
        task_id='task-1',
        run_id='run-1',
        agent_id='agent-1',
        executor_id='executor-outside',
        provider='provider',
        model='model',
        occurred_at=datetime.now(UTC),
        idempotency_key='actual-locked',
    )
    locked = ProjectAgentExecutorPolicy(
        mode='locked',
        locked_executor_ids=['executor-allowed'],
    )
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [{
            'task': {'task_id': 'task-1'},
            'agent': agent_raw(locked)['agent'],
            **executor_raw('executor-outside'),
        }],
    ])
    with pytest.raises(HTTPException, match='locked allow-list'):
        await StoreStub(driver).record_project_agent_executor_actual(actor(), actual)


@pytest.mark.asyncio
async def test_actual_report_requires_fallback_reason_when_executor_changed():
    actual = ProjectAgentExecutorActualReport(
        personal_space_id='space-1',
        personal_project_id='project-1',
        task_id='task-1',
        run_id='run-1',
        agent_id='agent-1',
        executor_id='executor-2',
        provider='provider',
        model='model',
        occurred_at=datetime.now(UTC),
        idempotency_key='actual-changed',
    )
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-1'}}],
        [{
            'task': {
                'task_id': 'task-1',
                'selected_executor_id': 'executor-1',
            },
            'agent': agent_raw()['agent'],
            **executor_raw('executor-2'),
        }],
    ])

    with pytest.raises(HTTPException, match='without a fallback reason'):
        await StoreStub(driver).record_project_agent_executor_actual(actor(), actual)
