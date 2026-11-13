"""What a visitor's search may return (max_sensitivity='normal'): items whose
every source in every version they replaced or absorbed is normal,
relationships only between entities it may return itself, and only the
project's own items. Every other search is unchanged. Synthetic records only;
the Cypher runs against a graph in test_knowledge_sensitivity_neo4j.py."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from fuli_graph import knowledge_search
from fuli_graph.knowledge_search import _item_scope_metadata, search_knowledge
from fuli_graph.knowledge_sensitivity import MAX_VERSION_DEPTH, normal_only_ids
from fuli_graph.models import SearchRequest

GROUP = 'personal-group'
PROJECT = 'shared-project'
EDIT = {'kind': 'human_knowledge_edit', 'sensitivity': 'private'}
AGENT_EDIT = {'kind': 'agent_knowledge_edit', 'sensitivity': 'private'}


def capture(sensitivity):
    return {'kind': 'conversation', 'sensitivity': sensitivity}


class Graph:
    """Versions as the provider stores them: each item's source episodes and
    the newer item it was replaced by or merged into. Answers the two reads of
    knowledge_sensitivity: an item's sources, and the items that point at it."""

    def __init__(self, items):
        self.items = items  # id -> {'sources': [...], 'replaced_by': id | None}
        self.calls = []

    def lineage_rows(self, query, parameters):
        if 'fuli_replaced_by_item_id = row.id' in query:
            return [{'origin': row['origin'], 'id': item_id, 'group_id': GROUP, 'sources': item['sources']}
                    for row in parameters['frontier']
                    for item_id, item in self.items.items() if item.get('replaced_by') == row['id']]
        return [{'origin': item_id, 'id': item_id, 'group_id': GROUP, 'sources': self.items[item_id]['sources']}
                for item_id in parameters['item_ids'] if item_id in self.items]

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return self.lineage_rows(query, parameters), None, None


def chain(*steps):
    """One item's versions, oldest first; the last is current."""
    ids = [f'v{index}' for index in range(len(steps))]
    return {item_id: {'sources': sources, 'replaced_by': ids[index + 1] if index + 1 < len(ids) else None}
            for index, (item_id, sources) in enumerate(zip(ids, steps))}, ids[-1]


async def visible(items, current, item_kind='entity'):
    graph = Graph(items)
    return current in await normal_only_ids(SimpleNamespace(runtime=SimpleNamespace(driver=graph)),
                                            item_kind, [current])


@pytest.mark.parametrize('item_kind', ['entity', 'relationship'])
@pytest.mark.parametrize(('steps', 'expected'), [
    ([[capture('normal')]], True),
    ([[capture('normal'), capture('normal')]], True),
    ([[capture('private')]], False),
    ([[capture('restricted')]], False),
    # A private capture created it; a later normal capture only mentions it.
    ([[capture('private'), capture('normal')]], False),
    # No stored sensitivity is not FULI's capture: not trusted.
    ([[capture(None)]], False),
    ([[capture('normal'), capture(None)]], False),
    ([[]], False),
    # An edit counts neither way: the replaced versions decide.
    ([[capture('normal')], [EDIT]], True),
    ([[capture('private')], [EDIT]], False),
    ([[capture('normal')], [EDIT], [AGENT_EDIT]], True),
    ([[capture('private')], [EDIT], [AGENT_EDIT]], False),
    ([[EDIT], [EDIT]], False),
    ([[], [EDIT]], False),
    # Any private version anywhere in the lineage keeps the item out.
    ([[capture('private')], [capture('normal')]], False),
    ([[capture('private')], [capture('normal')], [EDIT]], False),
    ([[capture('normal')], [EDIT, capture('private')]], False),
])
async def test_only_a_lineage_of_normal_sources_reaches_a_visitor(item_kind, steps, expected):
    items, current = chain(*steps)
    assert await visible(items, current, item_kind) is expected


@pytest.mark.parametrize(('keep', 'dropped', 'expected'), [
    ([capture('private')], [capture('normal')], False),
    ([capture('normal')], [capture('private')], False),
    ([capture('normal')], [capture('normal')], True),
])
async def test_a_duplicate_merge_counts_both_items(keep, dropped, expected):
    items = {'keep': {'sources': keep}, 'dropped': {'sources': dropped, 'replaced_by': 'keep'}}
    assert await visible(items, 'keep') is expected


async def test_an_edit_after_merged_private_and_normal_versions_is_left_out():
    items = {'a': {'sources': [capture('private')], 'replaced_by': 'c'},
             'b': {'sources': [capture('normal')], 'replaced_by': 'c'},
             'c': {'sources': [EDIT]}}
    assert await visible(items, 'c') is False


async def test_a_lineage_longer_than_the_bound_is_left_out():
    near, _ = chain(*([[capture('normal')]] + [[EDIT]] * (MAX_VERSION_DEPTH - 1)))
    assert await visible(near, f'v{MAX_VERSION_DEPTH - 1}') is True
    far, _ = chain(*([[capture('normal')]] + [[EDIT]] * MAX_VERSION_DEPTH))
    assert await visible(far, f'v{MAX_VERSION_DEPTH}') is False


async def test_a_cycle_is_read_once():
    graph = Graph({'a': {'sources': [capture('normal')], 'replaced_by': 'b'},
                   'b': {'sources': [EDIT], 'replaced_by': 'a'}})
    store = SimpleNamespace(runtime=SimpleNamespace(driver=graph))
    assert await normal_only_ids(store, 'entity', ['b']) == {'b'}
    assert len(graph.calls) == 3


async def test_a_withheld_lineage_is_not_followed_further():
    items, current = chain(*([[EDIT]] * 10 + [[capture('private')]]))
    graph = Graph(items)
    assert await normal_only_ids(SimpleNamespace(runtime=SimpleNamespace(driver=graph)), 'entity', [current]) == set()
    assert len(graph.calls) == 1


def scopes():
    return {PROJECT: {'scope_distance': 0, 'scope_path': [PROJECT], 'inherited': False}}


def visitor_request(**fields):
    return SearchRequest(space_ids=['personal-space'], query='deploy checklist', personal_project_ids=[PROJECT],
                         active_personal_project_id=PROJECT, inherit_project_knowledge=False,
                         include_pending=True, **fields)


def test_an_item_another_project_defined_is_this_projects_only_through_a_reference():
    # Project A (the shared one) references an item project B defined.
    record = {'profile_aspect': None, 'assignment_project_id': 'project-b', 'reference_project_ids': [PROJECT]}
    assert _item_scope_metadata(record, visitor_request(), scopes(), False)['defined_project_id'] == PROJECT
    assert _item_scope_metadata(record, visitor_request(include_project_references=False), scopes(), False) is None
    own = {'profile_aspect': None, 'assignment_project_id': PROJECT, 'reference_project_ids': []}
    assert _item_scope_metadata(own, visitor_request(include_project_references=False), scopes(), False)[
        'defined_project_id'] == PROJECT


def test_a_max_sensitivity_search_names_its_project():
    assert SearchRequest(space_ids=['s'], query='q').max_sensitivity is None
    assert SearchRequest(space_ids=['s'], query='q').include_project_references is True
    for value in ('private', 'restricted', ''):
        with pytest.raises(ValidationError):
            visitor_request(max_sensitivity=value)
    with pytest.raises(ValidationError):
        SearchRequest(space_ids=['s'], query='q', max_sensitivity='normal')


# A personal search end to end over a fake graph: relationships and the
# entities at their ends, each with its own sources.
ENTITIES = {
    'runbook': {'name': 'Synthetic runbook', 'type': 'Document', 'project': PROJECT, 'sources': [capture('normal')]},
    'deploy': {'name': 'Synthetic deploy', 'type': 'Process', 'project': PROJECT, 'sources': [capture('normal')]},
    'source': {'name': 'Hidden repository', 'type': 'ProjectSource', 'project': PROJECT,
               'sources': [capture('normal')]},
    'secret': {'name': 'Confidential vault', 'type': 'Process', 'project': PROJECT, 'sources': [capture('private')]},
    'elsewhere': {'name': 'Other deploy', 'type': 'Process', 'project': 'project-b', 'sources': [capture('normal')]},
}
EDGES = {
    'edge-visible': ('runbook', 'deploy', 'Synthetic runbook documents the deploy checklist'),
    'edge-to-source': ('runbook', 'source', 'Synthetic runbook lives in the checklist store'),
    'edge-to-secret': ('runbook', 'secret', 'Synthetic runbook deploy checklist opens it'),
    'edge-to-elsewhere': ('runbook', 'elsewhere', 'Synthetic runbook deploy checklist feeds it'),
    # Matches only by the hidden endpoint's name.
    'edge-named-by-hidden': ('runbook', 'source', 'Synthetic runbook points somewhere'),
}


class PersonalGraph(Graph):
    def __init__(self):
        super().__init__({**{key: {'sources': value['sources']} for key, value in ENTITIES.items()},
                          **{key: {'sources': [capture('normal')]} for key in EDGES}})

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if 'item.uuid AS origin' in query or 'row.origin AS origin' in query:
            return self.lineage_rows(query, parameters), None, None
        if 'AS endpoints_visible' in query:
            return [{'id': edge_id, 'endpoints_visible': True, 'assignment_project_id': PROJECT,
                     'episode_project_ids': [PROJECT], 'reference_project_ids': []}
                    for edge_id in parameters['edge_ids']], None, None
        if 'MATCH (node:Entity {group_id: $group_id})' in query:
            wanted = parameters['entity_ids']
            return [{'id': key, 'group_id': GROUP, 'name': value['name'], 'type': value['type'], 'summary': '',
                     'assignment_project_id': value['project'], 'episode_project_ids': [value['project']],
                     'reference_project_ids': [], 'confirmation_status': 'pending'}
                    for key, value in ENTITIES.items()
                    if (wanted is None or key in wanted)
                    and value['type'] not in parameters['excluded_entity_types']], None, None
        if 'MATCH (n:Entity)' in query:
            return [{'uuid': uuid, 'name': ENTITIES[uuid]['name']} for uuid in parameters['uuids']], None, None
        return [], None, None


class PersonalStore:
    def __init__(self, graph, query):
        self.runtime = SimpleNamespace(graphiti=self, driver=graph)
        self.settings = SimpleNamespace(graph_limit=100)
        self.query = query

    async def search(self, query, *, group_ids, num_results):
        del query, group_ids, num_results
        return [SimpleNamespace(uuid=edge_id, group_id=GROUP, name='RELATES', fact=fact, source_node_uuid=source,
                                target_node_uuid=target, valid_at=None, invalid_at=None,
                                created_at=datetime(2026, 11, 1, tzinfo=timezone.utc), episodes=[])
                for edge_id, (source, target, fact) in EDGES.items()]

    async def authorize(self, actor, space_id, role):
        del actor, role
        return {'id': space_id, 'kind': 'personal', 'group_id': GROUP}


@pytest.fixture
def personal_projects(monkeypatch):
    async def authorized(*args, **kwargs):
        del args, kwargs
    monkeypatch.setattr(knowledge_search, 'authorize_personal_project', authorized)


async def facts_for(query, **fields):
    graph = PersonalGraph()
    store = PersonalStore(graph, query)
    request = SearchRequest(space_ids=['personal-space'], query=query, personal_project_ids=[PROJECT],
                            active_personal_project_id=PROJECT, inherit_project_knowledge=False,
                            include_pending=True, **fields)
    result = await search_knowledge(store, {'id': 'actor'}, request)
    named = {uuid for query_text, parameters in graph.calls if 'MATCH (n:Entity)' in query_text
             for uuid in parameters['uuids']}
    return sorted(fact.id for fact in result.facts), named


VISITOR = dict(max_sensitivity='normal', include_project_references=False,
               excluded_entity_types=['PersonalProject', 'ProjectSource', 'PersonalPreference'])


async def test_a_visitor_gets_a_relationship_only_when_both_ends_are_visible(personal_projects):
    facts, named = await facts_for('deploy checklist', **VISITOR)
    assert facts == ['edge-visible']
    assert named == {'runbook', 'deploy'}


async def test_a_hidden_entity_name_neither_finds_nor_ranks_a_relationship(personal_projects):
    facts, named = await facts_for('Hidden repository', **VISITOR)
    assert facts == []
    assert 'source' not in named


async def test_the_owner_search_is_unchanged(personal_projects):
    facts, _ = await facts_for('deploy checklist')
    assert facts == ['edge-to-elsewhere', 'edge-to-secret', 'edge-to-source', 'edge-visible']
    hidden, named = await facts_for('Hidden repository')
    assert hidden == ['edge-named-by-hidden', 'edge-to-source']
    assert 'source' in named
