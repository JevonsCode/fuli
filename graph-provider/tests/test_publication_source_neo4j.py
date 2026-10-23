"""B7 production deletion transaction, only with explicit disposable Neo4j."""
import json
from uuid import uuid4

import pytest

from fuli_graph.models import StructuredEpisode
from test_knowledge_hard_delete_neo4j import delete, preview, reviewed
from test_models import confirmed_episode
from test_negative_feedback_block_neo4j import query
from test_project_agent_memory_neo4j import provider_client
from test_turn_receipt_neo4j import ok, space_with_projects


@pytest.mark.asyncio
@pytest.mark.parametrize('shared', [False, True])
async def test_all_local_draft_states_follow_the_source_and_pending_submit_is_terminal(shared):
    settings = reviewed()
    marker = 'Synthetic draft source ' + str(uuid4())
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        source = confirmed_episode(idempotency_key=str(uuid4()), source_description=marker,
            source_application='codex', source_turn_id='synthetic-turn')
        if not shared:
            source['entities'] = source['entities'][:1]
            source['relationships'] = []
        source = StructuredEpisode.model_validate(source).model_dump(mode='json')
        saved = ok(await client.post('/v1/knowledge/commits', json={'space_id': space, 'episode': source}))
        drafts = {}
        for status in ('pending', 'submitted', 'kept_personal', 'ignored'):
            # A separate public capture can use a different key for the exact
            # same source turn. Full provenance, not only episode UUID, binds it.
            draft_source = {**source, 'idempotency_key': str(uuid4())} if status == 'ignored' else source
            row = ok(await client.post('/v1/publication-drafts', json={
                'personal_space_id': space, 'target_project_id': status,
                'provider_url': 'https://public.example', 'episode': draft_source}))
            drafts[status] = row['id']
            if status != 'pending':
                decision = {'decision': {'submitted': 'submit_public', 'kept_personal': 'keep_personal', 'ignored': 'ignore'}[status]}
                if status == 'submitted':
                    begun = ok(await client.post(f'/v1/publication-drafts/{row["id"]}/decision',
                        params={'personal_space_id': space}, json={'decision': 'begin_submit_public'}))
                    decision['submission_id'] = begun['submission_id']
                    decision['shared_proposal_id'] = 'synthetic-proposal'
                ok(await client.post(f'/v1/publication-drafts/{row["id"]}/decision',
                    params={'personal_space_id': space}, json=decision))
        plan = ok(await preview(client, space, saved['entity_ids'][0]))
        assert plan['drafts'] == {'pending': 0 if shared else 1, 'submitted': 0 if shared else 1,
                                  'submitting': 0, 'unknown': 0}
        result = ok(await delete(client, space, saved['entity_ids'][0], plan['preview_id']))
        raw = await query(settings, 'MATCH (draft:FuliPublicationDraft {personal_space_id: $space}) RETURN properties(draft) AS draft', space=space)
        assert len(raw) == 4
        for record in raw:
            row = record['draft']
            if shared:
                assert marker in row['payload']
                assert not row.get('payload_scrubbed_by')
            else:
                assert row.get('payload') is None
                assert marker not in repr(row)
                assert row['payload_scrubbed_by'] == result['deletion_id']
                assert json.loads(row['source_identity'])['source_turn_id'] == source['source_turn_id']
        for original, draft_id in drafts.items():
            row = ok(await client.get(f'/v1/publication-drafts/{draft_id}', params={'personal_space_id': space}))
            assert row['status'] == ('source_deleted' if original == 'pending' and not shared else original)
            assert (row['episode'] is None) == (not shared)
        listed = ok(await client.get('/v1/publication-drafts', params={'personal_space_id': space}))
        assert len(listed) == (1 if shared else 0)
        attempted = await client.post(f'/v1/publication-drafts/{drafts["pending"]}/decision',
            params={'personal_space_id': space}, json={'decision': 'begin_submit_public'})
        assert attempted.status_code == (200 if shared else 409)
