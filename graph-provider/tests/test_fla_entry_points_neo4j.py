"""The FLA read boundary on the remaining entry points (0.20.1), against an
explicitly disposable Neo4j: preference conflicts, a review decision and a
session's migration preview. FLA G's own items, and
anything naming them, reach neither FLA H nor a plain session, not even as a
count or a page position; the person's console reads them with its proof.
Synthetic data only; public HTTP routes drive every write, except the older
records no route writes any more (noted where they are made)."""

from datetime import datetime, timezone
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from test_fla_read_boundary_neo4j import G, H, PROJECT, WRONG_PROOF, Boundary
from test_project_agent_memory_neo4j import provider_client, seed_agent
from test_session_migration_neo4j import held_session, link_task
from test_turn_receipt_neo4j import REVIEW, commit, ok, reviewed_settings, space_with_projects

AT = datetime(2026, 10, 25, tzinfo=timezone.utc)


async def write(settings, query, **params):
    """A record no route writes any more: one made before the boundary."""
    driver = AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password))
    try:
        await driver.execute_query(query, **params)
    finally:
        await driver.close()


async def conflict(settings, space, conflict_id, left, right, updated_at):
    await write(settings, '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        CREATE (space)-[:HAS_PREFERENCE_CONFLICT]->(:FuliPreferenceConflict {
          id: $id, personal_space_id: $space_id, preference_key: 'synthetic-habit', preference_scope: 'global',
          left_item_id: $left, left_item_kind: 'entity', right_item_id: $right, right_item_kind: 'entity',
          status: 'ai_pending', requested_by: 'agent', reason: 'Synthetic conflict.',
          deferred_at: $at, created_at: $at, updated_at: $at})
        ''', space_id=space.space_id, id=conflict_id, left=left, right=right, at=updated_at)


@pytest.mark.asyncio
async def test_preference_conflicts_naming_an_flas_item_are_the_persons_alone_before_the_page():
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space = await Boundary().build(client, settings)
        plain, fla = f'conflict-plain-{uuid4()}', f'conflict-fla-{uuid4()}'
        await conflict(settings, space, plain, space.id('shared-habit'), space.id('plain-fact'), AT)
        # Newer, so an unfiltered first page would hold it.
        await conflict(settings, space, fla, space.id('fla-habit'), space.id('shared-habit'),
                       AT.replace(hour=1))

        async def listed(headers=None, **params):
            return [row['id'] for row in ok(await client.get('/v1/preference-conflicts', headers=headers, params={
                'personal_space_id': space.space_id, **params}))]

        assert await listed(REVIEW) == [fla, plain]
        assert await listed() == [plain]
        assert await listed(limit=1) == [plain], 'hidden before the page is cut'
        assert await listed(limit=1, offset=1) == []
        assert (await client.get('/v1/preference-conflicts', headers=WRONG_PROOF,
                                 params={'personal_space_id': space.space_id})).status_code == 403


@pytest.mark.asyncio
async def test_a_review_decision_on_an_flas_item_reads_as_none_to_an_agent():
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space = await Boundary().build(client, settings)
        run = ok(await client.post('/v1/knowledge/reviews/start', json={
            'personal_space_id': space.space_id, 'scope': 'project', 'personal_project_id': PROJECT,
            'reviewer': 'tonborg'}))
        keys = {name: f"entity:{space.id(name)}" for name in ('plain-fact', 'fla-fact')}
        # Decisions an older review made, before G's items left the review.
        for name, key in keys.items():
            await write(settings, '''
                MATCH (run:FuliKnowledgeReviewRun {id: $review_id})
                CREATE (run)-[:HAS_REVIEW_DECISION]->(:FuliKnowledgeReviewDecision {
                  id: $id, review_id: $review_id, candidate_key: $key, outcome: 'deferred',
                  created_at: $at, updated_at: $at})
                ''', review_id=run['review_id'], id=f'decision-{name}-{uuid4()}', key=key, at=AT)

        async def decision(key, headers=None):
            return ok(await client.post('/v1/knowledge/reviews/decision', headers=headers, json={
                'personal_space_id': space.space_id, 'review_id': run['review_id'], 'candidate_key': key}))['decision']

        assert (await decision(keys['plain-fact']))['outcome'] == 'deferred'
        assert await decision(keys['fla-fact']) is None
        assert (await decision(keys['fla-fact'], REVIEW))['outcome'] == 'deferred'
        wrong = await client.post('/v1/knowledge/reviews/decision', headers=WRONG_PROOF, json={
            'personal_space_id': space.space_id, 'review_id': run['review_id'], 'candidate_key': keys['fla-fact']})
        assert wrong.status_code == 403


@pytest.mark.asyncio
async def test_a_sessions_migration_offer_neither_counts_nor_lists_an_flas_held_item():
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        await seed_agent(client, space_id, 'alpha', G)
        await seed_agent(client, space_id, 'alpha', H)
        temporary_id = await held_session(client, space_id)
        # G's item first, so it would lead an unfiltered page.
        fla = await commit(client, space_id, [{'key': 'fla-held', 'name': 'G held deploy note', 'type': 'ProjectFact',
                                               'summary': 'G held deploy note'}],
                           project=temporary_id, scope_status='undetermined')
        plain = await commit(client, space_id, [{'key': 'plain-held', 'name': 'Plain held note', 'type': 'ProjectFact',
                                                 'summary': 'Plain held note'}],
                             project=temporary_id, scope_status='undetermined')
        # An FLA's turn saved there: its episode names G (no route writes this today).
        await write(settings, 'MATCH (episode:Episodic {uuid: $episode}) SET episode.fuli_project_agent_id = $agent',
                    episode=fla['episode_id'], agent=G)
        await link_task(client, space_id, 'alpha')

        async def preview(reader=None, headers=None, **fields):
            return ok(await client.post('/v1/knowledge/session-migrations/preview', headers=headers, json={
                'personal_space_id': space_id, 'source_application': 'codex', 'session_id': 'synthetic-migration-session',
                'target_project_id': 'alpha', **(reader or {}), **fields}))

        as_alpha = {'reader_project_id': 'alpha'}
        owner = await preview(headers=REVIEW)
        assert owner['held_count'] == 2
        assert {item['item_id'] for item in owner['items']} == {fla['entity_ids'][0], plain['entity_ids'][0]}
        for reader in ({**as_alpha, 'reader_agent_id': H}, {**as_alpha, 'reader_agent_id': G}, None):
            # G's knowledge belongs to G in the project it was saved in, the temporary one.
            offer = await preview(reader)
            assert offer['held_count'] == 1, reader
            assert [item['item_id'] for item in offer['items']] == plain['entity_ids'], reader
            assert 'G held deploy note' not in str(offer)
            assert (await preview(reader, include_items=False))['held_count'] == 1
            page = await preview(reader, limit=1)
            assert [item['item_id'] for item in page['items']] == plain['entity_ids'], 'hidden before the page'
            assert page['next_offset'] is None
        assert (await client.post('/v1/knowledge/session-migrations/preview', headers=WRONG_PROOF, json={
            'personal_space_id': space_id, 'source_application': 'codex', 'session_id': 'synthetic-migration-session',
            'target_project_id': 'alpha'})).status_code == 403
