"""Shared test doubles for project Agent executor behavior."""

import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from types import SimpleNamespace

from fuli_graph.project_agent_executor_models import (
    ProjectAgentExecutorModelRecord,
    ProjectAgentExecutorRegistration,
    project_agent_model_strategy_key,
)
from fuli_graph.project_agent_models import (
    ProjectAgentExecutorPolicy,
    ProjectAgentModelStrategy,
    ProjectAgentProfile,
)
from fuli_graph.store_project_agent_executors import StoreProjectAgentExecutors


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

    @asynccontextmanager
    async def transaction(self):
        yield self

    async def run(self, query, **parameters):
        rows, _, _ = await self.execute_query(query, **parameters)

        async def result():
            for row in rows:
                yield row
        return result()

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if ('SET bucket._write_lock' in query or 'SET task._outcome_write_lock' in query
                or '._actual_write_lock = true' in query):
            return [], None, None
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
        },
        'assignment': {
            'assignment_id': 'assignment-agent-1',
            'status': 'active',
            'work_kinds': ['review', 'unmapped-work'],
        },
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
