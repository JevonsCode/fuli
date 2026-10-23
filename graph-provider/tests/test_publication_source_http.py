"""The public draft routes expose submission metadata after local source erasure."""
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
import pytest

from fuli_graph.models import StructuredEpisode
from fuli_graph.publication_source_copies import drafts_for_sources, scrub_publication_drafts, publication_source_identity
from test_knowledge_hard_delete_http import application
from test_models import confirmed_episode


class DraftDriver:
    def __init__(self):
        self.rows = {}
        self.deleted = False
        self.in_transaction = False
        self.locked = False
        self.queries = []
        self.delete_on_lock = False

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
        if 'FuliPublicationDraft' in query:
            rows = list(self.rows.values())
            if 'draft_id' in params:
                rows = [row for row in rows if row['id'] == params['draft_id']]
            status = 'pending' if "status: 'pending'" in query else params.get('status')
            if status:
                rows = [row for row in rows if row['status'] == status]
            return [{'draft': row.copy(), 'project_name': None} for row in rows], None, None
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
            json={'decision': 'submit_public', 'shared_proposal_id': 'late-proposal'})
        assert refused.status_code == 409
        assert refused.json()['detail']['code'] == 'publication_draft_not_pending'


@pytest.mark.asyncio
async def test_pending_decision_rechecks_after_acquiring_deletion_lock():
    app, driver, _, _ = setup()
    driver.delete_on_lock = True
    async with client_for(app) as client:
        refused = await client.post('/v1/publication-drafts/pending/decision',
            json={'decision': 'submit_public', 'shared_proposal_id': 'late-proposal'})
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
