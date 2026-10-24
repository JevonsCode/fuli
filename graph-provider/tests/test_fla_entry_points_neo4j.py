"""The FLA read boundary on the remaining entry points (0.20.1), against an
explicitly disposable Neo4j: preference conflicts, a review decision, a
session's migration preview and publication drafts. FLA G's own items, and
anything naming them, reach neither FLA H nor a plain session, not even as a
count or a page position; the person's console reads them with its proof.
Synthetic data only; public HTTP routes drive every write, except the older
records no route writes any more (noted where they are made)."""

from datetime import datetime, timezone
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from fuli_graph.models import StructuredEpisode
from test_fla_read_boundary_neo4j import AS_G, AS_H, G, H, PROJECT, WRONG_PROOF, Boundary, entity
from test_models import confirmed_episode
from test_project_agent_memory_neo4j import provider_client, seed_agent
from test_session_migration_neo4j import held_session, link_task
from test_session_records_neo4j import Session
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


async def stored_conflict(settings, conflict_id):
    driver = AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password))
    try:
        records, _, _ = await driver.execute_query(
            'MATCH (conflict:FuliPreferenceConflict {id: $id}) RETURN conflict', id=conflict_id)
        return dict(records[0]['conflict']) if records else None
    finally:
        await driver.close()


@pytest.mark.asyncio
async def test_a_conflict_naming_an_flas_item_is_missing_to_another_agents_resolve_defer_and_complete():
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space = await Boundary().build(client, settings)
        resolved, pending = f'conflict-resolved-{uuid4()}', f'conflict-pending-{uuid4()}'
        for conflict_id in (resolved, pending):
            await conflict(settings, space, conflict_id, space.id('fla-habit'), space.id('shared-habit'), AT)
        await write(settings, "MATCH (c:FuliPreferenceConflict {id: $id}) SET c.status = 'resolved', "
                    "c.resolution = 'keep_left', c.resolved_by = 'agent', c.resolution_reason = 'Synthetic.', "
                    "c.resolved_at = $at", id=resolved, at=AT)
        before = {conflict_id: await stored_conflict(settings, conflict_id) for conflict_id in (resolved, pending)}

        async def resolve(conflict_id, reader=None):
            return await client.post(f'/v1/preference-conflicts/{conflict_id}/resolve', json={
                'personal_space_id': space.space_id, 'resolution': 'keep_right', 'reason': 'Synthetic retry.',
                **(reader or {})})

        def defer(reader=None, conflict_id=None, left='fla-habit', headers=None):
            return client.post('/v1/preference-conflicts/defer', headers=headers, json={
                'personal_space_id': space.space_id, 'conflict_id': conflict_id or f'conflict-new-{uuid4()}',
                'preference_key': 'synthetic-habit', 'preference_scope': 'global', 'left_item_id': space.id(left),
                'left_item_kind': 'entity', 'right_item_id': space.id('shared-habit'), 'right_item_kind': 'entity',
                'reason': 'Synthetic defer.', 'operation_actor': 'agent', **(reader or {})})

        def complete(conflict_id, headers=None):
            return client.post(f'/v1/preference-conflicts/{conflict_id}/complete', headers=headers, json={
                'personal_space_id': space.space_id, 'resolution': 'keep_left', 'reason': 'Synthetic.',
                'operation_actor': 'human'})

        missing = (404, 'preference conflict not found')
        for reader in (AS_H, None):
            # The resolved retry wrote nothing before either; it no longer returns the record.
            answer = await resolve(resolved, reader)
            assert (answer.status_code, answer.json()['detail']) == missing, reader
            assert 'Synthetic.' not in answer.text
            assert (await resolve(pending, reader)).status_code == 404, reader
            # A new conflict naming G's item, or G's conflict's id reused with visible items.
            new_id = f'conflict-new-{uuid4()}'
            assert (await defer(reader, new_id)).status_code == 404
            assert await stored_conflict(settings, new_id) is None, 'nothing was written'
            assert (await defer(reader, pending, left='plain-fact')).status_code == 404
        assert (await complete(pending)).status_code == 404, 'no proof: read as a plain session'
        for conflict_id, stored in before.items():
            assert await stored_conflict(settings, conflict_id) == stored, 'nothing changed'
        # G reads its own conflict's retry; the person completes it with the console's proof.
        assert ok(await resolve(resolved, AS_G))['id'] == resolved
        assert ok(await complete(pending, REVIEW))['status'] == 'resolved'
        assert (await complete(resolved, WRONG_PROOF)).status_code == 403


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
        # G's later task of the same session in the project: it is G's, not the plain session's.
        ok(await client.put('/v1/task-contexts', json={
            'personal_space_id': space_id, 'personal_project_id': 'alpha', 'project_agent_id': G,
            'session_id': 'synthetic-migration-session', 'source_application': 'codex',
            'token': f'fuli-task-{uuid4()}', 'turn_id': f'turn-{uuid4()}'}))

        async def preview(reader=None, headers=None, **fields):
            return ok(await client.post('/v1/knowledge/session-migrations/preview', headers=headers, json={
                'personal_space_id': space_id, 'source_application': 'codex', 'session_id': 'synthetic-migration-session',
                'target_project_id': 'alpha', **(reader or {}), **fields}))

        as_alpha = {'reader_project_id': 'alpha'}
        owner = await preview(headers=REVIEW)
        assert owner['held_count'] == 2
        assert {item['item_id'] for item in owner['items']} == {fla['entity_ids'][0], plain['entity_ids'][0]}
        # Each reader counts its own tasks: another FLA's task never makes this one look like a later one.
        assert owner['linked_task_count'] == 2
        for reader, linked in (({**as_alpha, 'reader_agent_id': G}, 1), ({**as_alpha, 'reader_agent_id': H}, 0),
                               (None, 1)):
            assert (await preview(reader, include_items=False))['linked_task_count'] == linked, reader
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


def public_episode(**fields):
    return StructuredEpisode.model_validate(confirmed_episode(**{
        'idempotency_key': f'draft-{uuid4()}', 'source_application': 'codex', **fields})).model_dump(mode='json')


@pytest.mark.asyncio
async def test_an_flas_work_never_becomes_a_publication_draft_and_an_older_one_is_the_persons_alone():
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space = await Boundary().build(client, settings)

        async def draft(episode):
            return await client.post('/v1/publication-drafts', json={
                'personal_space_id': space.space_id, 'target_project_id': 'synthetic-team-project',
                'provider_url': 'https://public.example', 'episode': episode})

        # The same episode G saved personally.
        key = f'fla-episode-{uuid4()}'
        ok(await client.post('/v1/knowledge/commits', json={
            'space_id': space.space_id, 'personal_project_id': PROJECT, 'project_agent_id': G,
            'episode': {'idempotency_key': key, 'session_id': 'synthetic-draft-session', 'name': 'Synthetic G turn',
                        'source_kind': 'task_remember', 'source_description': 'Synthetic G knowledge.',
                        'source_application': 'codex', 'reference_time': '2026-10-24T00:00:00Z',
                        'entities': [entity('fla-draft', 'G drafts the rollout plan')]}}))
        refused = await draft(public_episode(idempotency_key=key, session_id='synthetic-draft-session'))
        assert refused.status_code == 422, refused.text
        assert refused.json()['detail']['code'] == 'project_agent_knowledge_personal_only'
        # A capture from G's turn of a session, and one from a plain turn of the same session.
        session = Session(client, space.space_id, f'native-{uuid4()}')
        await session.begin(PROJECT, G)
        from_g = await draft(public_episode(session_id=session.session_id, source_turn_id=f'{session.session_id}-turn-1'))
        assert from_g.status_code == 422, from_g.text
        await session.begin(PROJECT, None)
        plain = ok(await draft(public_episode(session_id=session.session_id,
                                              source_turn_id=f'{session.session_id}-turn-2')))
        # A draft of G's episode made before the Provider refused them.
        older = f'draft-older-{uuid4()}'
        await write(settings, '''
            MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
            CREATE (space)-[:HAS_PUBLICATION_DRAFT]->(:FuliPublicationDraft {
              id: $id, personal_space_id: $space_id, target_project_id: 'synthetic-team-project',
              provider_url: 'https://public.example', status: 'pending', payload: $payload, created_at: $at})
            ''', space_id=space.space_id, id=older, at=AT,
            payload=StructuredEpisode.model_validate(public_episode(
                idempotency_key=key, session_id='synthetic-draft-session')).model_dump_json())

        async def drafts(headers=None, **params):
            return {row['id'] for row in ok(await client.get('/v1/publication-drafts', headers=headers, params={
                'personal_space_id': space.space_id, 'status': 'all', **params}))}

        assert await drafts(REVIEW) == {plain['id'], older}
        assert await drafts() == {plain['id']}
        assert await drafts(metadata_only='true') == {plain['id']}
        hidden = await client.get(f'/v1/publication-drafts/{older}', params={'personal_space_id': space.space_id})
        assert hidden.status_code == 404
        assert ok(await client.get(f'/v1/publication-drafts/{older}', headers=REVIEW,
                                   params={'personal_space_id': space.space_id}))['id'] == older
        for decision in ('keep_personal', 'begin_submit_public'):
            decided = await client.post(f'/v1/publication-drafts/{older}/decision',
                                        params={'personal_space_id': space.space_id}, json={'decision': decision})
            assert decided.status_code == 404, decision
        assert ok(await client.get(f'/v1/publication-drafts/{plain["id"]}',
                                   params={'personal_space_id': space.space_id}))['status'] == 'pending'
