"""rec#92: retrieval terms stored beside old knowledge, over fake graphs.

Candidates are the items default search could return, with their own words
and the hash of them; a write stores terms only beside the words they were
made from, touches nothing else, and both word search and the meaning index
read them. Synthetic data only.
"""
import pytest

from fuli_graph.knowledge_search import _relevance
from fuli_graph.knowledge_semantic import item_text, semantic_hash, semantic_text
from test_knowledge_semantic_index_http import IndexGraph, SPACE, entity, index_app, post, relationship
from test_knowledge_semantic_search import SemanticGraph, fact, run
from test_knowledge_semantic_search import entity as search_entity

PROJECT = 'synthetic-project'
OTHER = 'synthetic-other-project'


class TermsGraph(IndexGraph):
    """The index graph, also storing retrieval terms the way Neo4j would."""

    async def execute_query(self, query, **parameters):
        if 'SET item.fuli_retrieval_terms' in query:
            self.queries.append((query, parameters))
            kind = 'entity' if 'item:Entity' in query else 'relationship'
            self.items[kind][parameters['item_id']].update(
                retrieval_terms=parameters['terms'], retrieval_context=parameters['context'],
                retrieval_hash=parameters['hash'])
            return [], None, None
        return await super().execute_query(query, **parameters)


def graph_with_old_knowledge():
    own = 'Release freeze\nNo deploys before quarter end'
    return TermsGraph(
        [entity('e-1', 'Release freeze', 'No deploys before quarter end', personal_project_id=PROJECT,
                retrieval_terms=['ship window'], retrieval_hash=semantic_hash(own)),
         entity('e-2', 'Staging gate', 'Deploys use the staging gate', personal_project_id=PROJECT),
         entity('e-3', 'Retro notes', 'Edited since', personal_project_id=PROJECT,
                retrieval_terms=['old words'], retrieval_hash='0' * 64),
         entity('e-4', 'Other project', 'Belongs elsewhere', personal_project_id=OTHER),
         entity('e-5', 'Pending', 'Unconfirmed', personal_project_id=PROJECT, confirmation_basis_json=None)],
        [relationship('r-1', 'Ships stop the week before a quarter closes', personal_project_id=PROJECT)])


@pytest.mark.asyncio
async def test_candidates_list_items_without_current_terms_with_their_own_words_page_by_page():
    app = index_app(graph_with_old_knowledge())
    first = await post(app, '/v1/retrieval/candidates',
                       {'personal_space_id': SPACE, 'personal_project_id': PROJECT, 'limit': 2})
    assert first.status_code == 200, first.text
    assert first.json() == {'items': [
        {'item_kind': 'entity', 'item_id': 'e-2', 'personal_project_id': PROJECT, 'title': 'Staging gate',
         'text': 'Staging gate\nDeploys use the staging gate', 'has_terms': False,
         'hash': semantic_hash('Staging gate\nDeploys use the staging gate')},
        {'item_kind': 'entity', 'item_id': 'e-3', 'personal_project_id': PROJECT, 'title': 'Retro notes',
         'text': 'Retro notes\nEdited since', 'has_terms': False,
         'hash': semantic_hash('Retro notes\nEdited since')}], 'next': 'entity:e-3'}
    second = (await post(app, '/v1/retrieval/candidates', {
        'personal_space_id': SPACE, 'personal_project_id': PROJECT, 'limit': 2, 'after': 'entity:e-3'})).json()
    assert second == {'items': [
        {'item_kind': 'relationship', 'item_id': 'r-1', 'personal_project_id': PROJECT,
         'title': 'Ships stop the week before a quarter closes', 'text': 'Ships stop the week before a quarter closes',
         'has_terms': False, 'hash': semantic_hash('Ships stop the week before a quarter closes')}], 'next': None}
    everything = (await post(app, '/v1/retrieval/candidates',
                             {'personal_space_id': SPACE, 'missing_only': False})).json()
    assert [(row['item_id'], row['has_terms']) for row in everything['items']] == [
        ('e-1', True), ('e-2', False), ('e-3', False), ('e-4', False), ('r-1', False)]


@pytest.mark.asyncio
async def test_stats_count_items_terms_and_the_characters_an_estimate_starts_from():
    app = index_app(graph_with_old_knowledge())
    project = (await post(app, '/v1/retrieval/stats', {'personal_space_id': SPACE, 'personal_project_id': PROJECT}))
    assert project.status_code == 200, project.text
    texts = ['Release freeze\nNo deploys before quarter end', 'Staging gate\nDeploys use the staging gate',
             'Retro notes\nEdited since', 'Ships stop the week before a quarter closes']
    assert project.json() == {'items': 4, 'with_terms': 1, 'chars': sum(map(len, texts)),
                              'missing_chars': sum(map(len, texts[1:]))}
    everything = (await post(app, '/v1/retrieval/stats', {'personal_space_id': SPACE})).json()
    assert (everything['items'], everything['with_terms']) == (5, 1)


@pytest.mark.asyncio
async def test_a_write_stores_terms_beside_unchanged_words_only_and_touches_nothing_else():
    graph = TermsGraph([entity('e-1', 'Release freeze', 'Freeze', lock_version=4, version=2, updated_at='kept')],
                       [relationship('r-1', 'Ships stop')])
    before = {kind: {key: dict(row) for key, row in rows.items()} for kind, rows in graph.items.items()}
    app = index_app(graph)
    response = await post(app, '/v1/retrieval/terms', {'personal_space_id': SPACE, 'items': [
        {'item_kind': 'entity', 'item_id': 'e-1', 'hash': semantic_hash('Release freeze\nFreeze'),
         'terms': [' ship window ', 'code freeze', 'ship window'], 'context': ' Quarter-end release rule '},
        {'item_kind': 'relationship', 'item_id': 'r-1', 'hash': semantic_hash('Ships stopped'), 'terms': ['x']},
        {'item_kind': 'entity', 'item_id': 'gone', 'hash': '0' * 64, 'terms': ['y']}]})
    assert response.status_code == 200, response.text
    assert response.json() == {'written': 1, 'skipped': ['r-1', 'gone']}
    assert graph.transactions == 1
    stored = graph.items['entity']['e-1']
    assert {key: stored[key] for key in before['entity']['e-1']} == before['entity']['e-1']
    assert (stored['retrieval_terms'], stored['retrieval_context']) == (
        ['ship window', 'code freeze'], 'Quarter-end release rule')
    assert stored['retrieval_hash'] == semantic_hash('Release freeze\nFreeze')
    assert graph.items['relationship'] == before['relationship']
    writes = [query for query, _ in graph.queries if 'SET' in query]
    assert all('revision' not in query.lower() and 'human_change' not in query and 'lock_version' not in query
               and 'updated_at' not in query for query in writes)
    # The meaning index sees the terms, so the item is embedded again.
    pending = (await post(app, '/v1/semantic/pending', {'personal_space_id': SPACE, 'model': 'synthetic-model'}))
    [first, _] = pending.json()['items']
    assert first['text'] == 'Release freeze\nFreeze\nQuarter-end release rule\nship window · code freeze'


@pytest.mark.asyncio
@pytest.mark.parametrize('item', [
    {'terms': []},
    {'terms': ['  ']},
    {'terms': [f'term {index}' for index in range(25)]},
    {'terms': ['x' * 121]},
    {'terms': ['ok'], 'context': 'x' * 301},
    {'terms': ['ok'], 'hash': 'not-a-hash'},
])
async def test_a_malformed_write_is_refused_before_the_graph(item):
    graph = TermsGraph()
    body = {'item_kind': 'entity', 'item_id': 'e-1', 'hash': '0' * 64, **item}
    response = await post(index_app(graph), '/v1/retrieval/terms', {'personal_space_id': SPACE, 'items': [body]})
    assert response.status_code == 422, response.text
    assert graph.queries == []


@pytest.mark.asyncio
@pytest.mark.parametrize('headers,space,kind,status', [
    ({}, SPACE, 'personal', 401),
    (dict(authorization='Bearer synthetic-agent-access-token'), 'foreign-space', 'personal', 403),
    (dict(authorization='Bearer synthetic-agent-access-token'), SPACE, 'workspace', 422),
])
@pytest.mark.parametrize('path,body', [
    ('/v1/retrieval/candidates', {}),
    ('/v1/retrieval/stats', {}),
    ('/v1/retrieval/terms', {'items': [{'item_kind': 'entity', 'item_id': 'e-1', 'hash': '0' * 64, 'terms': ['x']}]}),
])
async def test_every_route_authorizes_the_personal_space_before_the_graph(headers, space, kind, status, path, body):
    graph = TermsGraph([entity('e-1', 'Release freeze', 'Freeze')])
    response = await post(index_app(graph, kind), path, {'personal_space_id': space, **body}, headers=headers)
    assert response.status_code == status, response.text
    assert graph.queries == []


def test_the_terms_are_made_from_the_items_own_words_and_embedded_with_them():
    record = {'name': 'Release freeze', 'summary': 'No deploys', 'retrieval_terms': ['ship window', 'code freeze'],
              'retrieval_context': 'Quarter-end rule'}
    assert item_text('entity', record) == 'Release freeze\nNo deploys'
    assert semantic_text('entity', record) == 'Release freeze\nNo deploys\nQuarter-end rule\nship window · code freeze'
    assert semantic_text('relationship', {'fact': 'Ships stop'}) == 'Ships stop'


def test_word_relevance_reads_stored_terms_and_context():
    plain = {'name': 'Release freeze', 'summary': 'No deploys before quarter end'}
    assert _relevance('ship window', plain) == 0
    assert _relevance('ship window', {**plain, 'retrieval_terms': ['ship window']}) > 0
    assert _relevance('上线窗口', {**plain, 'retrieval_terms': ['上线窗口']}) > 0
    assert _relevance('quarterly launch blackout', {**plain, 'retrieval_context': 'quarterly launch blackout'}) > 0


class TermEdgeGraph(SemanticGraph):
    """The semantic search fake, also answering the relationship term query."""

    async def execute_query(self, query, **parameters):
        if 'fuli_retrieval_terms IS NOT NULL' in query:
            self.queries.append((query, parameters))
            return [{**row, 'retrieval_terms': source['terms'], 'retrieval_context': None}
                    for row, source in zip(self._edge_rows(), self.edges) if source.get('terms')], None, None
        return await super().execute_query(query, **parameters)


@pytest.mark.asyncio
async def test_search_finds_an_entity_and_a_relationship_only_by_their_stored_terms():
    graph = TermEdgeGraph(
        [search_entity('freeze', 'Release freeze', 'No deploys before quarter end', retrieval_terms=['ship window']),
         search_entity('gate', 'Staging gate', 'Deploys use the staging gate')],
        [fact('r-terms', 'Ships stop the week before a quarter closes', terms=['ship window']),
         fact('r-plain', 'The gate runs every deploy')])
    result = await run(graph, 'ship window', vector=None)
    assert [item.id for item in result.entities] == ['freeze']
    assert [(row.id, row.matched_by) for row in result.facts] == [('r-terms', 'lexical')]
    assert all(item.matched_by == 'lexical' for item in result.entities)
