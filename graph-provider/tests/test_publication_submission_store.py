"""Real store transitions and scrub helper with a synthetic transactional driver."""
from datetime import timedelta

import pytest
from fastapi import HTTPException

from fuli_graph.publication_submission_models import PublicationSubmissionDecision
from fuli_graph.publication_source_copies import scrub_publication_drafts, publication_draft_counts
from test_publication_source_http import setup, DraftDriver
from test_publication_source_http import client_for
from test_knowledge_hard_delete_http import application
from test_publication_submission import NOW


class SubmissionDriver(DraftDriver):
    async def execute_query(self, query, **params):
        if 'SET draft += $updates' in query:
            assert self.in_transaction and self.locked
            row = self.rows[params['draft_id']]
            row.update(params['updates'])
            return [{'draft': row.copy()}], None, None
        if "SET draft.status = 'submission_unknown'" in query:
            assert self.in_transaction and self.locked
            self.rows[params['draft_id']].update(status='submission_unknown',
                submission_unknown_at=params['now'], submission_unknown_reason='ttl')
            return [], None, None
        if 'SET draft.payload' in query:
            row = self.rows[params['draft_id']]
            if row['status'] == 'submission_unknown':
                row.update(status='source_deleted', submission_outcome='unknown')
        return await super().execute_query(query, **params)


def configured():
    app, old, space, _ = setup()
    driver = SubmissionDriver()
    driver.rows = old.rows
    app.state.store.runtime.driver = driver
    return app.state.store, driver, space


@pytest.mark.asyncio
async def test_begin_finish_and_release_use_same_locked_store_transaction():
    store, driver, _ = configured()
    async def decide(body):
        return await store.decide_publication_submission({}, 'space', 'pending', PublicationSubmissionDecision(**body))
    begun = await decide({'decision': 'begin_submit_public'})
    assert begun.status == 'submitting' and begun.submission_id
    assert begun.episode is not None
    assert begun.source_identity['idempotency_key'] == begun.episode.idempotency_key
    with pytest.raises(HTTPException):
        await decide({'decision': 'begin_submit_public'})
    with pytest.raises(HTTPException):
        await decide({'decision': 'submit_public', 'submission_id': 'wrong', 'shared_proposal_id': 'proposal'})
    released = await decide({'decision': 'release_submit_public', 'submission_id': begun.submission_id,
                            'last_submission_error': {'code': 'remote_403'}})
    assert released.status == 'pending' and released.last_submission_error['code'] == 'remote_403'
    second = await decide({'decision': 'begin_submit_public'})
    assert second.submission_id != begun.submission_id
    finished = await decide({'decision': 'submit_public', 'submission_id': second.submission_id,
                            'shared_proposal_id': 'proposal'})
    assert finished.status == 'submitted'
    repeated = await decide({'decision': 'submit_public', 'submission_id': second.submission_id,
                            'shared_proposal_id': 'proposal'})
    assert repeated.model_dump() == finished.model_dump()


@pytest.mark.asyncio
async def test_fresh_reservation_refuses_scrub_and_expired_one_scrubs_as_unknown():
    store, driver, space = configured()
    row = driver.rows['pending']
    row.update(status='submitting', submission_id='attempt', submission_started_at=NOW)
    matches = [{'draft': row.copy(), 'source_identity': {'idempotency_key': 'synthetic-key'}}]
    assert publication_draft_counts(matches, NOW)['submitting'] == 1
    with pytest.raises(HTTPException) as refusal:
        await scrub_publication_drafts(store, space, matches, 'deletion', NOW)
    assert refusal.value.detail == {'code': 'hard_delete_draft_submitting'}
    assert row['payload'] is not None
    later = NOW + timedelta(seconds=121)
    assert publication_draft_counts(matches, later)['unknown'] == 1
    assert matches[0]['draft']['status'] == 'submitting', 'preview cannot mutate stored status/digest'
    async with driver.transaction():
        driver.locked = True
        counts = await scrub_publication_drafts(store, space, matches, 'deletion', later)
    assert counts['unknown'] == 1
    assert row['status'] == 'source_deleted' and row['submission_outcome'] == 'unknown'
    assert row['payload'] is None and 'synthetic-key' in row['source_identity']


@pytest.mark.asyncio
async def test_provider_decision_http_accepts_internal_protocol_and_recovers_unknown():
    store, driver, _ = configured()
    app = application(driver)
    app.state.store.authorize = store.authorize
    async with client_for(app) as client:
        endpoint = '/v1/publication-drafts/pending/decision'
        begun = await client.post(endpoint, json={'decision': 'begin_submit_public'})
        assert begun.status_code == 200
        attempt = begun.json()['submission_id']
        missing_attempt = await client.post(endpoint, json={'decision': 'submit_public', 'shared_proposal_id': 'proposal'})
        assert missing_attempt.status_code == 422
        unknown = await client.post(endpoint, json={'decision': 'mark_submission_unknown', 'submission_id': attempt})
        assert unknown.status_code == 200 and unknown.json()['submission_unknown_at']
        young = await client.post(endpoint, json={'decision': 'reconcile_submit_public',
            'submission_id': attempt, 'lookup_result': None})
        assert young.status_code == 409
        found = await client.post(endpoint, json={'decision': 'reconcile_submit_public',
            'submission_id': attempt, 'lookup_result': {'id': 'remote', 'status': 'pending'}})
        assert found.status_code == 200 and found.json()['shared_proposal_id'] == 'remote'
        assert found.json()['status'] == 'submitted'
