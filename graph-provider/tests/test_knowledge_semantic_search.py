"""rec#88: search by meaning over synthetic records and a fake graph.

The fake answers the provider's own Cypher the way Neo4j would for these
records (group, history and confirmation filters); scope, visibility and
confirmation rules run for real in Python. The Cypher itself is covered by
test_knowledge_semantic_neo4j.py.
"""
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from fuli_graph.knowledge_search import search_knowledge
from fuli_graph.knowledge_semantic import (
    MIN_IN_SCOPE_ITEMS,
    RRF_K,
    fused_ranking,
    meaning_matches,
    semantic_hash,
    semantic_text,
    usable_vector,
)
from fuli_graph.models import SearchRequest

SPACE = 'synthetic-semantic-space'
GROUP = 'synthetic-semantic-group'
PROJECT = 'synthetic-project'
OTHER = 'synthetic-other-project'
MODEL = 'synthetic-embedding-model'
DIMENSIONS = 40
CREATED = datetime(2026, 10, 1, tzinfo=timezone.utc)
CONFIRMED_BASIS = json.dumps({
    'existence_reason': 'Synthetic evidence', 'quadrant_reason': 'Synthetic test',
    'proposed_by': {'kind': 'agent'}, 'confirmed_by': {'kind': 'user'},
    'confirmed_at': '2026-10-01T00:00:00Z'})


def axis(index, length=DIMENSIONS):
    return [1.0 if position == index else 0.0 for position in range(length)]


# The query's meaning, and one item that means nearly the same.
QUERY = [0.95, 0.31] + [0.0] * (DIMENSIONS - 2)
CLOSE = [0.9, 0.4] + [0.0] * (DIMENSIONS - 2)


def entity(item_id, name, summary, vector=None, *, model=MODEL, project=PROJECT, stale=False, **fields):
    record = {
        'id': item_id, 'group_id': GROUP, 'name': name, 'type': 'ProjectFact', 'summary': summary,
        'created_at': CREATED, 'invalid_at': None, 'confirmation_status': 'confirmed',
        'confirmation_basis_json': CONFIRMED_BASIS, 'epistemic_status': 'confirmed',
        'assignment_project_id': project, 'key': item_id,
        'fuli_semantic_model': model if vector else None, 'fuli_semantic_vector': vector,
        **fields,
    }
    text = semantic_text('entity', record)
    record['fuli_semantic_hash'] = semantic_hash(text + ' (before an edit)' if stale else text)
    return record


def noise_entities(count, *, project=PROJECT, start=2):
    return [entity(f'noise-{project}-{index}', f'Synthetic filler {index}', f'Unrelated filler {index}',
                   axis(start + index), project=project) for index in range(count)]


class SemanticGraph:
    """A personal space's entities and relationships, answering each query
    search_knowledge sends."""

    def __init__(self, entities=(), edges=(), lexical_edges=()):
        self.entities = list(entities)
        self.edges = list(edges)
        self.lexical_edges = list(lexical_edges)
        self.settings = SimpleNamespace(graph_limit=500, provider_mode='personal')
        self.runtime = SimpleNamespace(graphiti=self, driver=self)
        self.queries = []

    async def authorize(self, actor, space_id, role):
        assert space_id == SPACE and role == 'reader'
        return {'id': SPACE, 'kind': 'personal', 'group_id': GROUP}

    async def search(self, query, *, group_ids, num_results):
        return [self._edge(row) for row in self.lexical_edges]

    async def execute_query(self, query, **parameters):
        self.queries.append((query, parameters))
        if 'MATCH (:FuliPrincipal' in query:
            return [{'project': {'project_id': parameters['project_id']}}], None, None
        if 'PERSONAL_PROJECT_RELATION' in query:
            return [], None, None
        if 'MATCH (node:Entity {group_id: $group_id})' in query:
            return self._entity_rows(parameters), None, None
        if 'edge.fuli_semantic_model = $semantic_model' in query:
            return [row for row in self._edge_rows() if row['fuli_semantic_model'] == parameters['semantic_model']
                    and len(row['fuli_semantic_vector'] or []) == parameters['length']], None, None
        if 'endpoints_visible' in query:
            return [{'id': row['uuid'], 'endpoints_visible': True, 'assignment_project_id': row['project'],
                     'episode_project_ids': [], 'episode_project_agent_ids': [], 'reference_project_ids': []}
                    for row in self.edges if row['uuid'] in parameters['edge_ids']], None, None
        if 'MATCH ()-[edge:RELATES_TO]->()' in query:
            return [{'id': row['uuid'], 'confirmation_status': row['confirmation_status'],
                     'confirmation_basis_json': CONFIRMED_BASIS, 'key': row['uuid']}
                    for row in self.edges if row['uuid'] in parameters['edge_ids']], None, None
        if 'MATCH (n:Entity) WHERE n.uuid IN $uuids' in query:
            return [{'uuid': uuid, 'name': uuid} for uuid in parameters['uuids']], None, None
        return [], None, None

    def _entity_rows(self, parameters):
        rows = []
        model = parameters['semantic_model']
        for record in self.entities:
            if model is not None and record['fuli_semantic_model'] != model:
                continue
            if not parameters['include_historical'] and record['invalid_at'] is not None:
                continue
            if not parameters['include_pending'] and record['confirmation_status'] not in ('confirmed',
                                                                                         'agent_confirmed'):
                continue
            row = {key: value for key, value in record.items() if not key.startswith('fuli_semantic')}
            if parameters['semantic_model'] is not None:
                row['semantic_vector'] = record['fuli_semantic_vector']
                row['semantic_hash'] = record['fuli_semantic_hash']
            rows.append(row)
        return rows

    def _edge_rows(self):
        return [{'uuid': row['uuid'], 'source_node_uuid': 'source', 'target_node_uuid': 'target',
                 'group_id': GROUP, 'name': 'RELATES_TO', 'fact': row['fact'], 'episodes': [],
                 'created_at': CREATED, 'valid_at': None, 'invalid_at': row.get('invalid_at'), 'expired_at': None,
                 'fuli_semantic_model': row.get('model', MODEL),
                 'fuli_semantic_vector': row.get('vector'),
                 'semantic_vector': row.get('vector'), 'semantic_hash': semantic_hash(row['fact'])}
                for row in self.edges]

    def _edge(self, row):
        return SimpleNamespace(uuid=row['uuid'], group_id=GROUP, name='RELATES_TO', fact=row['fact'],
                               source_node_uuid='source', target_node_uuid='target', valid_at=None,
                               invalid_at=row.get('invalid_at'), created_at=CREATED, episodes=[])


def fact(uuid, text, vector=None, *, project=PROJECT, **fields):
    return {'uuid': uuid, 'fact': text, 'vector': vector, 'project': project,
            'confirmation_status': 'confirmed', **fields}


async def run(graph, query, vector=QUERY, *, model=MODEL, **fields):
    semantic = None if vector is None else {'model': model, 'vector': vector}
    return await search_knowledge(graph, {'id': 'synthetic-owner'}, SearchRequest(
        space_ids=[SPACE], query=query, personal_project_ids=[PROJECT], active_personal_project_id=PROJECT,
        limit=10, semantic=semantic, **fields))


@pytest.mark.asyncio
async def test_an_item_found_only_by_meaning_comes_back_with_its_fused_score():
    graph = SemanticGraph([entity('close', 'Release freeze', 'No deploys in the last week of a quarter', CLOSE),
                           *noise_entities(15)])
    result = await run(graph, 'when may we ship')
    [found] = result.entities
    assert (found.id, found.matched_by) == ('close', 'semantic')
    assert found.score == round(1 / (RRF_K + 1), 6)


@pytest.mark.asyncio
async def test_an_item_found_both_ways_ranks_above_one_found_one_way():
    graph = SemanticGraph([
        entity('both', 'Deploy freeze', 'Deploy freeze before quarter end', CLOSE),
        entity('words', 'Deploy checklist', 'Deploy checklist for staging', axis(30)),
        *noise_entities(15)])
    result = await run(graph, 'deploy freeze')
    assert [(row.id, row.matched_by) for row in result.entities] == [('both', 'both'), ('words', 'lexical')]
    assert result.entities[0].score > result.entities[1].score


@pytest.mark.asyncio
async def test_without_a_semantic_part_the_lexical_result_is_unchanged():
    rows = [entity('words', 'Deploy checklist', 'Deploy checklist for staging', CLOSE), *noise_entities(15)]
    lexical = await run(SemanticGraph(rows), 'deploy checklist', None)
    for semantic in ({'vector': QUERY[:-1]}, {'model': 'synthetic-unknown-model'}):
        graph = SemanticGraph(rows)
        result = await run(graph, 'deploy checklist', **{'vector': QUERY, **semantic})
        assert result.model_dump() == lexical.model_dump()
    assert [(row.id, row.matched_by) for row in lexical.entities] == [('words', 'lexical')]


@pytest.mark.asyncio
async def test_another_projects_item_a_history_item_and_a_pending_item_never_come_back():
    graph = SemanticGraph([
        entity('other-project', 'Release freeze', 'Freeze', QUERY, project=OTHER),
        entity('history', 'Release freeze', 'Freeze (old)', QUERY, invalid_at=CREATED),
        entity('pending', 'Release freeze', 'Freeze (unconfirmed)', QUERY, confirmation_status='pending',
               confirmation_basis_json=None),
        entity('unbased', 'Release freeze', 'Freeze (basis lost)', QUERY, confirmation_basis_json=None),
        *noise_entities(15)],
        edges=[fact('fact-other', 'Releases freeze', QUERY, project=OTHER),
               fact('fact-history', 'Releases froze', QUERY, invalid_at=CREATED),
               *(fact(f'fact-noise-{index}', f'Filler {index}', axis(2 + index)) for index in range(15))])
    result = await run(graph, 'when may we ship')
    assert result.entities == [] and result.facts == []
    # Asked for history, the history item may come back, never the other project's.
    widened = await run(graph, 'when may we ship', include_historical=True)
    assert 'other-project' not in {row.id for row in widened.entities}
    assert 'fact-other' not in {row.id for row in widened.facts}


@pytest.mark.asyncio
async def test_a_relationship_found_only_by_meaning_passes_the_same_scope_and_history_filters():
    edges = [fact('fact-close', 'Ships stop the week before a quarter closes', CLOSE),
             *(fact(f'fact-noise-{index}', f'Filler {index}', axis(2 + index)) for index in range(15))]
    result = await run(SemanticGraph(edges=edges), 'when may we ship')
    assert [(row.id, row.matched_by, row.defined_project_id) for row in result.facts] == [
        ('fact-close', 'semantic', PROJECT)]
    edges[0]['project'] = OTHER
    assert (await run(SemanticGraph(edges=edges), 'when may we ship')).facts == []


@pytest.mark.asyncio
async def test_the_floor_keeps_nothing_for_an_unrelated_query():
    graph = SemanticGraph([entity('close', 'Release freeze', 'Freeze', CLOSE), *noise_entities(15)])
    unrelated = [0.0, 0.0] + [1.0] * 15 + [0.0] * (DIMENSIONS - 17)
    assert (await run(graph, 'banana bread', unrelated)).entities == []


@pytest.mark.asyncio
async def test_under_twelve_in_scope_items_keep_none_however_many_are_out_of_scope():
    rows = [entity('close', 'Release freeze', 'Freeze', CLOSE), *noise_entities(MIN_IN_SCOPE_ITEMS - 2)]
    out_of_scope = noise_entities(20, project=OTHER, start=12)
    assert (await run(SemanticGraph([*rows, *out_of_scope]), 'when may we ship')).entities == []
    rows.append(entity('one-more', 'Synthetic filler', 'Filler', axis(39)))
    assert [row.id for row in (await run(SemanticGraph(rows), 'when may we ship')).entities] == ['close']


@pytest.mark.asyncio
async def test_a_vector_whose_text_changed_since_counts_for_nothing():
    graph = SemanticGraph([entity('close', 'Release freeze', 'Freeze', CLOSE, stale=True), *noise_entities(15)])
    assert (await run(graph, 'when may we ship')).entities == []


def test_usable_vector_needs_the_query_length_and_the_current_text():
    record = {'name': 'Release freeze', 'summary': 'Freeze', 'semantic_vector': [0.1, 0.2],
              'semantic_hash': semantic_hash('Release freeze\nFreeze')}
    assert usable_vector('entity', record, 2) == [0.1, 0.2]
    assert usable_vector('entity', record, 3) is None
    assert usable_vector('entity', {**record, 'summary': 'Thaw'}, 2) is None
    edge = {'fact': 'Ships stop', 'semantic_vector': [1.0], 'semantic_hash': semantic_hash('Ships stop')}
    assert usable_vector('relationship', edge, 1) == [1.0]


def test_meaning_matches_floor_and_fusion():
    candidates = {f'noise-{index}': axis(2 + index) for index in range(15)}
    assert meaning_matches({**candidates, 'close': CLOSE}, QUERY, 10) == pytest.approx(
        {'close': 0.9 * 0.95 / (0.9 ** 2 + 0.4 ** 2) ** 0.5 + 0.4 * 0.31 / (0.9 ** 2 + 0.4 ** 2) ** 0.5}, rel=1e-3)
    assert meaning_matches({**candidates, 'close': CLOSE}, [0.0] * DIMENSIONS, 10) == {}
    assert meaning_matches(dict(list(candidates.items())[:10], close=CLOSE), QUERY, 10) == {}
    fused = fused_ranking(['a', 'b'], ['b', 'c'])
    assert fused == {'a': (round(1 / 61, 6), 'lexical'), 'b': (round(1 / 62 + 1 / 61, 6), 'both'),
                     'c': (round(1 / 62, 6), 'semantic')}


def test_the_single_closest_item_needs_to_stand_out_less_than_the_rest():
    """Cosines of one question against 30 items: the answer in other words sits 2.7 deviations out."""
    def scored(values):
        # One axis each: an item's cosine with the query is its own value.
        query = [1.0] + [0.0] * len(values)
        return {f'item-{index}': [value] + [0.0] * index + [(1 - value * value) ** 0.5] + [0.0] * (len(values) - index - 1)
                for index, value in enumerate(values)}, query

    spread = [0.36 + 0.004 * (index % 11) for index in range(29)]
    candidates, query = scored([*spread, 0.42])
    cosines = [*spread, 0.42]
    mean = sum(cosines) / len(cosines)
    deviation = (sum((value - mean) ** 2 for value in cosines) / len(cosines)) ** 0.5
    assert 2.5 < (0.42 - mean) / deviation < 3, 'the fixture sits between the two floors'
    assert list(meaning_matches(candidates, query, 5)) == ['item-29']
    # Only the closest is added this way: a second item just behind it is not.
    pair, query = scored([*spread[:28], 0.4195, 0.42])
    assert len(meaning_matches(pair, query, 5)) <= 1
    # Nothing stands out: nothing is kept.
    flat, query = scored([*spread, 0.40])
    assert meaning_matches(flat, query, 5) == {}

