"""B8 reservation and scrub with explicit disposable Neo4j, no remote/model calls."""
from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi import HTTPException

from fuli_graph.knowledge_versions import lock_knowledge
from fuli_graph.provider_values import now_utc
from fuli_graph.models import StructuredEpisode
from fuli_graph.publication_source_copies import drafts_for_sources, scrub_publication_drafts
from fuli_graph.store_transactions import query_store_transaction
from test_knowledge_hard_delete_neo4j import reviewed
from test_models import confirmed_episode
from test_negative_feedback_block_neo4j import query
from test_project_agent_memory_neo4j import provider_client
from test_turn_receipt_neo4j import ok, space_with_projects


@pytest.mark.asyncio
async def test_real_reservation_unknown_reconciliation_and_source_scrub():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client)
        marker = 'Synthetic B8 body ' + str(uuid4())
        episode = confirmed_episode(idempotency_key=str(uuid4()), source_description=marker)
        episode = StructuredEpisode.model_validate(episode).model_dump(mode='json')
        draft = ok(await client.post('/v1/publication-drafts', json={'personal_space_id': space_id,
            'target_project_id': 'synthetic-public', 'provider_url': 'https://public.example', 'episode': episode}))
        endpoint = f'/v1/publication-drafts/{draft["id"]}/decision'
        async def decide(body):
            return await client.post(endpoint, params={'personal_space_id': space_id}, json=body)
        begun = ok(await decide({'decision': 'begin_submit_public'}))
        assert begun['status'] == 'submitting' and begun['episode']
        attempt = begun['submission_id']
        assert (await decide({'decision': 'begin_submit_public'})).status_code == 409
        store = client._transport.app.state.store
        rows = await query(settings, 'MATCH (space:FuliSpace {id: $id}) RETURN space', id=space_id)
        space = dict(rows[0]['space'])
        source = begun['source_identity']
        async with query_store_transaction(store) as scoped:
            await lock_knowledge(scoped, space)
            matches = await drafts_for_sources(scoped, space, [source])
            with pytest.raises(HTTPException) as refusal:
                await scrub_publication_drafts(scoped, space, matches, 'fresh-delete', now_utc())
            assert refusal.value.detail == {'code': 'hard_delete_draft_submitting'}
        unknown = ok(await decide({'decision': 'mark_submission_unknown', 'submission_id': attempt}))
        assert unknown['submission_unknown_at']
        assert (await decide({'decision': 'reconcile_submit_public', 'submission_id': attempt,
                              'lookup_result': None})).status_code == 409
        await query(settings, 'MATCH (draft:FuliPublicationDraft {id: $id}) SET draft.submission_started_at=$at',
                    id=draft['id'], at=now_utc() - timedelta(seconds=121))
        released = ok(await decide({'decision': 'reconcile_submit_public', 'submission_id': attempt, 'lookup_result': None}))
        assert released['status'] == 'pending'
        second = ok(await decide({'decision': 'begin_submit_public'}))
        assert second['submission_id'] != attempt
        # A process lost its response: lazy expiry occurs in the same lock as scrub.
        await query(settings, 'MATCH (draft:FuliPublicationDraft {id: $id}) SET draft.submission_started_at=$at',
                    id=draft['id'], at=now_utc() - timedelta(seconds=121))
        async with query_store_transaction(store) as scoped:
            await lock_knowledge(scoped, space)
            matches = await drafts_for_sources(scoped, space, [source])
            counts = await scrub_publication_drafts(scoped, space, matches, 'expired-delete', now_utc())
        assert counts['unknown'] == 1
        raw = (await query(settings, 'MATCH (draft:FuliPublicationDraft {id:$id}) RETURN properties(draft) AS draft', id=draft['id']))[0]['draft']
        assert raw['status'] == 'source_deleted' and raw['submission_outcome'] == 'unknown'
        assert raw.get('payload') is None and marker not in str(raw)
        assert episode['idempotency_key'] in raw['source_identity']
        assert (await decide({'decision': 'begin_submit_public'})).status_code == 409
        recovered = ok(await decide({'decision': 'reconcile_submit_public', 'submission_id': second['submission_id'],
                                    'lookup_result': {'id': 'remote-receipt', 'status': 'pending'}}))
        assert recovered['status'] == 'source_deleted' and recovered['episode'] is None
        assert recovered['shared_proposal_id'] == 'remote-receipt'


@pytest.mark.asyncio
async def test_real_workspace_lookup_is_owner_scoped_and_payload_free():
    settings = reviewed().model_copy(update={'provider_mode': 'workspace'})
    async with provider_client(settings) as (client, _):
        project = ok(await client.post('/v1/spaces', json={'name': 'Synthetic lookup project', 'kind': 'project'}))['id']
        episode = StructuredEpisode.model_validate(confirmed_episode(idempotency_key=str(uuid4()))).model_dump(mode='json')
        proposal = ok(await client.post(f'/v1/projects/{project}/proposals', json={'episode': episode}))
        endpoint = f'/v1/projects/{project}/proposals/lookup'
        result = ok(await client.get(endpoint, params={'idempotency_key': episode['idempotency_key']}))
        assert result == {'id': proposal['id'], 'status': 'pending'}
        for role in ('contributor', 'reader'):
            principal = ok(await client.post('/v1/principals', json={'name': 'Synthetic ' + role}))
            ok(await client.post(f'/v1/projects/{project}/members',
                                 json={'principal_id': principal['principal_id'], 'role': role}))
            other = await client.get(endpoint, params={'idempotency_key': episode['idempotency_key']},
                headers={'authorization': 'Bearer ' + principal['access_token']})
            if role == 'contributor':
                assert other.status_code == 200 and other.json() is None
            else:
                assert other.status_code == 403
