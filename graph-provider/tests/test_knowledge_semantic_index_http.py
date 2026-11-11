"""rec#88: the meaning index routes over a fake graph.

Authorization runs before any graph read, a write checks each item's text in
its own transaction and stores only the three semantic properties, and a
read-only graph refuses the write as every write is refused.
"""
from contextlib import asynccontextmanager

import httpx
import pytest
from fastapi import HTTPException
from neo4j.exceptions import Neo4jError

from fuli_graph.graph_format import GraphFormatState
from fuli_graph.knowledge_semantic import semantic_hash
from fuli_graph.runtime import ManagedNeo4jDriver
from test_graph_format import RecordingClient, RecordingSession, RecordingTransaction
from test_knowledge_hard_delete_http import application

SPACE = 'synthetic-semantic-space'
GROUP = 'synthetic-semantic-group'
MODEL = 'synthetic-embedding-model'
HEADERS = {'authorization': 'Bearer synthetic-agent-access-token'}
CONFIRMED_BASIS = ('{"existence_reason": "Synthetic", "quadrant_reason": "Synthetic", '
                   '"proposed_by": {"kind": "agent"}, "confirmed_by": {"kind": "user"}, '
                   '"confirmed_at": "2026-10-01T00:00:00Z"}')


class IndexGraph:
    """Answers the index's own Cypher for stored items, which the Cypher's
    WHERE already narrowed to current, scoped items of this space."""

    def __init__(self, entities=(), relationships=()):
        self.items = {'entity': {row['id']: dict(row) for row in entities},
                      'relationship': {row['id']: dict(row) for row in relationships}}
        self.queries = []
        self.transactions = 0

    async def execute_query(self, query, **parameters):
        self.queries.append((query, parameters))
        kind = 'entity' if 'item:Entity' in query else 'relationship'
        if 'ORDER BY item.uuid' in query:
            rows = sorted((row for row in self.items[kind].values() if row['id'] > parameters['after']),
                          key=lambda row: row['id'])
            return [{'confirmation_status': 'confirmed', 'confirmation_basis_json': CONFIRMED_BASIS,
                     'personal_project_id': None, 'semantic_model': None, 'semantic_hash': None, **row}
                    for row in rows[:parameters['chunk']]], None, None
        row = self.items[kind].get(parameters['item_id'])
        if row is None:
            return [], None, None
        if 'SET item.fuli_semantic_vector' in query:
            row.update(semantic_vector=parameters['vector'], semantic_model=parameters['model'],
                       semantic_hash=parameters['hash'])
            return [], None, None
        return [row], None, None

    @asynccontextmanager
    async def transaction(self):
        self.transactions += 1
        yield self

    async def run(self, query, **parameters):
        records, _, _ = await self.execute_query(query, **parameters)
        return Rows(records)


class Rows:
    def __init__(self, rows):
        self.rows = rows

    def __aiter__(self):
        async def rows():
            for row in self.rows:
                yield row
        return rows()


def index_app(driver, kind='personal'):
    app = application(driver)

    async def authorize(actor, space_id, role):
        assert actor['id'] == 'principal-1' and role == 'reader'
        if space_id != SPACE:
            raise HTTPException(status_code=403, detail='Synthetic foreign space denied')
        return {'id': SPACE, 'kind': kind, 'group_id': GROUP}

    app.state.store.authorize = authorize
    return app


async def post(app, path, body, headers=HEADERS):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://synthetic.test',
                                 headers=headers) as client:
        return await client.post(path, json=body)


def entity(item_id, name, summary, **fields):
    return {'id': item_id, 'name': name, 'summary': summary, **fields}


def relationship(item_id, fact, **fields):
    return {'id': item_id, 'fact': fact, **fields}


@pytest.mark.asyncio
async def test_pending_lists_unindexed_and_changed_items_with_their_text_and_hash_page_by_page():
    current = semantic_hash('Release freeze\nNo deploys before quarter end')
    graph = IndexGraph(
        [entity('e-1', 'Release freeze', 'No deploys before quarter end', semantic_model=MODEL, semantic_hash=current),
         entity('e-2', 'Staging gate', 'Deploys use the staging gate', personal_project_id='synthetic-project'),
         entity('e-3', 'Retro notes', 'Edited since', semantic_model=MODEL, semantic_hash='0' * 64),
         entity('e-4', 'Other model', 'Indexed by another model', semantic_model='synthetic-other-model',
                semantic_hash=semantic_hash('Other model\nIndexed by another model')),
         entity('e-5', 'Pending', 'Unconfirmed', confirmation_basis_json=None)],
        [relationship('r-1', 'Ships stop the week before a quarter closes')])
    app = index_app(graph)
    first = await post(app, '/v1/semantic/pending', {'personal_space_id': SPACE, 'model': MODEL, 'limit': 2})
    assert first.status_code == 200, first.text
    assert first.json() == {'items': [
        {'item_kind': 'entity', 'item_id': 'e-2', 'personal_project_id': 'synthetic-project',
         'text': 'Staging gate\nDeploys use the staging gate',
         'hash': semantic_hash('Staging gate\nDeploys use the staging gate')},
        {'item_kind': 'entity', 'item_id': 'e-3', 'personal_project_id': None, 'text': 'Retro notes\nEdited since',
         'hash': semantic_hash('Retro notes\nEdited since')}], 'next': 'entity:e-3'}
    second = (await post(app, '/v1/semantic/pending', {'personal_space_id': SPACE, 'model': MODEL, 'limit': 2,
                                                       'after': 'entity:e-3'})).json()
    # An item still waiting for confirmation is indexed too, so a search that asks for pending items finds it by meaning.
    assert [(row['item_kind'], row['item_id']) for row in second['items']] == [('entity', 'e-4'), ('entity', 'e-5')]
    assert second['next'] == 'entity:e-5'
    third = (await post(app, '/v1/semantic/pending', {'personal_space_id': SPACE, 'model': MODEL, 'limit': 2,
                                                      'after': 'entity:e-5'})).json()
    assert [(row['item_kind'], row['item_id'], row['text']) for row in third['items']] == [
        ('relationship', 'r-1', 'Ships stop the week before a quarter closes')]
    assert third['next'] is None
    status = await post(app, '/v1/semantic/status', {'personal_space_id': SPACE, 'model': MODEL})
    assert status.json() == {'total': 6, 'done': 1}


def test_the_index_reads_only_what_default_search_could_return():
    from fuli_graph.knowledge_index_scan import scan_query as _scan_query
    for item_kind, invalid in (('entity', 'item.fuli_invalid_at IS NULL'), ('relationship', 'item.invalid_at IS NULL')):
        query = _scan_query(item_kind)
        assert '{group_id: $group_id}' in query and invalid in query
        assert 'fuli_unresolved_bases' in query and 'FuliKnowledgeAssignment' in query


@pytest.mark.asyncio
async def test_a_write_stores_matching_vectors_skips_changed_text_and_touches_nothing_else():
    graph = IndexGraph([entity('e-1', 'Release freeze', 'Freeze', lock_version=4, version=2, updated_at='kept')],
                       [relationship('r-1', 'Ships stop')])
    before = {kind: {key: dict(row) for key, row in rows.items()} for kind, rows in graph.items.items()}
    app = index_app(graph)
    response = await post(app, '/v1/semantic/vectors', {'personal_space_id': SPACE, 'model': MODEL, 'items': [
        {'item_kind': 'entity', 'item_id': 'e-1', 'hash': semantic_hash('Release freeze\nFreeze'),
         'vector': [0.1, 0.2]},
        {'item_kind': 'relationship', 'item_id': 'r-1', 'hash': semantic_hash('Ships stopped'), 'vector': [0.3, 0.4]},
        {'item_kind': 'entity', 'item_id': 'gone', 'hash': '0' * 64, 'vector': [0.5, 0.6]}]})
    assert response.status_code == 200, response.text
    assert response.json() == {'written': 1, 'skipped': ['r-1', 'gone']}
    assert graph.transactions == 1
    stored = graph.items['entity']['e-1']
    assert {key: stored[key] for key in before['entity']['e-1']} == before['entity']['e-1']
    assert set(stored) - set(before['entity']['e-1']) == {'semantic_vector', 'semantic_model', 'semantic_hash'}
    assert graph.items['relationship'] == before['relationship']
    writes = [query for query, _ in graph.queries if 'SET' in query]
    assert all('revision' not in query.lower() and 'human_change' not in query and 'lock_version' not in query
               and 'updated_at' not in query for query in writes)


@pytest.mark.asyncio
@pytest.mark.parametrize('items', [
    [],
    [{'item_kind': 'entity', 'item_id': 'e-1', 'hash': '0' * 64, 'vector': [0.1]},
     {'item_kind': 'entity', 'item_id': 'e-2', 'hash': '0' * 64, 'vector': [0.1, 0.2]}],
    [{'item_kind': 'entity', 'item_id': f'e-{index}', 'hash': '0' * 64, 'vector': [0.1]} for index in range(65)],
    [{'item_kind': 'entity', 'item_id': 'e-1', 'hash': 'not-a-hash', 'vector': [0.1]}],
    [{'item_kind': 'entity', 'item_id': 'e-1', 'hash': '0' * 64, 'vector': []}],
])
async def test_a_malformed_write_is_refused_before_the_graph(items):
    graph = IndexGraph()
    response = await post(index_app(graph), '/v1/semantic/vectors',
                          {'personal_space_id': SPACE, 'model': MODEL, 'items': items})
    assert response.status_code == 422, response.text
    assert graph.queries == []


@pytest.mark.asyncio
@pytest.mark.parametrize('path,body', [
    ('/v1/semantic/pending', {'model': ''}),
    ('/v1/semantic/pending', {'model': MODEL, 'limit': 65}),
    ('/v1/semantic/status', {'model': MODEL, 'item_id': 'not-accepted'}),
])
async def test_pending_and_status_validate_their_bounds(path, body):
    graph = IndexGraph()
    response = await post(index_app(graph), path, {'personal_space_id': SPACE, **body})
    assert response.status_code == 422, response.text
    assert graph.queries == []


@pytest.mark.asyncio
@pytest.mark.parametrize('headers,space,kind,status', [
    ({}, SPACE, 'personal', 401),
    (HEADERS, 'foreign-space', 'personal', 403),
    (HEADERS, SPACE, 'workspace', 422),
])
@pytest.mark.parametrize('path,body', [
    ('/v1/semantic/pending', {'model': MODEL}),
    ('/v1/semantic/status', {'model': MODEL}),
    ('/v1/semantic/vectors', {'model': MODEL, 'items': [
        {'item_kind': 'entity', 'item_id': 'e-1', 'hash': '0' * 64, 'vector': [0.1]}]}),
])
async def test_every_route_authorizes_the_personal_space_before_the_graph(headers, space, kind, status, path, body):
    graph = IndexGraph([entity('e-1', 'Release freeze', 'Freeze')])
    response = await post(index_app(graph, kind), path, {'personal_space_id': space, **body}, headers=headers)
    assert response.status_code == status, response.text
    assert graph.queries == []


class ReadModeClient(RecordingClient):
    """Neo4j in read access mode: any statement that writes is refused."""

    def session(self, **kwargs):
        self.sessions.append(kwargs)
        return ReadModeSession(self)


class ReadModeSession(RecordingSession):
    async def begin_transaction(self):
        return ReadModeTransaction(self.client)


class ReadModeTransaction(RecordingTransaction):
    async def run(self, query, *args, **kwargs):
        if ' SET ' in f' {query} ':
            raise self.client.error
        return await super().run(query, *args, **kwargs)


@pytest.mark.asyncio
async def test_a_read_only_graph_refuses_the_vector_write_like_every_write():
    refusal = Neo4jError._hydrate_neo4j(code='Neo.ClientError.Statement.AccessMode',
                                        message='Writing in read access mode not allowed')
    client = ReadModeClient(refusal)
    driver = ManagedNeo4jDriver(uri='bolt://127.0.0.1:9', user='neo4j', password='synthetic')
    driver.client = client
    driver.format = GraphFormatState('read', 'pending_confirmation', 4, 'synthetic read-only reason')
    app = index_app(driver)
    response = await post(app, '/v1/semantic/vectors', {'personal_space_id': SPACE, 'model': MODEL, 'items': [
        {'item_kind': 'entity', 'item_id': 'e-1', 'hash': '0' * 64, 'vector': [0.1]}]})
    assert response.status_code == 503, response.text
    assert response.json()['detail']['code'] == 'data_format_read_only'
    # The transaction ran in read access mode, so Neo4j itself refused it.
    assert client.sessions and all(session['default_access_mode'] == 'READ' for session in client.sessions)
