"""Real result observations against the explicitly disposable loopback graph."""

import asyncio
from datetime import timedelta
from uuid import uuid4

import pytest

from fuli_graph.provider_values import now_utc
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_system_hr_identity_neo4j import _create_space, _query


async def project(client, space, project_id):
    response = await client.put('/v1/personal-projects', json={
        'personal_space_id': space, 'project_id': project_id,
        'profile': {'name': 'Synthetic ' + project_id, 'lifecycle': 'active',
                    'purpose': 'Synthetic project for memory usage acceptance'},
    })
    assert response.status_code == 200, response.text


async def context(client, space):
    token = 'fuli-task-' + str(uuid4())
    response = await client.put('/v1/task-contexts', json={
        'personal_space_id': space, 'personal_project_id': 'source',
        'source_application': 'codex', 'session_id': str(uuid4()), 'token': token,
    })
    assert response.status_code == 200, response.text
    return dict(personal_space_id=space, task_context_token=token,
        source_application='codex', target_project_id='target', channel='roundtable_answer',
        evidence_id='synthetic-answer', result_count=1)


async def observations(client, space):
    response = await client.get('/v1/project-memory-usage', params={'personal_space_id': space})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_concurrent_results_deduplicate_across_channels_and_do_not_grant_scope():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await _create_space(client, 'Synthetic project usage concurrency')
        for name in ['source', 'target']:
            await project(client, space, name)
        payload = await context(client, space)
        empty = await client.post('/v1/project-memory-usage', json={**payload, 'result_count': 0})
        assert empty.status_code == 200, empty.text
        assert empty.json()['recorded'] is False
        traffic = await client.post('/v1/project-memory-usage', json={**payload, 'channel': 'message_sent'})
        assert traffic.status_code == 422
        assert await observations(client, space) == []
        results = await asyncio.gather(*[client.post('/v1/project-memory-usage', json={
            **payload, 'channel': 'read_extension_result' if i % 2 else 'roundtable_answer',
            'evidence_id': 'synthetic-' + str(i),
        }) for i in range(12)])
        assert all(response.status_code == 200 for response in results), [r.text for r in results]
        assert sum(response.json()['created'] for response in results) == 1
        [observed] = await observations(client, space)
        assert observed['source_project_id'] == 'source'
        assert observed['target_project_id'] == 'target'
        assert observed['statistics']['totalCount'] == 1
        assert observed['statistics']['recent30dCount'] == 1
        assert observed['statistics']['grantsAccess'] is False
        assert await _query(settings, '''MATCH ()-[r:PERSONAL_PROJECT_RELATION]->()
            WHERE r.source_project_id = 'source' AND r.target_project_id = 'target'
            RETURN count(r) AS count''') == [{'count': 0}]


@pytest.mark.asyncio
async def test_same_business_task_across_contexts_counts_once_and_expands_no_authority():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await _create_space(client, 'Synthetic canonical project usage')
        for name in ['source', 'target']:
            await project(client, space, name)
        payloads = [await context(client, space) for _ in range(2)]
        # Retrieval can precede Bole's coordination-task binding in this host.
        initial = await client.post('/v1/project-memory-usage', json=payloads[0])
        assert initial.status_code == 200, initial.text
        await _query(settings, '''
            MATCH (space:FuliSpace {id: $space})-[:HAS_TASK_CONTEXT_SESSION]->()-[:HAS_CONTEXT]->(context:FuliTaskContext)
            WHERE context.token IN $tokens
            MERGE (task:FuliProjectAgentTask {id: $space, task_id: 'synthetic-canonical-task'})
            MERGE (context)-[:COORDINATES_TASK]->(task)
            ''', space=space, tokens=[p['task_context_token'] for p in payloads])
        for payload in reversed(payloads):
            response = await client.post('/v1/project-memory-usage', json=payload)
            assert response.status_code == 200, response.text
            assert (await observations(client, space))[0]['statistics']['totalCount'] == 1
        [observed] = await observations(client, space)
        assert observed['statistics']['totalCount'] == 1
        same = await client.post('/v1/project-memory-usage', json={**payloads[0], 'target_project_id': 'source'})
        assert same.json() == {'recorded': False, 'reason': 'same_project'}
        foreign = await _create_space(client, 'Synthetic foreign space')
        await project(client, foreign, 'foreign-only')
        denied = await client.post('/v1/project-memory-usage', json={**payloads[0], 'target_project_id': 'foreign-only'})
        assert denied.status_code == 404


@pytest.mark.asyncio
async def test_rolling_window_tiers_graph_and_archived_project_filtering():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await _create_space(client, 'Synthetic rolling project usage')
        for name in ['source', 'target']:
            await project(client, space, name)
        for _ in range(10):
            response = await client.post('/v1/project-memory-usage', json=await context(client, space))
            assert response.status_code == 200, response.text
        [observed] = await observations(client, space)
        assert observed['statistics']['tier'] == 'close'
        assert observed['statistics']['suggestKnowledgeReuse'] is True
        graph = await client.get(f'/v1/spaces/{space}/graph', params={'personal_project_id': 'source'})
        assert graph.status_code == 200, graph.text
        edges = [e for e in graph.json()['edges'] if e['type'] == 'PROJECT_MEMORY_ACCESS']
        assert len(edges) == 1 and edges[0]['attributes']['totalCount'] == 10
        await _query(settings, '''
            MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->()-[usage:PROJECT_MEMORY_ACCESS]->()
            SET usage.used_at = $old
            ''', space=space, old=now_utc() - timedelta(days=31))
        [observed] = await observations(client, space)
        assert observed['statistics']['totalCount'] == 10
        assert observed['statistics']['recent30dCount'] == 0
        assert observed['statistics']['tier'] == 'related'
        archived = await client.put('/v1/personal-projects', json={
            'personal_space_id': space, 'project_id': 'target',
            'profile': {'name': 'Synthetic target', 'lifecycle': 'archived'},
        })
        assert archived.status_code == 200, archived.text
        assert await observations(client, space) == []
        denied = await client.post('/v1/project-memory-usage', json=await context(client, space))
        assert denied.status_code == 409
