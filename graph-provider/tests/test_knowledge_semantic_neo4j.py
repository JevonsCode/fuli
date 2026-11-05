"""rec#88 against an explicitly disposable Neo4j: the meaning index and search
by meaning through the real routes and Cypher. Synthetic projects, items and
vectors only; candidate generation by Graphiti is replaced, nothing else.
"""
from unittest.mock import AsyncMock, patch

import pytest

from fuli_graph.knowledge_semantic import semantic_hash
from test_knowledge_hard_delete_neo4j import delete, preview, reviewed
from test_knowledge_versions_neo4j import edit
from test_project_agent_memory_neo4j import provider_client
from test_turn_receipt_neo4j import commit, confirm, ok, space_with_projects, view

MODEL = 'synthetic-embedding-model'
DIMENSIONS = 40
QUERY = [0.95, 0.31] + [0.0] * (DIMENSIONS - 2)
CLOSE = [0.9, 0.4] + [0.0] * (DIMENSIONS - 2)


def axis(index):
    return [1.0 if position == index else 0.0 for position in range(DIMENSIONS)]


def fact(key, text):
    return {'key': key, 'name': text, 'type': 'ProjectFact', 'summary': text}


async def seeded(client):
    """Alpha holds one item that means the query and enough unrelated ones for
    the floor; beta holds an item that means it too. All confirmed."""
    space_id = await space_with_projects(client, 'alpha', 'beta')
    alpha = await commit(client, space_id, [fact('freeze', 'Synthetic release freeze before quarter end'),
                                            *(fact(f'filler-{index}', f'Synthetic filler note {index}')
                                              for index in range(14))], project='alpha')
    beta = await commit(client, space_id, [fact('beta-freeze', 'Synthetic beta release freeze')], project='beta')
    ids = alpha['entity_ids'] + beta['entity_ids']
    for item_id in ids:
        await confirm(client, space_id, item_id)
    return space_id, ids[0], ids[1:15], ids[15]


async def pending(client, space_id, **fields):
    items, after = [], None
    while True:
        page = ok(await client.post('/v1/semantic/pending', json={
            'personal_space_id': space_id, 'model': MODEL, 'limit': 64, **({'after': after} if after else {}),
            **fields}))
        items += page['items']
        if not page['next']:
            return items
        after = page['next']


async def index(client, space_id, vectors):
    """Store a vector for every pending item: the given one, else a filler axis."""
    items = await pending(client, space_id)
    written = ok(await client.post('/v1/semantic/vectors', json={
        'personal_space_id': space_id, 'model': MODEL, 'items': [
            {'item_kind': row['item_kind'], 'item_id': row['item_id'], 'hash': row['hash'],
             'vector': vectors.get(row['item_id'], axis(2 + position % (DIMENSIONS - 2)))}
            for position, row in enumerate(items)]}))
    assert written['skipped'] == []
    return items


async def search(client, space_id, project='alpha', **fields):
    return ok(await client.post('/v1/search', json={
        'space_ids': [space_id], 'query': 'when may we ship', 'limit': 10,
        'personal_project_ids': [project], 'active_personal_project_id': project,
        'semantic': {'model': MODEL, 'vector': QUERY}, **fields}))


async def item_properties(client, item_id):
    records, _, _ = await client._transport.app.state.store.runtime.driver.execute_query(
        'MATCH (item:Entity {uuid: $id}) RETURN properties(item) AS item', id=item_id)
    return dict(records[0]['item']) if records else None


@pytest.mark.asyncio
async def test_meaning_finds_only_what_lexical_search_may_return_on_neo4j():
    async with provider_client(reviewed()) as (client, _):
        space_id, close, fillers, beta = await seeded(client)
        listed = await index(client, space_id, {close: CLOSE, beta: QUERY})
        assert {row['item_id'] for row in listed} == {close, beta, *fillers}
        assert {row['personal_project_id'] for row in listed} == {'alpha', 'beta'}
        assert ok(await client.post('/v1/semantic/status', json={
            'personal_space_id': space_id, 'model': MODEL})) == {'total': 16, 'done': 16}
        assert await pending(client, space_id) == []
        graphiti = client._transport.app.state.store.runtime.graphiti
        with patch.object(graphiti, 'search', new=AsyncMock(return_value=[])):
            result = await search(client, space_id)
            assert [(row['id'], row['matched_by']) for row in result['entities']] == [(close, 'semantic')]
            # Beta's item means the query exactly, and never reaches alpha.
            assert beta not in {row['id'] for row in (await search(client, space_id, include_historical=True,
                                                                   include_pending=True))['entities']}
            # An edit leaves the old version history with a vector that still
            # fits its text. The new version carries the old vector, whose hash
            # no longer matches its text, so it counts for nothing: neither
            # version comes back, and the old one is never pending again.
            version = (await view(client, space_id, close))['version']
            new_id = ok(await edit(client, space_id, close, 'Synthetic thaw after quarter end',
                                   version=version))['version_item_id']
            copied = await item_properties(client, new_id)
            assert copied['fuli_semantic_hash'] != semantic_hash(f"{copied['name']}\n{copied['summary']}")
            assert close not in {row['item_id'] for row in await pending(client, space_id)}
            assert (await search(client, space_id))['entities'] == []
            # Unrelated query: the floor keeps nothing.
            unrelated = ok(await client.post('/v1/search', json={
                'space_ids': [space_id], 'query': 'banana bread', 'limit': 10, 'personal_project_ids': ['alpha'],
                'active_personal_project_id': 'alpha', 'semantic': {'model': MODEL, 'vector': axis(39)}}))
            assert unrelated['entities'] == []


@pytest.mark.asyncio
async def test_a_vector_write_changes_no_version_and_a_changed_text_is_skipped_on_neo4j():
    async with provider_client(reviewed()) as (client, _):
        space_id, close, _, _ = await seeded(client)
        before_view = await view(client, space_id, close)
        before = await item_properties(client, close)
        [row] = [row for row in await pending(client, space_id) if row['item_id'] == close]
        assert row['hash'] == semantic_hash(row['text'])
        stale = {'item_kind': 'entity', 'item_id': close, 'hash': semantic_hash('Synthetic other text'),
                 'vector': CLOSE}
        assert ok(await client.post('/v1/semantic/vectors', json={
            'personal_space_id': space_id, 'model': MODEL, 'items': [stale]})) == {'written': 0, 'skipped': [close]}
        assert ok(await client.post('/v1/semantic/vectors', json={
            'personal_space_id': space_id, 'model': MODEL,
            'items': [{**stale, 'hash': row['hash']}]}))['written'] == 1
        after = await item_properties(client, close)
        assert {key: value for key, value in after.items() if not key.startswith('fuli_semantic_')} == before
        assert after['fuli_semantic_model'] == MODEL and after['fuli_semantic_hash'] == row['hash']
        assert (await view(client, space_id, close))['version'] == before_view['version']


@pytest.mark.asyncio
async def test_a_permanent_delete_takes_the_vector_with_the_item_on_neo4j():
    async with provider_client(reviewed()) as (client, _):
        space_id, close, _, _ = await seeded(client)
        await index(client, space_id, {close: CLOSE})
        assert (await item_properties(client, close))['fuli_semantic_vector']
        plan = ok(await preview(client, space_id, close))
        ok(await delete(client, space_id, close, plan['preview_id']))
        assert await item_properties(client, close) is None
        records, _, _ = await client._transport.app.state.store.runtime.driver.execute_query(
            'MATCH (item) WHERE item.uuid = $id RETURN count(item) AS left', id=close)
        assert records[0]['left'] == 0
        status = ok(await client.post('/v1/semantic/status', json={'personal_space_id': space_id, 'model': MODEL}))
        assert status == {'total': 15, 'done': 15}
