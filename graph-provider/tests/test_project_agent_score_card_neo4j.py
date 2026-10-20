"""Bole's score card on a disposable graph: real task activity in, the card out, nothing written."""

import os
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from test_executor_evidence_neo4j import actual_payload
from test_project_agent_activity_atomicity_neo4j import seed_executor
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


async def checked(client, path, payload, method='post'):
    response = await getattr(client, method)(path, json=payload)
    assert response.status_code == 200, response.text
    return response.json()


async def graph_snapshot(settings, space_id):
    driver = AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password))
    try:
        rows, _, _ = await driver.execute_query(
            '''
            MATCH (node) WITH count(node) AS nodes
            MATCH ()-[relationship]->() WITH nodes, count(relationship) AS relationships
            OPTIONAL MATCH (bucket:FuliProjectAgentExecutorOutcomeAggregate {personal_space_id: $space_id})
            RETURN nodes, relationships, collect(bucket.aggregate_json) AS buckets
            ''', space_id=space_id, routing_='r')
        return dict(rows[0])
    finally:
        await driver.close()


async def verify(client, scope, task, token, *, revision, attempt, outcome):
    """A real verifier run on one artifact revision, then its recorded verdict."""
    run = f'{attempt}-run'
    await checked(client, '/v1/project-agent-executor-actuals', actual_payload(
        scope, task, model='synthetic-strong', artifact_revision=revision,
        run_id=run, idempotency_key=f'{attempt}-actual'))
    return await checked(client, '/v1/agent-verification/record', {
        **scope, 'task_id': task['task_id'], 'artifact_revision': revision, 'task_context_token': token,
        'source_application': 'codex', 'attempt_id': attempt, 'outcome': outcome,
        'evidence_refs': [f'synthetic:{attempt}'], 'executor_id': 'synthetic-executor',
        'provider': 'synthetic', 'model': 'synthetic-strong', 'run_id': run})


async def read_without_writing(settings, client, space_id, path, payload):
    before = await graph_snapshot(settings, space_id)
    result = await checked(client, path, payload)
    assert await graph_snapshot(settings, space_id) == before, 'reading the card wrote to the graph'
    return result


@pytest.mark.asyncio
async def test_score_card_reads_real_task_activity_and_writes_nothing():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = (await checked(client, '/v1/spaces', {
            'name': 'Synthetic score card', 'kind': 'personal'}))['id']
        scope = {'personal_space_id': space_id, 'personal_project_id': 'sample-project'}
        await seed_agent(client, space_id)
        await seed_executor(client, space_id)
        tasks = []
        for index in range(3):
            task = (await checked(client, '/v1/project-agent-tasks', {
                **scope, 'idempotency_key': f'synthetic-score-task-{index}',
                'title': f'Synthetic score task {index}', 'objective': 'Produce recorded outcomes.',
                'work_kind': 'implementation', 'lead_agent_id': 'engineer',
                'source_application': 'codex', 'routing_reason': 'Use the synthetic engineer.',
            }))['task']
            await checked(client, f'/v1/project-agent-tasks/{task["task_id"]}/events', {
                **scope, 'task_id': task['task_id'], 'agent_id': 'engineer',
                'idempotency_key': f'synthetic-score-failed-{index}', 'status': 'failed',
                'summary': 'Synthetic failure.', 'source_application': 'codex',
                'actual_executor_id': 'synthetic-executor',
                'actual_model_provider': 'synthetic', 'actual_model': 'synthetic-model',
            })
            tasks.append(task)
        await checked(client, '/v1/project-agent-routing-outcomes', {
            **scope, 'task_id': tasks[0]['task_id'], 'agent_id': 'engineer',
            'executor_id': 'synthetic-executor', 'work_kind': tasks[0]['work_kind'],
            'model_strategy': tasks[0]['effective_model_strategy'],
            'evidence_kind': 'explicit_praise', 'source': 'user_explicit',
            'reference_ids': ['synthetic:user-note'], 'idempotency_key': 'synthetic-score-praise',
            'occurred_at': datetime.now(UTC).isoformat(),
        })
        # A task whose artifact another run verified, as Tonborg's acceptance requires.
        await checked(client, '/v1/executors/preflight', {
            'personal_space_id': space_id, 'executor_id': 'synthetic-executor', 'status': 'passed',
            'workspace_permission': True, 'capabilities': ['coding'], 'available_models': [
                {'provider': 'synthetic', 'model': 'synthetic-model', 'capabilities': ['coding'],
                 'capability_tier': 1, 'cost_rank': 1},
                {'provider': 'synthetic', 'model': 'synthetic-strong', 'capabilities': ['coding'],
                 'capability_tier': 2, 'cost_rank': 2}],
            'checked_at': datetime.now(UTC).isoformat(), 'idempotency_key': 'synthetic-score-tiers'})
        verified = (await checked(client, '/v1/project-agent-tasks', {
            **scope, 'idempotency_key': 'synthetic-score-verified-task', 'title': 'Synthetic verified task',
            'objective': 'Produce a verified artifact.', 'work_kind': 'implementation',
            'lead_agent_id': 'engineer', 'source_application': 'codex',
            'routing_reason': 'Use the synthetic engineer.', 'complexity_hint': 'simple',
        }))['task']
        context = await checked(client, '/v1/task-contexts', {
            **scope, 'project_agent_id': 'engineer', 'session_id': 'synthetic-score-session',
            'source_application': 'codex', 'token': 'fuli-task-' + uuid4().hex}, method='put')
        passed = await verify(client, scope, verified, context['token'],
                              revision='revision-one', attempt='score-pass', outcome='pass')
        assert passed['status'] == 'passed'

        verdicts = [
            {'task_id': verified['task_id'], 'personal_project_id': 'sample-project', 'result': 'passed',
             'artifact_revision': 'revision-one', 'verification_attempt_id': 'score-pass'},
            # Never verified: the judged evidence cannot be current.
            {'task_id': tasks[1]['task_id'], 'personal_project_id': 'sample-project', 'result': 'passed',
             'artifact_revision': 'revision-one', 'verification_attempt_id': 'score-pass'},
            {'task_id': 'someone-elses-task', 'personal_project_id': 'sample-project', 'result': 'passed',
             'artifact_revision': 'revision-one', 'verification_attempt_id': 'score-pass'},
        ]
        query = {'personal_space_id': space_id, 'agent_id': 'engineer', 'review_verdicts': verdicts}
        card = await read_without_writing(settings, client, space_id, '/v1/project-agent-score-card/query', query)
        dimensions = card['dimensions']
        assert dimensions['completion'] == {'status': 'scored', 'sample': 3, 'passed': 0, 'rate': 0.0,
                                            'tier': {'label': 'C', 'evidence_count': 3}, 'label': None}
        assert [dimensions[name]['status'] for name in ('first_pass', 'user_feedback', 'review')] == \
            ['insufficient_data'] * 3
        assert (dimensions['user_feedback']['sample'], dimensions['review']['sample']) == (1, 1)
        assert (card['stale_review_count'], card['disputed_review_count']) == (1, 0)
        # Three failed runs and the praise; a host review verdict names no executor.
        assert card['executors'] == [{'executor_id': 'synthetic-executor', 'evidence_count': 4}]

        drill = await read_without_writing(settings, client, space_id, '/v1/project-agent-score-card/evidence', {
            'personal_space_id': space_id, 'agent_id': 'engineer', 'dimension': 'completion',
            'personal_project_ids': ['sample-project']})
        assert drill['not_passed']['count'] == 3
        assert sorted(drill['not_passed']['task_ids']) == sorted(task['task_id'] for task in tasks)
        hidden = await client.post('/v1/project-agent-score-card/query', json={
            'personal_space_id': space_id, 'agent_id': 'engineer', 'personal_project_ids': ['other-project']})
        assert hidden.status_code == 404, hidden.text

        # A newer artifact fails verification: the earlier pass is no longer current.
        failed = await verify(client, scope, verified, context['token'],
                              revision='revision-two', attempt='score-fail', outcome='fail')
        assert failed['status'] != 'passed'
        card = await read_without_writing(settings, client, space_id, '/v1/project-agent-score-card/query', query)
        assert (card['dimensions']['review']['sample'], card['stale_review_count']) == (0, 2)
        assert os.getenv('FULI_TEST_NEO4J_EPHEMERAL') == '1'
