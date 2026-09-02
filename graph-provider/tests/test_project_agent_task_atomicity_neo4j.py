"""Public HTTP task acceptance with a real disposable Neo4j and one I/O fault."""

import asyncio
from contextlib import asynccontextmanager

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_project_agent_activity_atomicity_neo4j import seed_executor


@pytest.mark.asyncio
async def test_archive_winning_before_participant_link_rolls_back_task(
    monkeypatch,
):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver

    settings = fixture_settings()
    transaction = Neo4jDriver.transaction
    participant_link_reached = asyncio.Event()
    continue_participant_link = asyncio.Event()
    paused = False

    @asynccontextmanager
    async def pause_before_participant_link(driver):
        nonlocal paused
        async with transaction(driver) as current:
            class PausingTransaction:
                async def run(self, query, **kwargs):
                    nonlocal paused
                    if (
                        not paused
                        and 'MERGE (task)-[participant:HAS_PARTICIPANT]' in query
                        and kwargs.get('agent_id') == 'engineer'
                    ):
                        paused = True
                        participant_link_reached.set()
                        await continue_participant_link.wait()
                    return await current.run(query, **kwargs)

            yield PausingTransaction()

    async with provider_client(
        settings, raise_app_exceptions=False,
    ) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic archive/task race', 'kind': 'personal',
        })
        space_id = space.json()['id']
        await seed_agent(client, space_id)
        payload = {
            'personal_space_id': space_id,
            'personal_project_id': 'sample-project',
            'idempotency_key': 'archive-before-participant-link',
            'title': 'Synthetic archive race',
            'objective': 'Prove an archived Agent cannot receive new task work.',
            'work_kind': 'implementation',
            'lead_agent_id': 'engineer',
            'source_application': 'codex',
            'routing_reason': 'Use the explicitly assigned synthetic engineer.',
        }
        with monkeypatch.context() as concurrent:
            concurrent.setattr(
                Neo4jDriver,
                'transaction',
                pause_before_participant_link,
            )
            task_request = asyncio.create_task(
                client.post('/v1/project-agent-tasks', json=payload)
            )
            await asyncio.wait_for(participant_link_reached.wait(), timeout=10)
            archived = await client.delete(
                '/v1/project-agents/engineer',
                params={
                    'personal_space_id': space_id,
                    'reason': 'Synthetic archive won the lifecycle race.',
                },
            )
            assert archived.status_code == 200, archived.text
            continue_participant_link.set()
            task = await asyncio.wait_for(task_request, timeout=10)

        assert task.status_code == 409, task.text
        assert 'participant or recruitment target is unavailable' in task.text
        listed = await client.get('/v1/project-agent-tasks', params={
            'personal_space_id': space_id,
            'personal_project_id': 'sample-project',
        })
        assert listed.status_code == 200, listed.text
        assert listed.json() == []
        agent = await client.get('/v1/project-agents/engineer', params={
            'personal_space_id': space_id,
        })
        assert agent.status_code == 200, agent.text
        assert agent.json()['profile']['status'] == 'archived'
        assert agent.json()['assignments'][0]['status'] == 'ended'


@pytest.mark.asyncio
async def test_participant_link_winning_blocks_concurrent_archive(monkeypatch):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver

    settings = fixture_settings()
    transaction = Neo4jDriver.transaction
    execute_query = Neo4jDriver.execute_query
    participant_link_written = asyncio.Event()
    allow_task_commit = asyncio.Event()
    archive_query_started = asyncio.Event()
    paused = False

    @asynccontextmanager
    async def pause_after_participant_link(driver):
        nonlocal paused
        async with transaction(driver) as current:
            class PausingTransaction:
                async def run(self, query, **kwargs):
                    nonlocal paused
                    result = await current.run(query, **kwargs)
                    if (
                        not paused
                        and 'MERGE (task)-[participant:HAS_PARTICIPANT]' in query
                        and kwargs.get('agent_id') == 'engineer'
                    ):
                        paused = True
                        records = [record async for record in result]
                        participant_link_written.set()
                        await allow_task_commit.wait()

                        async def replay_records():
                            for record in records:
                                yield record

                        return replay_records()
                    return result

            yield PausingTransaction()

    async def observe_archive_query(driver, query, **kwargs):
        if (
            "SET agent.status = 'archived'" in query
            and kwargs.get('agent_id') == 'engineer'
        ):
            archive_query_started.set()
        return await execute_query(driver, query, **kwargs)

    async with provider_client(
        settings, raise_app_exceptions=False,
    ) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic task/archive race', 'kind': 'personal',
        })
        space_id = space.json()['id']
        await seed_agent(client, space_id)
        payload = {
            'personal_space_id': space_id,
            'personal_project_id': 'sample-project',
            'idempotency_key': 'participant-before-archive',
            'title': 'Synthetic task wins archive race',
            'objective': 'Prove non-terminal work prevents concurrent archive.',
            'work_kind': 'implementation',
            'lead_agent_id': 'engineer',
            'source_application': 'codex',
            'routing_reason': 'Use the explicitly assigned synthetic engineer.',
        }
        with monkeypatch.context() as concurrent:
            concurrent.setattr(
                Neo4jDriver,
                'transaction',
                pause_after_participant_link,
            )
            concurrent.setattr(
                Neo4jDriver,
                'execute_query',
                observe_archive_query,
            )
            task_request = asyncio.create_task(
                client.post('/v1/project-agent-tasks', json=payload)
            )
            await asyncio.wait_for(participant_link_written.wait(), timeout=10)
            archive_request = asyncio.create_task(client.delete(
                '/v1/project-agents/engineer',
                params={
                    'personal_space_id': space_id,
                    'reason': 'Synthetic archive must lose this race.',
                },
            ))
            await asyncio.wait_for(archive_query_started.wait(), timeout=10)
            await asyncio.sleep(0.1)
            assert not archive_request.done()
            allow_task_commit.set()
            task = await asyncio.wait_for(task_request, timeout=10)
            archived = await asyncio.wait_for(archive_request, timeout=10)

        assert task.status_code == 200, task.text
        assert archived.status_code == 409, archived.text
        assert 'non-terminal task work' in archived.text
        agent = await client.get('/v1/project-agents/engineer', params={
            'personal_space_id': space_id,
            'personal_project_id': 'sample-project',
        })
        assert agent.status_code == 200, agent.text
        assert agent.json()['profile']['status'] == 'active'
        assert agent.json()['assignments'][0]['status'] == 'active'


@pytest.mark.asyncio
@pytest.mark.parametrize('failure_mode', ['interrupted', 'missing_target'])
@pytest.mark.parametrize('failing_agent', ['engineer', 'reviewer'])
async def test_task_creation_rolls_back_when_participant_persistence_fails(
    monkeypatch, failure_mode, failing_agent,
):
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic atomic task acceptance', 'kind': 'personal',
        })
        space_id = space.json()['id']
        await seed_agent(client, space_id)
        await seed_agent(client, space_id, agent='reviewer')
        fault = fail_one_participant_write(monkeypatch, failure_mode, failing_agent)
        payload = {
            'personal_space_id': space_id, 'personal_project_id': 'sample-project',
            'idempotency_key': 'atomic-task-retry', 'title': 'Synthetic atomic task',
            'objective': 'Verify complete task persistence.', 'work_kind': 'implementation',
            'lead_agent_id': 'engineer', 'source_application': 'codex',
            'collaborator_agent_ids': ['reviewer'],
            'routing_reason': 'Use the explicitly assigned synthetic engineer.',
        }
        failed = await client.post('/v1/project-agent-tasks', json=payload)
        assert fault['fired'], failed.text
        assert failed.status_code == (500 if failure_mode == 'interrupted' else 409), failed.text
        params = {'personal_space_id': space_id, 'personal_project_id': 'sample-project'}
        tasks = await client.get('/v1/project-agent-tasks', params=params)
        assert tasks.status_code == 200, tasks.text
        assert tasks.json() == [], 'failed creation must not publish a task without participants'

        retried = await client.post('/v1/project-agent-tasks', json=payload)
        assert retried.status_code == 200, retried.text
        task = retried.json()['task']
        assert task['lead_agent_id'] == 'engineer'
        assert sorted((item['agent_id'], item['role']) for item in task['participants']) == [
            ('engineer', 'lead'), ('reviewer', 'collaborator')]
        visible = await client.get('/v1/project-agent-tasks', params={**params, 'agent_id': 'engineer'})
        assert [item['task_id'] for item in visible.json()] == [task['task_id']]

        activity = await client.post(f'/v1/project-agent-tasks/{task["task_id"]}/events', json={
            **params, 'task_id': task['task_id'], 'agent_id': 'engineer',
            'idempotency_key': 'atomic-task-progress', 'status': 'cancelled',
            'summary': 'Synthetic cancellation for persistence acceptance.',
            'worker_id': 'synthetic-atomic-worker', 'worker_status': 'cancelled',
            'source_application': 'codex',
        })
        assert activity.status_code == 200, activity.text
        replay = await client.post('/v1/project-agent-tasks', json=payload)
        assert replay.status_code == 200, replay.text
        replayed = replay.json()['task']
        assert replayed['revision'] == activity.json()['revision']
        assert replayed['status'] == 'cancelled'
        assert replayed['participants'] == activity.json()['participants']
        assert replayed['events'] == activity.json()['events']


@pytest.mark.asyncio
async def test_task_creation_failure_rolls_back_pre_task_executor_decision(monkeypatch):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver
    from neo4j import AsyncGraphDatabase

    settings = fixture_settings()
    transaction = Neo4jDriver.transaction
    fault = {'fired': False}

    @asynccontextmanager
    async def fail_initial_task_write(driver):
        async with transaction(driver) as current:
            class FaultingTransaction:
                async def run(self, query, **kwargs):
                    if not fault['fired'] and 'MERGE (task:FuliProjectAgentTask' in query:
                        fault['fired'] = True
                        raise RuntimeError('Synthetic initial task persistence interruption')
                    return await current.run(query, **kwargs)
            yield FaultingTransaction()

    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic pre-task rollback', 'kind': 'personal',
        })
        space_id = space.json()['id']
        await seed_agent(client, space_id)
        await seed_executor(client, space_id)
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            baseline, _, _ = await driver.execute_query('''
                MATCH (decision:FuliProjectAgentExecutorDecision)
                RETURN count(decision) AS count
                ''', routing_='r')
        decision_count_before = baseline[0]['count']
        monkeypatch.setattr(Neo4jDriver, 'transaction', fail_initial_task_write)
        failed = await client.post('/v1/project-agent-tasks', json={
            'personal_space_id': space_id, 'personal_project_id': 'sample-project',
            'idempotency_key': 'pre-task-decision-rollback',
            'title': 'Synthetic pre-task rollback',
            'objective': 'Verify routing decisions share the task transaction.',
            'work_kind': 'implementation', 'lead_agent_id': 'engineer',
            'source_application': 'codex',
            'routing_reason': 'Use the explicitly assigned synthetic engineer.',
        })
        assert fault['fired'], failed.text
        assert failed.status_code == 500, failed.text
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            rows, _, _ = await driver.execute_query('''
                MATCH (decision:FuliProjectAgentExecutorDecision)
                RETURN count(decision) AS count
                ''', routing_='r')
            assert rows[0]['count'] == decision_count_before


@pytest.mark.asyncio
async def test_legacy_link_repair_uses_status_committed_after_its_initial_read(monkeypatch):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver

    settings = fixture_settings()
    transaction = Neo4jDriver.transaction
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic legacy repair acceptance', 'kind': 'personal',
        })
        space_id = space.json()['id']
        await seed_agent(client, space_id)
        await seed_agent(client, space_id, agent='reviewer')
        params = {'personal_space_id': space_id, 'personal_project_id': 'sample-project'}
        payload = {
            **params, 'idempotency_key': 'legacy-task-repair', 'title': 'Synthetic legacy task',
            'objective': 'Verify repair observes concurrent cancellation.',
            'work_kind': 'implementation', 'lead_agent_id': 'engineer',
            'collaborator_agent_ids': ['reviewer'], 'source_application': 'codex',
            'routing_reason': 'Use the explicitly assigned synthetic engineer.',
        }

        @asynccontextmanager
        async def legacy_autocommit(driver):
            # External-driver substitute reproduces the old autocommit-on-each-write release.
            # All writes still originate from the public HTTP task submission.
            class LegacyTransaction:
                async def run(self, query, **kwargs):
                    if ('MERGE (task)-[participant:HAS_PARTICIPANT]' in query
                            and kwargs.get('agent_id') == 'reviewer'):
                        raise RuntimeError('Synthetic legacy second participant interruption')
                    records, _, _ = await driver.execute_query(query, **kwargs)

                    async def result():
                        for record in records:
                            yield record
                    return result()
            yield LegacyTransaction()

        with monkeypatch.context() as legacy:
            legacy.setattr(Neo4jDriver, 'transaction', legacy_autocommit)
            failed = await client.post('/v1/project-agent-tasks', json=payload)
            assert failed.status_code == 500, failed.text
        tasks = await client.get('/v1/project-agent-tasks', params=params)
        assert tasks.status_code == 200, tasks.text
        assert len(tasks.json()) == 1
        partial = tasks.json()[0]
        assert [item['agent_id'] for item in partial['participants']] == ['engineer']
        cancelled = None
        cancellation_started = False

        @asynccontextmanager
        async def cancel_before_repair_transaction(driver):
            nonlocal cancelled, cancellation_started
            if not cancellation_started:
                cancellation_started = True
                cancelled = await client.post(
                    f'/v1/project-agent-tasks/{partial["task_id"]}/events', json={
                        **params, 'task_id': partial['task_id'],
                        'idempotency_key': 'cancel-before-legacy-repair',
                        'status': 'cancelled', 'source_application': 'codex',
                        'summary': 'Synthetic cancellation concurrent with legacy repair.',
                    },
                )
                assert cancelled.status_code == 200, cancelled.text
            async with transaction(driver) as current:
                yield current

        # Cancellation lands after the replay reads its raw task, but before repair takes a lock.
        with monkeypatch.context() as concurrent:
            concurrent.setattr(Neo4jDriver, 'transaction', cancel_before_repair_transaction)
            replay = await client.post('/v1/project-agent-tasks', json=payload)
        assert replay.status_code == 200, replay.text
        repaired = replay.json()['task']
        assert repaired['status'] == 'cancelled'
        assert repaired['revision'] == cancelled.json()['revision']
        assert repaired['events'] == cancelled.json()['events']
        participants = {item['agent_id']: item for item in repaired['participants']}
        assert participants['engineer'] == cancelled.json()['participants'][0]
        assert participants['reviewer']['status'] == 'cancelled'
        assert participants['reviewer']['ended_at'] == repaired['completed_at']
        assert participants['reviewer']['updated_at'] == repaired['updated_at']


def fail_one_participant_write(monkeypatch, failure_mode, failing_agent):
    """Inject only at the external graph driver port; all other I/O stays real."""
    from graphiti_core.driver.neo4j_driver import Neo4jDriver
    execute = Neo4jDriver.execute_query
    transaction = Neo4jDriver.transaction
    fault = {'fired': False}

    def inspect(query, parameters):
        if (not fault['fired'] and parameters.get('agent_id') == failing_agent
                and 'MERGE (task)-[participant:HAS_PARTICIPANT]' in query):
            fault['fired'] = True
            if failure_mode == 'interrupted':
                raise RuntimeError('Synthetic participant persistence interruption')
            return {**parameters, 'agent_id': 'synthetic-absent-agent'}
        return parameters

    async def execute_with_fault(driver, query, **kwargs):
        return await execute(driver, query, **inspect(query, kwargs))

    @asynccontextmanager
    async def transaction_with_fault(driver):
        async with transaction(driver) as current:
            class FaultingTransaction:
                async def run(self, query, **kwargs):
                    return await current.run(query, **inspect(query, kwargs))
            yield FaultingTransaction()

    monkeypatch.setattr(Neo4jDriver, 'execute_query', execute_with_fault)
    monkeypatch.setattr(Neo4jDriver, 'transaction', transaction_with_fault)
    return fault
