"""A visitor's search leaves out knowledge whose sources are all private or
restricted (max_sensitivity='normal'); an edit says nothing either way, so an
edited item is decided by the versions it replaced. Every other search is
unchanged. Synthetic records only; the Cypher runs against a graph in
test_knowledge_sensitivity_neo4j.py."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from fuli_graph.knowledge_search import search_knowledge
from fuli_graph.knowledge_sensitivity import MAX_VERSION_DEPTH, normal_safe_ids
from fuli_graph.models import SearchRequest

GROUP = 'project-group'
EDIT = {'kind': 'human_knowledge_edit', 'sensitivity': 'private'}
AGENT_EDIT = {'kind': 'agent_knowledge_edit', 'sensitivity': 'private'}


def capture(sensitivity):
    return {'kind': 'conversation', 'sensitivity': sensitivity}


class Graph:
    """Versions as the provider stores them: each item's source episodes and
    the newer version it was replaced by. Answers the two reads
    knowledge_sensitivity makes: an item's sources, and the versions it replaced."""

    def __init__(self, items):
        self.items = items  # id -> {'sources': [...], 'replaced_by': id | None}
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if 'fuli_replaced_by_item_id = row.id' in query:
            return [{'origin': row['origin'], 'id': item_id, 'group_id': GROUP, 'sources': item['sources']}
                    for row in parameters['frontier']
                    for item_id, item in self.items.items() if item.get('replaced_by') == row['id']], None, None
        if 'item.uuid IN $item_ids' in query:
            return [{'origin': item_id, 'id': item_id, 'group_id': GROUP, 'sources': self.items[item_id]['sources']}
                    for item_id in parameters['item_ids'] if item_id in self.items], None, None
        if 'MATCH (n:Entity)' in query:
            return [{'uuid': 'source', 'name': 'Synthetic runbook'},
                    {'uuid': 'target', 'name': 'Synthetic deploy'}], None, None
        return [], None, None


def chain(*steps):
    """One item's versions, oldest first; the last is current."""
    ids = [f'v{index}' for index in range(len(steps))]
    return {item_id: {'sources': sources, 'replaced_by': ids[index + 1] if index + 1 < len(ids) else None}
            for index, (item_id, sources) in enumerate(zip(ids, steps))}, ids[-1]


async def safe(items, current, item_kind='entity'):
    graph = Graph(items)
    return current in await normal_safe_ids(SimpleNamespace(runtime=SimpleNamespace(driver=graph)),
                                            item_kind, [current])


@pytest.mark.parametrize('item_kind', ['entity', 'relationship'])
@pytest.mark.parametrize(('steps', 'expected'), [
    ([[capture('normal')]], True),
    ([[capture('private')]], False),
    ([[capture('restricted'), capture('private')]], False),
    ([[capture('private'), capture('normal')]], True),
    ([[capture(None)]], True),
    ([[]], False),
    # Captured from a normal episode, then edited: the edit says nothing.
    ([[capture('normal')], [EDIT]], True),
    # Captured from a private episode, then edited: still private.
    ([[capture('private')], [EDIT]], False),
    ([[capture('normal')], [EDIT], [AGENT_EDIT]], True),
    ([[capture('private')], [EDIT], [AGENT_EDIT]], False),
    # Only edits, nothing else in the whole chain.
    ([[EDIT], [EDIT]], False),
    ([[], [EDIT]], False),
    # The nearest version with a source decides, not an older one.
    ([[capture('normal')], [capture('private')], [EDIT]], False),
    ([[capture('private')], [capture('normal')], [EDIT]], True),
    # A current version with its own capture is decided by it alone.
    ([[capture('normal')], [EDIT, capture('private')]], False),
])
async def test_an_edit_counts_neither_way_and_the_replaced_versions_decide(item_kind, steps, expected):
    items, current = chain(*steps)
    assert await safe(items, current, item_kind) is expected


async def test_versions_merged_into_one_count_together():
    items = {'a': {'sources': [capture('private')], 'replaced_by': 'c'},
             'b': {'sources': [capture('normal')], 'replaced_by': 'c'},
             'c': {'sources': [EDIT], 'replaced_by': None}}
    assert await safe(items, 'c') is True


async def test_the_chain_is_followed_at_most_twenty_steps():
    near, _ = chain(*([[capture('normal')]] + [[EDIT]] * MAX_VERSION_DEPTH))
    assert await safe(near, f'v{MAX_VERSION_DEPTH}') is True
    far, _ = chain(*([[capture('normal')]] + [[EDIT]] * (MAX_VERSION_DEPTH + 1)))
    assert await safe(far, f'v{MAX_VERSION_DEPTH + 1}') is False


async def test_a_cycle_of_edits_ends_left_out():
    items = {'a': {'sources': [EDIT], 'replaced_by': 'b'}, 'b': {'sources': [EDIT], 'replaced_by': 'a'}}
    graph = Graph(items)
    store = SimpleNamespace(runtime=SimpleNamespace(driver=graph))
    assert await normal_safe_ids(store, 'entity', ['b']) == set()
    assert len(graph.calls) == MAX_VERSION_DEPTH + 1


def edge(uuid):
    return SimpleNamespace(
        uuid=uuid, group_id=GROUP, name='DOCUMENTS',
        fact='Synthetic deploy checklist lives in the runbook',
        source_node_uuid='source', target_node_uuid='target',
        valid_at=None, invalid_at=None, created_at=datetime(2026, 11, 1, tzinfo=timezone.utc),
        episodes=[f'{uuid}-episode'],
    )


class Store:
    def __init__(self, edges, graph):
        self.runtime = SimpleNamespace(graphiti=self, driver=graph)
        self.edges = edges

    async def search(self, query, *, group_ids, num_results):
        del query, group_ids, num_results
        return self.edges

    async def authorize(self, actor, space_id, role):
        del actor, role
        return {'id': space_id, 'kind': 'project', 'group_id': GROUP}


def request(**fields):
    return SearchRequest(space_ids=['project-space'], query='deploy checklist', include_pending=True, **fields)


GRAPH = {
    'edge-normal': {'sources': [capture('normal')]},
    'edge-private': {'sources': [capture('private')]},
    'edge-old': {'sources': [capture('normal')], 'replaced_by': 'edge-edited'},
    'edge-edited': {'sources': [EDIT]},
    'edge-edits-only': {'sources': [EDIT]},
}


async def test_a_visitor_search_returns_normal_and_normally_sourced_edited_relationships():
    graph = Graph(GRAPH)
    store = Store([edge(item) for item in ('edge-normal', 'edge-private', 'edge-edited', 'edge-edits-only')], graph)
    result = await search_knowledge(store, {'id': 'actor'}, request(max_sensitivity='normal'))
    assert sorted(fact.id for fact in result.facts) == ['edge-edited', 'edge-normal']


async def test_the_default_search_never_reads_sensitivity():
    graph = Graph(GRAPH)
    store = Store([edge(item) for item in ('edge-normal', 'edge-private', 'edge-edited', 'edge-edits-only')], graph)
    result = await search_knowledge(store, {'id': 'actor'}, request())
    assert sorted(fact.id for fact in result.facts) == ['edge-edited', 'edge-edits-only', 'edge-normal', 'edge-private']
    assert not any('fuli_sensitivity' in query for query, _ in graph.calls)


def test_max_sensitivity_is_normal_or_absent():
    assert SearchRequest(space_ids=['s'], query='q').max_sensitivity is None
    for value in ('private', 'restricted', ''):
        with pytest.raises(ValidationError):
            SearchRequest(space_ids=['s'], query='q', max_sensitivity=value)
