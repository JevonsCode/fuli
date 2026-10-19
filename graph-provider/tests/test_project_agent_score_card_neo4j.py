"""Bole's score card on a disposable graph: real task activity in, the card out, nothing written."""

import os
from datetime import UTC, datetime

import pytest
from neo4j import AsyncGraphDatabase

from test_project_agent_activity_atomicity_neo4j import seed_executor
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


async def checked(client, path, payload):
    response = await client.post(path, json=payload)
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
        before = await graph_snapshot(settings, space_id)

        verdicts = [
            {'task_id': tasks[1]['task_id'], 'personal_project_id': 'sample-project', 'result': 'passed'},
            {'task_id': 'someone-elses-task', 'personal_project_id': 'sample-project', 'result': 'passed'},
        ]
        card = await checked(client, '/v1/project-agent-score-card/query', {
            'personal_space_id': space_id, 'agent_id': 'engineer', 'review_verdicts': verdicts})
        dimensions = card['dimensions']
        assert dimensions['completion'] == {'status': 'scored', 'sample': 3, 'passed': 0, 'rate': 0.0,
                                            'tier': {'label': 'C', 'evidence_count': 3}, 'label': None}
        assert [dimensions[name]['status'] for name in ('first_pass', 'user_feedback', 'review')] == \
            ['insufficient_data'] * 3
        assert (dimensions['user_feedback']['sample'], dimensions['review']['sample']) == (1, 1)
        # Three failed runs and the praise; a host review verdict names no executor.
        assert card['executors'] == [{'executor_id': 'synthetic-executor', 'evidence_count': 4}]

        drill = await checked(client, '/v1/project-agent-score-card/evidence', {
            'personal_space_id': space_id, 'agent_id': 'engineer', 'dimension': 'completion',
            'personal_project_ids': ['sample-project']})
        assert drill['not_passed']['count'] == 3
        assert sorted(drill['not_passed']['task_ids']) == sorted(task['task_id'] for task in tasks)
        hidden = await client.post('/v1/project-agent-score-card/query', json={
            'personal_space_id': space_id, 'agent_id': 'engineer', 'personal_project_ids': ['other-project']})
        assert hidden.status_code == 404, hidden.text

        assert await graph_snapshot(settings, space_id) == before, 'reading the card wrote to the graph'
        assert os.getenv('FULI_TEST_NEO4J_EPHEMERAL') == '1'
