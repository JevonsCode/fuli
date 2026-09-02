"""Actual executor reports enforce the durable Agent's routing policy."""

from datetime import datetime

import pytest
from fastapi import HTTPException

from fuli_graph.project_agent_executor_models import (
    ProjectAgentExecutorActualReport,
)
from fuli_graph.project_agent_models import ProjectAgentExecutorPolicy
from project_agent_executor_support import (
    UTC,
    SequentialDriver,
    StoreStub,
    actor,
    agent_raw,
    executor_raw,
)


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
