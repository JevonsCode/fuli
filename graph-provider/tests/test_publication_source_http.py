"""The public draft routes expose submission metadata after local source erasure."""
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
import pytest

from fuli_graph.models import StructuredEpisode
from fuli_graph.publication_source_copies import drafts_for_sources, scrub_publication_drafts, publication_source_identity
from test_knowledge_hard_delete_http import REVIEW_TOKEN, application
from test_models import confirmed_episode


class DraftDriver:
    def __init__(self):
        self.rows = {}
        self.deleted = False
        self.in_transaction = False
        self.locked = False
        self.queries = []
        self.delete_on_lock = False
        # Episodes an FLA wrote, and sources not found at all (0.20.1); every other source is
        # found and plain. The Cypher itself is in test_fla_entry_points_neo4j.py.
        self.project_agent_episodes = set()
        self.project_agent_turns = set()
        self.unresolved_episodes = set()

    @asynccontextmanager
    async def transaction(self):
        self.in_transaction = True
        try:
            yield self
        finally:
            self.in_transaction = self.locked = False

    async def run(self, query, **params):
        rows, _, _ = await self.execute_query(query, **params)
        async def result():
            for row in rows:
                yield row
        return result()

    async def execute_query(self, query, **params):
        self.queries.append(query)
        if '_knowledge_lock' in query:
            assert self.in_transaction
            self.locked = True
            if self.delete_on_lock:
                self.rows['pending'].update(status='source_deleted', payload=None,
                    payload_scrubbed_by='concurrent-delete')
            return [], None, None
        if 'count(trace) > 0 AS deleted' in query:
            assert self.locked
            return [{'deleted': self.deleted}], None, None
        if 'SET draft.payload' in query:
            row = self.rows[params['draft_id']]
            row.update(payload=None, source_identity=params['source_identity'],
                       payload_scrubbed_by=params['deletion_id'], payload_scrubbed_at=params['deleted_at'])
            if row['status'] == 'pending':
                row['status'] = 'source_deleted'
            return [], None, None
        if 'SET draft.status' in query:
            assert self.locked
            row = self.rows.get(params['draft_id'])
            if not row or row['status'] != 'pending':
                return [], None, None
            row.update(status=params['status'], decided_at=params['decided_at'],
                       shared_proposal_id=params['shared_proposal_id'])
            return [{'draft': row.copy()}], None, None
        if 'MERGE (draft:' in query:
            existed = params['id'] in self.rows
            self.rows.setdefault(params['id'], dict(
                id=params['id'], personal_space_id=params['personal_space_id'],
                target_project_id=params['target_project_id'], provider_url=params['provider_url'],
                status='pending', payload=params['payload'], source_identity=params['source_identity'],
                created_at=params['created_at']))
            return [{'draft': self.rows[params['id']].copy(), 'existed': existed}], None, None
        if 'FuliPublicationDraft' in query:
            rows = list(self.rows.values())
            if 'draft_id' in params:
                rows = [row for row in rows if row['id'] == params['draft_id']]
            status = 'pending' if "status: 'pending'" in query else params.get('status')
            if status and status != 'all':
                rows = [row for row in rows if row['status'] == status]
            return [{'draft': row.copy(), 'project_name': None} for row in rows], None, None
        if 'RETURN source.index AS index' in query:
            return [{'index': source['index'], 'project_agent': source['episode_id'] in self.project_agent_episodes
                     or source['turn_id'] in self.project_agent_turns,
                     'found': source['episode_id'] not in self.unresolved_episodes}
                    for source in params['sources']], None, None
        raise AssertionError(query)


def source_episode():
    return StructuredEpisode.model_validate(confirmed_episode()).model_dump(mode="json")


def setup():
    driver = DraftDriver()
    app = application(driver)
    space = {'id': 'space', 'group_id': 'group', 'kind': 'personal'}
    async def authorize(*_args):
        return space
    app.state.store.authorize = authorize
    at = datetime(2026, 10, 23, tzinfo=timezone.utc)
    for state in ('pending', 'submitted', 'kept_personal', 'ignored'):
        driver.rows[state] = dict(id=state, personal_space_id='space', target_project_id='project',
            provider_url='https://public.example', status=state, created_at=at,
            payload=json.dumps(source_episode()), shared_proposal_id='proposal' if state == 'submitted' else None)
    return app, driver, space, at


def client_for(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://provider.test',
        headers={'authorization': 'Bearer synthetic-agent-access-token'}, params={'personal_space_id': 'space'})


@pytest.mark.asyncio
async def test_get_list_and_submit_after_scrub_expose_only_metadata():
    app, driver, space, at = setup()
    identity = publication_source_identity('group', source_episode())
    matches = await drafts_for_sources(app.state.store, space, [identity])
    await scrub_publication_drafts(app.state.store, space, matches, 'deletion', at)
    async with client_for(app) as client:
        assert (await client.get('/v1/publication-drafts')).json() == []
        for state in ('pending', 'submitted', 'kept_personal', 'ignored'):
            response = await client.get('/v1/publication-drafts/' + state)
            assert response.status_code == 200
            result = response.json()
            assert result['episode'] is None
            assert result['source_identity'] == identity
            assert result['payload_scrubbed_by'] == 'deletion'
            assert result['status'] == ('source_deleted' if state == 'pending' else state)
            listed = await client.get('/v1/publication-drafts', params={'personal_space_id': 'space', 'status': result['status']})
            assert listed.json() == [result]
            assert confirmed_episode()['source_description'] not in response.text
        refused = await client.post('/v1/publication-drafts/pending/decision',
            json={'decision': 'begin_submit_public'})
        assert refused.status_code == 409
        assert refused.json()['detail']['code'] == 'publication_draft_not_pending'


@pytest.mark.asyncio
async def test_pending_decision_rechecks_after_acquiring_deletion_lock():
    app, driver, _, _ = setup()
    driver.delete_on_lock = True
    async with client_for(app) as client:
        refused = await client.post('/v1/publication-drafts/pending/decision',
            json={'decision': 'begin_submit_public'})
    assert refused.status_code == 409
    assert driver.rows['pending']['status'] == 'source_deleted'
    assert driver.rows['pending'].get('shared_proposal_id') is None


@pytest.mark.asyncio
async def test_late_draft_creation_checks_tombstone_inside_final_write_transaction():
    app, driver, _, _ = setup()
    driver.deleted = True
    async with client_for(app) as client:
        refused = await client.post('/v1/publication-drafts', json={
            'personal_space_id': 'space', 'target_project_id': 'project',
            'provider_url': 'https://public.example', 'episode': source_episode()})
    assert refused.status_code == 410
    assert refused.json()['detail'] == {'code': 'source_hard_deleted'}
    assert not any('MERGE (draft:' in query for query in driver.queries)


@pytest.mark.asyncio
async def test_an_flas_work_is_never_drafted_and_an_older_draft_of_it_is_the_persons_alone():
    app, driver, _, _ = setup()
    identity = publication_source_identity('group', source_episode())
    driver.project_agent_episodes = {identity['episode_id']}
    async with client_for(app) as client:
        refused = await client.post('/v1/publication-drafts', json={
            'personal_space_id': 'space', 'target_project_id': 'project',
            'provider_url': 'https://public.example', 'episode': source_episode()})
        assert refused.status_code == 422
        assert refused.json()['detail']['code'] == 'project_agent_knowledge_personal_only'
        assert not any('MERGE (draft:' in query for query in driver.queries)
        # Drafts made before this check: no Agent lists, counts, reads or decides them.
        for params in ({'status': 'all'}, {'status': 'all', 'metadata_only': 'true'}, {'status': 'pending'}):
            listed = await client.get('/v1/publication-drafts', params={'personal_space_id': 'space', **params})
            assert listed.status_code == 200 and listed.json() == [], params
        hidden = await client.get('/v1/publication-drafts/pending')
        assert (hidden.status_code, hidden.json()['detail']) == (404, 'publication draft not found')
        assert source_episode()['source_description'] not in hidden.text
        for decision in ('keep_personal', 'ignore', 'begin_submit_public'):
            decided = await client.post('/v1/publication-drafts/pending/decision', json={'decision': decision})
            assert decided.status_code == 404, decision
        assert driver.rows['pending']['status'] == 'pending'
        wrong = await client.get('/v1/publication-drafts', headers={
            'x-fuli-human-review-token': 'synthetic-wrong-review-token-0123456789'})
        assert wrong.status_code == 403
        # The person's console reads them all with its proof.
        owner = await client.get('/v1/publication-drafts', params={'personal_space_id': 'space', 'status': 'all'},
                                 headers={'x-fuli-human-review-token': REVIEW_TOKEN})
        assert {draft['id'] for draft in owner.json()} == {'pending', 'submitted', 'kept_personal', 'ignored'}
        own = await client.get('/v1/publication-drafts/pending', headers={'x-fuli-human-review-token': REVIEW_TOKEN})
        assert own.status_code == 200 and own.json()['episode']['source_description']
        # Neither an erased body nor a missing one makes its source and attempt anyone's to read:
        # scrubbed with its source still named, or without a body and no scrub at all.
        owner_headers = {'x-fuli-human-review-token': REVIEW_TOKEN}
        original = dict(driver.rows['pending'])
        for erased in ({'payload_scrubbed_by': 'deletion', 'status': 'source_deleted'}, {}):
            # An independent row each time, so the second really has no body and no scrub flag.
            driver.rows['pending'] = {**original, 'payload': None, 'source_identity': json.dumps(identity),
                                      'submission_id': 'synthetic-attempt', **erased}
            assert ('payload_scrubbed_by' in driver.rows['pending']) == bool(erased)
            assert driver.rows['pending']['status'] == ('source_deleted' if erased else 'pending')
            for params in ({'status': 'all'}, {'status': 'all', 'metadata_only': 'true'}):
                listed = await client.get('/v1/publication-drafts', params={'personal_space_id': 'space', **params})
                assert 'pending' not in {draft['id'] for draft in listed.json()}, (erased, params)
                assert 'synthetic-attempt' not in listed.text
                # No route writes a body-less draft without the scrub flag, and reading its body in full
                # fails as it did before; the person's metadata list still shows it.
                if erased or params.get('metadata_only'):
                    owner_list = await client.get('/v1/publication-drafts', headers=owner_headers,
                                                  params={'personal_space_id': 'space', **params})
                    assert 'pending' in {draft['id'] for draft in owner_list.json()}
            hidden = await client.get('/v1/publication-drafts/pending')
            assert hidden.status_code == 404 and 'synthetic-attempt' not in hidden.text, erased
            if erased:
                assert (await client.get('/v1/publication-drafts/pending', headers=owner_headers)).json()[
                    'source_identity'] == identity
        # The person settles it on the console's channel, but never starts publishing it.
        driver.rows['pending'].update(status='pending', payload=json.dumps(source_episode()))
        started = await client.post('/v1/publication-drafts/pending/decision', headers=owner_headers,
                                    json={'decision': 'begin_submit_public'})
        assert started.status_code == 422
        assert started.json()['detail']['code'] == 'project_agent_knowledge_personal_only'
        kept = await client.post('/v1/publication-drafts/pending/decision', headers=owner_headers,
                                 json={'decision': 'ignore'})
        assert kept.status_code == 200 and driver.rows['pending']['status'] == 'ignored'
    # A draft of plain work is listed to an Agent as before.
    driver.project_agent_episodes = set()
    async with client_for(app) as client:
        assert len((await client.get('/v1/publication-drafts', params={
            'personal_space_id': 'space', 'status': 'all'})).json()) == 4


@pytest.mark.asyncio
async def test_a_retry_with_another_source_never_returns_an_flas_stored_draft():
    """The draft id binds the key and target, not the session or turn: a retry that omits or alters
    the source must be judged by the stored row, and never change it."""
    app, driver, _, _ = setup()
    owner = {'x-fuli-human-review-token': REVIEW_TOKEN}
    turned = {**source_episode(), 'source_application': 'codex', 'source_turn_id': 'fla-turn'}
    create = {'personal_space_id': 'space', 'target_project_id': 'team', 'provider_url': 'https://public.example'}
    async with client_for(app) as client:
        made = await client.post('/v1/publication-drafts', json={**create, 'episode': turned})
        assert made.status_code == 200
        draft_id = made.json()['id']
        # That turn turns out to be an FLA's: an older draft of its work.
        driver.project_agent_turns = {'fla-turn'}
        stored = dict(driver.rows[draft_id])
        for episode in ({k: v for k, v in turned.items() if k != 'source_turn_id'},
                        {**turned, 'source_turn_id': 'another-turn'}):
            retried = await client.post('/v1/publication-drafts', json={**create, 'episode': episode})
            assert (retried.status_code, retried.json()) == (200, {'status': 'already_exists', 'draft_id': draft_id})
            assert 'fla-turn' not in retried.text
            assert driver.rows[draft_id] == stored, 'a retry never changes the stored row'
        same = await client.post('/v1/publication-drafts', json={**create, 'episode': turned})
        assert same.status_code == 422, 'naming the FLA\'s turn is refused as before'
        own = await client.post('/v1/publication-drafts', headers=owner,
                                json={**create, 'episode': {**turned, 'source_turn_id': 'another-turn'}})
        assert own.status_code == 200 and own.json()['source_identity']['source_turn_id'] == 'fla-turn'


@pytest.mark.asyncio
async def test_a_draft_whose_source_cannot_be_found_is_the_persons_alone_and_never_taken_as_plain():
    """Erased, or never recorded here (a capture made only for a team project): fail closed."""
    app, driver, _, _ = setup()
    identity = publication_source_identity('group', source_episode())
    driver.unresolved_episodes = {identity['episode_id']}
    owner = {'x-fuli-human-review-token': REVIEW_TOKEN}
    async with client_for(app) as client:
        create = {'personal_space_id': 'space', 'target_project_id': 'project',
                  'provider_url': 'https://public.example', 'episode': source_episode()}
        created = await client.post('/v1/publication-drafts', json=create)
        assert created.status_code == 200, 'nothing says it is an FLA\'s, so it is made'
        new_id = created.json()['id']
        # A retry of the same key gets the stored draft back, judged by the stored row: unresolved,
        # so an Agent learns only that it exists (no other key) and nothing changes; the person's retry gets it.
        stored = dict(driver.rows[new_id])
        retried = await client.post('/v1/publication-drafts', json=create)
        assert (retried.status_code, retried.json()) == (200, {'status': 'already_exists', 'draft_id': new_id})
        assert driver.rows[new_id] == stored
        assert (await client.post('/v1/publication-drafts', headers=owner, json=create)).json()['id'] == new_id
        for params in ({'status': 'all'}, {'status': 'all', 'metadata_only': 'true'}):
            listed = await client.get('/v1/publication-drafts', params={'personal_space_id': 'space', **params})
            assert listed.json() == [], params
            owned = await client.get('/v1/publication-drafts', headers=owner,
                                     params={'personal_space_id': 'space', **params})
            assert {draft['id'] for draft in owned.json()} >= {'pending', 'submitted', 'kept_personal', 'ignored'}
        assert (await client.get('/v1/publication-drafts/pending')).status_code == 404
        for decision in ('ignore', 'begin_submit_public'):
            refused = await client.post('/v1/publication-drafts/pending/decision', json={'decision': decision})
            assert refused.status_code == 404, decision
        assert driver.rows['pending']['status'] == 'pending'
        # The person reads and decides it on the console's channel (submission: the Neo4j tests).
        assert (await client.get('/v1/publication-drafts/pending', headers=owner)).status_code == 200
        ignored = await client.post('/v1/publication-drafts/pending/decision', headers=owner, json={'decision': 'ignore'})
        assert ignored.status_code == 200 and driver.rows['pending']['status'] == 'ignored'
    # Intact plain provenance: an Agent lists, reads and decides it as before.
    driver.unresolved_episodes = set()
    async with client_for(app) as client:
        assert (await client.get('/v1/publication-drafts/kept_personal')).status_code == 200
        assert {draft['id'] for draft in (await client.get('/v1/publication-drafts', params={
            'personal_space_id': 'space', 'status': 'all', 'metadata_only': 'true'})).json()} == {
            'pending', 'submitted', 'kept_personal', 'ignored', new_id}
        # A genuine plain retry still returns its own draft.
        plain_retry = await client.post('/v1/publication-drafts', json=create)
        assert plain_retry.status_code == 200 and plain_retry.json()['id'] == new_id


@pytest.mark.asyncio
async def test_metadata_list_returns_legacy_idempotency_without_payload():
    app, driver, _, _ = setup()
    driver.rows['pending']['status'] = 'submission_unknown'
    async with client_for(app) as client:
        result = await client.get('/v1/publication-drafts', params={
            'personal_space_id': 'space', 'status': 'all', 'metadata_only': 'true'})
    assert result.status_code == 200
    assert len(result.json()) == 4
    for draft in result.json():
        assert draft['episode'] is None
        assert draft['source_identity']['idempotency_key'] == source_episode()['idempotency_key']
    assert source_episode()['source_description'] not in result.text
