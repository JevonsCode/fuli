"""AI knowledge-review acceptance against the explicitly disposable Neo4j fixture.

The test exercises the HTTP write path, the graph projection, and the
version-bound content CAS. It only runs when the caller opts into the
loopback fixture with ``FULI_TEST_NEO4J_EPHEMERAL=1``.
"""

import asyncio
import os
from uuid import uuid4

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from fuli_graph.store_transactions import TransactionQueryDriver


pytestmark = pytest.mark.skipif(
    os.getenv('FULI_TEST_NEO4J_EPHEMERAL') != '1',
    reason='requires the explicitly disposable FULI_TEST_NEO4J_EPHEMERAL fixture',
)


def _require_status(response, expected=200):
    assert response.status_code == expected, response.text
    return response.json()


async def _create_review_fixture(client, suffix):
    space_response = await client.post('/v1/spaces', json={
        'name': f'Synthetic Tonborg AI review {suffix}',
        'kind': 'personal',
    })
    space = _require_status(space_response)
    space_id = space['id']
    project_id = f'ai-review-{suffix}'
    project_response = await client.put('/v1/personal-projects', json={
        'personal_space_id': space_id,
        'project_id': project_id,
        'profile': {
            'name': 'Synthetic Tonborg review project',
            'lifecycle': 'active',
        },
    })
    _require_status(project_response)

    entity_key = f'review-fact-{suffix}'
    commit_response = await client.post('/v1/knowledge/commits', json={
        'space_id': space_id,
        'personal_project_id': project_id,
        'episode': {
            'idempotency_key': f'ai-review-episode-{suffix}',
            'session_id': f'ai-review-session-{suffix}',
            'name': 'Synthetic review evidence',
            'source_kind': 'conversation',
            'source_description': 'Synthetic evidence for AI review acceptance.',
            'source_application': 'codex',
            'reference_time': '2026-10-11T00:00:00Z',
            'summary': 'Synthetic evidence for a Tonborg review.',
            'entities': [{
                'key': entity_key,
                'name': 'Synthetic review fact',
                'type': 'ReviewFact',
                'summary': 'The original synthetic statement.',
            }],
            'relationships': [],
        },
    })
    commit = _require_status(commit_response)
    return space_id, project_id, commit['entity_ids'][0]


async def _create_project(client, space_id, project_id, name):
    response = await client.put('/v1/personal-projects', json={
        'personal_space_id': space_id,
        'project_id': project_id,
        'profile': {
            'name': name,
            'lifecycle': 'active',
        },
    })
    _require_status(response)


async def _commit_project_entity(
    client,
    space_id,
    project_id,
    suffix,
    *,
    name,
    summary,
    confirmed=False,
):
    basis = {
        'existence_reason': 'Synthetic fixture evidence is explicit.',
        'quadrant_reason': 'Synthetic fixture content is directly stated.',
        'proposed_by': {'kind': 'user', 'label': 'Synthetic fixture'},
    }
    if confirmed:
        basis.update({
            'confirmed_by': {'kind': 'user', 'label': 'Synthetic fixture'},
            'confirmed_at': '2026-10-11T00:00:00Z',
        })
    response = await client.post('/v1/knowledge/commits', json={
        'space_id': space_id,
        'personal_project_id': project_id,
        'episode': {
            'idempotency_key': f'ai-review-race-episode-{suffix}',
            'session_id': f'ai-review-race-session-{suffix}',
            'name': 'Synthetic race evidence',
            'source_kind': 'conversation',
            'source_description': 'Synthetic evidence for AI review race coverage.',
            'source_application': 'codex',
            'reference_time': '2026-10-11T00:00:00Z',
            'summary': 'Synthetic evidence for an AI review race.',
            'entities': [{
                'key': f'race-fact-{suffix}',
                'name': name,
                'type': 'ReviewFact',
                'summary': summary,
                **({
                    'confirmation_status': 'confirmed',
                    'confirmation_basis': basis,
                } if confirmed else {}),
            }],
            'relationships': [],
        },
    })
    commit = _require_status(response)
    return commit['entity_ids'][0]


async def _create_race_fixture(client, suffix):
    response = await client.post('/v1/spaces', json={
        'name': f'Synthetic Tonborg AI review race {suffix}',
        'kind': 'personal',
    })
    space_id = _require_status(response)['id']
    source_project_id = f'ai-race-source-{suffix}'
    target_project_id = f'ai-race-target-{suffix}'
    await _create_project(
        client, space_id, source_project_id, 'Synthetic race source project'
    )
    await _create_project(
        client, space_id, target_project_id, 'Synthetic race target project'
    )
    return space_id, source_project_id, target_project_id


async def _post_ai_review_progress(
    client, space_id, review_id, candidate,
):
    return await client.post('/v1/knowledge/reviews/progress', json={
        'personal_space_id': space_id,
        'review_id': review_id,
        'candidate_key': candidate['candidate_key'],
        'outcome': 'ai_reviewed',
        'ai_review_evidence_token': candidate['ai_review_evidence_token'],
        'ai_assessment': {
            'outcome': 'approve',
            'summary': 'The synthetic statement remains supported.',
            'evidence': ['The current entity content is the reviewed statement.'],
            'confidence': 0.91,
            'client': 'codex',
            'model': 'synthetic-review-model',
        },
    })


async def _post_project_action(
    client, space_id, item_id, target_project_id, reason,
):
    return await client.post(
        f'/v1/knowledge/items/{item_id}/project-action',
        json={
            'personal_space_id': space_id,
            'mode': 'existing',
            'target_project_id': target_project_id,
            'conflict_resolution': 'defer',
            'keep_source_relation': False,
            'reason': reason,
            'operation_actor': 'agent',
        },
    )


async def _start_tonborg_review(client, space_id, project_id):
    response = await client.post('/v1/knowledge/reviews/start', json={
        'personal_space_id': space_id,
        'scope': 'project',
        'personal_project_id': project_id,
        'reviewer': 'tonborg',
    })
    return _require_status(response)


async def _read_candidate(client, space_id, review_id, item_id):
    response = await client.post('/v1/knowledge/reviews/candidates', json={
        'personal_space_id': space_id,
        'review_id': review_id,
        'limit': 10,
    })
    page = _require_status(response)
    candidate = next(
        candidate for candidate in page['candidates']
        if candidate['item_id'] == item_id
    )
    return candidate


async def _read_graph_node(client, space_id, project_id, item_id):
    params = {'personal_project_id': project_id} if project_id else {}
    response = await client.get(f'/v1/spaces/{space_id}/graph', params=params)
    graph = _require_status(response)
    return next(node for node in graph['nodes'] if node['id'] == item_id)


async def _revise_summary(client, space_id, project_id, item_id, summary, reason):
    response = await client.patch(
        f'/v1/knowledge/items/{item_id}',
        json={
            'personal_space_id': space_id,
            'personal_project_id': project_id,
            'item_kind': 'entity',
            'action': 'update',
            'reason': reason,
            'summary': summary,
        },
    )
    return _require_status(response)


@pytest.mark.asyncio
async def test_real_neo4j_ai_review_write_projection_and_content_cas():
    settings = fixture_settings()
    suffix = uuid4().hex

    async with provider_client(settings, raise_app_exceptions=True) as (client, _):
        space_id, project_id, item_id = await _create_review_fixture(client, suffix)

        first_run = await _start_tonborg_review(client, space_id, project_id)
        first_candidate = await _read_candidate(
            client, space_id, first_run['review_id'], item_id
        )
        assert first_candidate['ai_review_evidence_token']
        first_progress = await client.post('/v1/knowledge/reviews/progress', json={
            'personal_space_id': space_id,
            'review_id': first_run['review_id'],
            'candidate_key': first_candidate['candidate_key'],
            'outcome': 'ai_reviewed',
            'ai_review_evidence_token': first_candidate['ai_review_evidence_token'],
            'ai_assessment': {
                'outcome': 'approve',
                'summary': 'The synthetic statement remains supported.',
                'evidence': ['The current entity content is the reviewed statement.'],
                'confidence': 0.91,
                'client': 'codex',
                'model': 'synthetic-review-model',
            },
        })
        decision = _require_status(first_progress)
        assert decision['outcome'] == 'ai_reviewed'
        assert decision['ai_review_evidence_token'] == (
            first_candidate['ai_review_evidence_token']
        )

        projected = await _read_graph_node(client, space_id, project_id, item_id)
        assert projected['confirmation_status'] == 'pending'
        assert projected['ai_review_evidence_token'] == (
            first_candidate['ai_review_evidence_token']
        )
        assert projected['ai_assessment']['outcome'] == 'approve'
        assert projected['ai_assessment']['client'] == 'codex'
        assert projected['ai_review_scope'] == 'project'
        assert projected['ai_review_project_id'] == project_id

        projected_all_space = await _read_graph_node(
            client, space_id, None, item_id
        )
        assert projected_all_space['ai_assessment']['outcome'] == 'approve'
        assert projected_all_space['ai_review_scope'] == 'project'
        assert projected_all_space['ai_review_project_id'] == project_id

        await _revise_summary(
            client,
            space_id,
            project_id,
            item_id,
            'The edited synthetic statement.',
            'Synthetic content changed after the AI review.',
        )
        invalidated = await _read_graph_node(
            client, space_id, project_id, item_id
        )
        assert invalidated['ai_assessment'] is None
        assert invalidated['ai_reviewed_at'] is None

        finished = await client.post('/v1/knowledge/reviews/finish', json={
            'personal_space_id': space_id,
            'review_id': first_run['review_id'],
            'disposition': 'completed',
        })
        _require_status(finished)

        second_run = await _start_tonborg_review(client, space_id, project_id)
        second_candidate = await _read_candidate(
            client, space_id, second_run['review_id'], item_id
        )
        await _revise_summary(
            client,
            space_id,
            project_id,
            item_id,
            'The second edited synthetic statement.',
            'Synthetic content changed before the stale AI write.',
        )
        stale_progress = await client.post('/v1/knowledge/reviews/progress', json={
            'personal_space_id': space_id,
            'review_id': second_run['review_id'],
            'candidate_key': second_candidate['candidate_key'],
            'outcome': 'ai_reviewed',
            'ai_review_evidence_token': second_candidate['ai_review_evidence_token'],
            'ai_assessment': {
                'outcome': 'approve',
                'summary': 'This write must be rejected after the edit.',
                'evidence': ['The candidate token is intentionally stale.'],
                'confidence': 0.8,
                'client': 'codex',
                'model': 'synthetic-review-model',
            },
        })
        stale = _require_status(stale_progress, expected=409)
        assert 'evidence changed' in stale['detail']


@pytest.mark.asyncio
async def test_real_neo4j_reference_change_serializes_with_ai_review_write():
    settings = fixture_settings()
    suffix = uuid4().hex

    async with provider_client(settings, raise_app_exceptions=True) as (client, _):
        space_id, source_project_id, target_project_id = await _create_race_fixture(
            client, suffix
        )
        item_id = await _commit_project_entity(
            client,
            space_id,
            source_project_id,
            suffix,
            name='Synthetic reference race fact',
            summary='The source project statement.',
        )
        run = await _start_tonborg_review(client, space_id, source_project_id)
        candidate = await _read_candidate(client, space_id, run['review_id'], item_id)

        snapshot_ready = asyncio.Event()
        allow_review_commit = asyncio.Event()
        original_execute_query = TransactionQueryDriver.execute_query

        async def gated_execute_query(self, query, **kwargs):
            records = await original_execute_query(self, query, **kwargs)
            if (
                'fuli_ai_review_lock_version' in query
                and 'OPTIONAL MATCH (episode:Episodic' in query
                and not snapshot_ready.is_set()
            ):
                snapshot_ready.set()
                await allow_review_commit.wait()
            return records

        TransactionQueryDriver.execute_query = gated_execute_query
        progress_task = asyncio.create_task(
            _post_ai_review_progress(client, space_id, run['review_id'], candidate)
        )
        action_task = None
        try:
            await asyncio.wait_for(snapshot_ready.wait(), timeout=5)
            action_task = asyncio.create_task(
                _post_project_action(
                    client,
                    space_id,
                    item_id,
                    target_project_id,
                    'Synthetic active project reference race.',
                )
            )
            await asyncio.sleep(0.1)
            assert not action_task.done(), (
                'reference writer completed while review transaction held its item lock'
            )
            allow_review_commit.set()
            progress, action = await asyncio.gather(progress_task, action_task)
        finally:
            allow_review_commit.set()
            TransactionQueryDriver.execute_query = original_execute_query
            if action_task is not None and not action_task.done():
                await action_task
            if not progress_task.done():
                await progress_task

        assert action.status_code == 200, action.text
        assert action.json()['reference']['status'] == 'active'
        assert progress.status_code in {200, 409}, progress.text
        if progress.status_code == 409:
            assert 'evidence changed' in progress.json()['detail']
        projected = await _read_graph_node(
            client, space_id, source_project_id, item_id
        )
        assert projected['ai_assessment'] is None


@pytest.mark.asyncio
async def test_real_neo4j_pending_conflict_serializes_with_ai_review_write():
    settings = fixture_settings()
    suffix = uuid4().hex

    async with provider_client(settings, raise_app_exceptions=True) as (client, _):
        space_id, source_project_id, target_project_id = await _create_race_fixture(
            client, suffix
        )
        source_item_id = await _commit_project_entity(
            client,
            space_id,
            source_project_id,
            f'{suffix}-source',
            name='Synthetic conflict race fact',
            summary='The source project statement.',
            confirmed=True,
        )
        await _commit_project_entity(
            client,
            space_id,
            target_project_id,
            f'{suffix}-target',
            name='Synthetic conflict race fact',
            summary='A different target project statement.',
            confirmed=True,
        )
        run = await _start_tonborg_review(client, space_id, source_project_id)
        candidate = await _read_candidate(
            client, space_id, run['review_id'], source_item_id
        )

        progress, action = await asyncio.gather(
            _post_ai_review_progress(client, space_id, run['review_id'], candidate),
            _post_project_action(
                client,
                space_id,
                source_item_id,
                target_project_id,
                'Synthetic pending conflict race.',
            ),
        )

        assert action.status_code == 200, action.text
        action_payload = action.json()
        assert action_payload['reference']['status'] == 'pending_conflict'
        assert action_payload['conflict']['status'] == 'pending'
        assert progress.status_code in {200, 409}, progress.text
        if progress.status_code == 409:
            assert 'evidence changed' in progress.json()['detail']
        projected = await _read_graph_node(
            client, space_id, source_project_id, source_item_id
        )
        assert projected['ai_assessment'] is None
