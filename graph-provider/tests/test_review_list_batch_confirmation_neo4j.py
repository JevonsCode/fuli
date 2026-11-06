"""全部确认 on the 待决策 page (Jevons 11-06): the person's pending items, from
any source, are confirmed in one transaction against a disposable Neo4j, each
with its own revision; one item that moved since the read saves nothing.
Synthetic data only."""

from uuid import uuid4

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import commit, confirm, ok, preference, space_with_projects, view


def review_batch(space_id, ids):
    return {
        'personal_space_id': space_id, 'group_kind': 'review', 'group_value': 'pending',
        'reason': 'Synthetic: confirmed everything waiting in the review list.', 'operation_actor': 'human',
        'confirmer': {'kind': 'user', 'label': 'Synthetic user'},
        'items': [{'item_id': item_id, 'item_kind': 'entity', 'existence_reason': 'Synthetic.',
                   'quadrant_reason': 'Synthetic.', 'proposed_by': {'kind': 'agent', 'label': 'Codex'}}
                  for item_id in ids],
    }


async def pending_items(client, space_id, count, label):
    """Items from separate sources, as the review list mixes them."""
    ids = []
    for index in range(count):
        saved = await commit(client, space_id, [preference(f'{label}-{index}', f'Synthetic {label} {index} {uuid4().hex[:6]}')])
        ids.extend(saved['entity_ids'])
    return ids


@pytest.mark.asyncio
async def test_the_review_list_confirms_items_from_every_source_at_once_and_keeps_each_revision():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        ids = await pending_items(client, space_id, 3, 'review')
        result = ok(await client.post('/v1/knowledge/batch-confirmations', json=review_batch(space_id, ids)))
        assert result['confirmed_count'] == 3
        assert result['item_keys'] == [f'entity:{item_id}' for item_id in ids]
        for item_id in ids:
            state = await view(client, space_id, item_id)
            assert state['confirmation_status'] == 'confirmed'
            assert 'batch_confirm' in {revision['action'] for revision in state['revisions']}


@pytest.mark.asyncio
async def test_one_item_confirmed_since_the_read_saves_nothing_from_the_review_batch():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        ids = await pending_items(client, space_id, 3, 'stale')
        await confirm(client, space_id, ids[0])
        response = await client.post('/v1/knowledge/batch-confirmations', json=review_batch(space_id, ids))
        assert response.status_code == 409, response.text
        for item_id in ids[1:]:
            assert (await view(client, space_id, item_id))['confirmation_status'] == 'pending'
