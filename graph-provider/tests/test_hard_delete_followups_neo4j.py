"""rec#34 C9-4/C9-5 on an explicitly disposable loopback graph.

All writes use public provider routes. No remote public provider or model is
called; a submitted publication is a synthetic local receipt only.
"""
from uuid import uuid4

import pytest

from test_knowledge_hard_delete_neo4j import REVIEW, delete, preview, reviewed
from test_project_agent_memory_neo4j import provider_client
from test_turn_receipt_neo4j import commit, ok, space_with_projects


@pytest.mark.asyncio
async def test_integrity_accepts_300_audited_relationship_deletes_and_alerts_unexplained_loss():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        edges = []
        hub = None
        for batch in range(3):
            targets = [{'key': f'target-{batch}-{n}', 'name': f'Synthetic target {batch}-{n}',
                        'type': 'ProjectFact'} for n in range(100)]
            saved = await commit(client, space,
                [{'key': 'hub', 'name': 'Synthetic deletion hub', 'type': 'ProjectFact'}, *targets],
                relationships=[{'key': f'edge-{batch}-{n}', 'source': 'hub', 'target': target['key'],
                                'type': 'CONNECTS', 'fact': 'Synthetic connection'}
                               for n, target in enumerate(targets)])
            hub = saved['entity_ids'][0]
            edges.extend(saved['relationship_ids'])
        inventory = {'personal_space_id': space,
                     'references': [{'kind': 'relationship', 'id': key} for key in edges]}
        before = ok(await client.post('/v1/knowledge/integrity', json=inventory, headers=REVIEW))
        assert before['present_count'] == 300 and before['status'] == 'healthy'
        plan = ok(await preview(client, space, hub))
        assert plan['counts']['relationships'] == 300
        deleted = ok(await delete(client, space, hub, plan['preview_id']))
        after = ok(await client.post('/v1/knowledge/integrity', json=inventory, headers=REVIEW))
        assert after['hard_deleted_count'] == 300
        assert after['present_count'] == after['missing_count'] == 0
        assert after['status'] == 'healthy'
        assert after['deletion_ids'] == [deleted['deletion_id']]
        unexplained = {'kind': 'entity', 'id': str(uuid4())}
        inventory['references'].append(unexplained)
        alerted = ok(await client.post('/v1/knowledge/integrity', json=inventory, headers=REVIEW))
        assert alerted['status'] == 'attention_required'
        assert alerted['missing'] == [unexplained]
        assert alerted['hard_deleted_count'] == 300


@pytest.mark.asyncio
async def test_public_submission_is_bound_into_preview_and_never_retracted_by_local_delete():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        episode = {'idempotency_key': f'synthetic-publication-{uuid4()}', 'session_id': 'synthetic-session',
            'name': 'Synthetic public source', 'source_kind': 'task_remember', 'source_application': 'codex',
            'source_turn_id': 'synthetic-turn', 'source_description': 'Synthetic public confirmation.',
            'reference_time': '2026-10-23T00:00:00Z',
            'entities': [{'key': 'public-fact', 'name': 'Synthetic shared fact', 'type': 'ProjectFact',
                'summary': 'A synthetic fact for the public preview.', 'confirmation_status': 'confirmed',
                'confirmation_basis': {'existence_reason': 'Synthetic.', 'quadrant_reason': 'Synthetic.',
                    'proposed_by': {'kind': 'user'}, 'confirmed_by': {'kind': 'user'},
                    'confirmed_at': '2026-10-23T00:00:00Z'}}]}
        saved = ok(await client.post('/v1/knowledge/commits', json={'space_id': space, 'episode': episode}))
        item_id = saved['entity_ids'][0]
        initial = ok(await preview(client, space, item_id))
        assert initial['publications'] == []
        draft = ok(await client.post('/v1/publication-drafts', json={
            'personal_space_id': space, 'target_project_id': 'synthetic-public-project',
            'provider_url': 'https://public.example', 'episode': episode}))
        pending = ok(await preview(client, space, item_id))
        assert pending['publications'] == []
        submitted = ok(await client.post(f'/v1/publication-drafts/{draft["id"]}/decision',
            params={'personal_space_id': space},
            json={'decision': 'submit_public', 'shared_proposal_id': 'synthetic-public-proposal'}))
        ok(await client.post('/v1/subscriptions', json={'personal_space_id': space,
            'project_id': 'synthetic-public-project', 'provider_url': 'https://public.example',
            'project_name': 'Readable synthetic project'}))
        ok(await client.post('/v1/subscriptions', json={'personal_space_id': space,
            'project_id': 'synthetic-public-project', 'provider_url': 'https://other.example',
            'project_name': 'Wrong provider name'}))
        other_space = await space_with_projects(client)
        ok(await client.post('/v1/subscriptions', json={'personal_space_id': other_space,
            'project_id': 'synthetic-public-project', 'provider_url': 'https://public.example',
            'project_name': 'Wrong space name'}))
        plan = ok(await preview(client, space, item_id))
        assert plan['preview_id'] != initial['preview_id']
        assert len(plan['publications']) == 1
        publication = plan['publications'][0]
        assert publication['draft_id'] == draft['id']
        assert publication['project_name'] == 'Readable synthetic project'
        assert publication['source_episode_ids'] == [saved['episode_id']]
        assert publication['withdrawal_status'] == 'unavailable'
        assert publication['withdrawal_url'] is None
        assert publication['local_delete_retracts'] is False
        stale = await delete(client, space, item_id, initial['preview_id'])
        assert stale.status_code == 409
        ok(await delete(client, space, item_id, plan['preview_id']))
        retained = ok(await client.get(f'/v1/publication-drafts/{draft["id"]}',
                                      params={'personal_space_id': space}))
        # Public submission metadata survives. Do not freeze the existing
        # local payload retention bug into the contract; source deletion's
        # separate get/list regressions must verify its body is redacted.
        for field in ('id', 'status', 'shared_proposal_id', 'provider_url', 'target_project_id'):
            assert retained[field] == submitted[field]
