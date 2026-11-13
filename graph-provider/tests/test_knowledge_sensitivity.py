"""What a visitor's search may return (max_sensitivity='normal'): items whose
every source in every version they replaced or absorbed is normal, only the
active project's own items whatever the other switches say, and
relationships only between entities it may return itself. Every other search
is unchanged. Synthetic records only; the Cypher runs against a graph in
test_knowledge_sensitivity_neo4j.py."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from fuli_graph import knowledge_search
from fuli_graph.knowledge_search import _item_scope_metadata, search_knowledge
from fuli_graph.knowledge_sensitivity import MAX_VERSION_DEPTH, normal_only_ids
from fuli_graph.models import SearchRequest
from test_collaboration_context import confirmation_basis

GROUP = 'personal-group'
PROJECT = 'shared-project'
PARENT = 'parent-project'
EDIT = {'kind': 'human_knowledge_edit', 'sensitivity': 'private'}
AGENT_EDIT = {'kind': 'agent_knowledge_edit', 'sensitivity': 'private'}


def capture(sensitivity):
    return {'kind': 'conversation', 'sensitivity': sensitivity}


class Graph:
    """Versions as the provider stores them: each item's source episodes, how
    many ids its episode list names without a surviving episode (missing), and
    the newer item it was replaced by or merged into. Answers the two reads of
    knowledge_sensitivity: an item's sources, and the items that point at it."""

    def __init__(self, items):
        self.items = items  # id -> {'sources': [...], 'replaced_by': id | None, 'missing': int}
        self.calls = []

    def row(self, origin, item_id):
        item = self.items[item_id]
        return {'origin': origin, 'id': item_id, 'group_id': GROUP, 'sources': item['sources'],
                'missing': item.get('missing', 0), 'had_restricted_source': item.get('marked', False)}

    def lineage_rows(self, query, parameters):
        if 'fuli_replaced_by_item_id = row.id' in query:
            return [self.row(row['origin'], item_id) for row in parameters['frontier']
                    for item_id, item in self.items.items() if item.get('replaced_by') == row['id']]
        return [self.row(item_id, item_id) for item_id in parameters['item_ids'] if item_id in self.items]

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return self.lineage_rows(query, parameters), None, None


def chain(*steps):
    """One item's versions, oldest first; the last is current."""
    ids = [f'v{index}' for index in range(len(steps))]
    return {item_id: {'sources': sources, 'replaced_by': ids[index + 1] if index + 1 < len(ids) else None}
            for index, (item_id, sources) in enumerate(zip(ids, steps))}, ids[-1]


def lineage_store(items):
    return SimpleNamespace(runtime=SimpleNamespace(driver=Graph(items)))


async def visible(items, current, item_kind='entity'):
    return current in await normal_only_ids(lineage_store(items), item_kind, [current])


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


@pytest.mark.parametrize('where', ['current', 'predecessor'])
async def test_a_relationship_naming_a_deleted_episode_is_left_out(where):
    items, current = chain([capture('normal')], [capture('normal')])
    items['v1' if where == 'current' else 'v0']['missing'] = 1
    assert await visible(items, current, 'relationship') is False


@pytest.mark.parametrize('item_kind', ['entity', 'relationship'])
async def test_an_item_that_lost_a_restricted_source_stays_out(item_kind):
    marked = {'item': {'sources': [capture('normal')], 'marked': True}}
    assert await visible(marked, 'item', item_kind) is False
    # Its successor too, through the lineage.
    successor, current = chain([capture('normal')], [EDIT])
    successor['v0']['marked'] = True
    assert await visible(successor, current, item_kind) is False


async def test_twenty_predecessors_are_read_and_a_twenty_first_withholds():
    exactly, current = chain(*([[capture('normal')]] + [[EDIT]] * MAX_VERSION_DEPTH))
    assert current == f'v{MAX_VERSION_DEPTH}'
    assert await visible(exactly, current) is True
    longer, current = chain(*([[capture('normal')]] * 2 + [[EDIT]] * MAX_VERSION_DEPTH))
    assert await visible(longer, current) is False


async def test_a_cycle_is_read_once():
    store = lineage_store({'a': {'sources': [capture('normal')], 'replaced_by': 'b'},
                           'b': {'sources': [EDIT], 'replaced_by': 'a'}})
    assert await normal_only_ids(store, 'entity', ['b']) == {'b'}
    assert len(store.runtime.driver.calls) == 3


async def test_a_withheld_lineage_is_not_followed_further():
    items, current = chain(*([[EDIT]] * 10 + [[capture('private')]]))
    store = lineage_store(items)
    assert await normal_only_ids(store, 'entity', [current]) == set()
    assert len(store.runtime.driver.calls) == 1


async def test_one_private_member_of_a_merge_stops_the_whole_fan_in():
    items = {'current': {'sources': [EDIT]}}
    for member in range(6):
        items[f'm{member}'] = {'sources': [capture('private' if member == 3 else 'normal')], 'replaced_by': 'current'}
        items[f'm{member}-older'] = {'sources': [capture('normal')], 'replaced_by': f'm{member}'}
    store = lineage_store(items)
    assert await normal_only_ids(store, 'entity', ['current']) == set()
    assert len(store.runtime.driver.calls) == 2


def scopes(*inherited):
    return {PROJECT: {'scope_distance': 0, 'scope_path': [PROJECT], 'inherited': False},
            **{project: {'scope_distance': 1, 'scope_path': [PROJECT, project], 'inherited': True}
               for project in inherited}}


def visitor_request(**fields):
    return SearchRequest(**{'space_ids': ['personal-space'], 'query': 'deploy checklist',
                            'personal_project_ids': [PROJECT], 'active_personal_project_id': PROJECT,
                            'inherit_project_knowledge': False, **fields})


VISITOR = dict(max_sensitivity='normal', include_project_references=False,
               excluded_entity_types=['PersonalProject', 'ProjectSource', 'PersonalPreference'])


def test_an_item_another_project_defined_is_this_projects_only_through_a_reference():
    # Project A (the shared one) references an item project B defined.
    record = {'profile_aspect': None, 'assignment_project_id': 'project-b', 'reference_project_ids': [PROJECT]}
    assert _item_scope_metadata(record, visitor_request(), scopes(), False)['defined_project_id'] == PROJECT
    assert _item_scope_metadata(record, visitor_request(include_project_references=False), scopes(), False) is None
    own = {'profile_aspect': None, 'assignment_project_id': PROJECT, 'reference_project_ids': []}
    assert _item_scope_metadata(own, visitor_request(include_project_references=False), scopes(), False)[
        'defined_project_id'] == PROJECT


@pytest.mark.parametrize('widened', [
    {'include_project_references': True}, {'inherit_project_knowledge': True}, {'include_personal_global': True},
    {'include_pending': True}, {'include_historical': True}, {'project_agent_id': 'agent-1'},
])
def test_a_visitor_request_that_asks_for_more_is_refused(widened):
    with pytest.raises(ValidationError, match=next(iter(widened))):
        visitor_request(**{**VISITOR, **widened})


def test_a_max_sensitivity_search_names_its_project():
    assert SearchRequest(space_ids=['s'], query='q').max_sensitivity is None
    assert SearchRequest(space_ids=['s'], query='q').include_project_references is True
    for value in ('private', 'restricted', ''):
        with pytest.raises(ValidationError):
            visitor_request(max_sensitivity=value)
    with pytest.raises(ValidationError, match='active_personal_project_id'):
        SearchRequest(space_ids=['s'], query='q', personal_project_ids=['p'], max_sensitivity='normal',
                      include_project_references=False, inherit_project_knowledge=False)


# A personal search end to end over a fake graph: relationships, the entities
# at their ends and each item's own sources and scope.
def entity(name, kind='Process', project=PROJECT, sources=None, **fields):
    return {'name': name, 'type': kind, 'assignment_project_id': project,
            'episode_project_ids': [project] if project else [], 'sources': sources or [capture('normal')], **fields}


ENTITIES = {
    'runbook': entity('Synthetic runbook', 'Document'),
    'deploy': entity('Synthetic deploy'),
    'source': entity('Hidden repository', 'ProjectSource'),
    'secret': entity('Confidential vault', sources=[capture('private')]),
    'elsewhere': entity('Other deploy', project='project-b'),
    # Wider than the visitor scope: each needs one switch left on.
    'referenced': entity('Referenced deploy checklist', project='project-b', reference_project_ids=[PROJECT]),
    'inherited': entity('Inherited deploy checklist', project=PARENT),
    'global': entity('Global deploy checklist', project=None, has_global_episode=True),
    'preference': entity('Deploy checklist preference', profile_aspect='taste', preference_scope='project',
                         preference_project_id=PROJECT),
    # A person deleted one of its private sources; a normal one survives.
    'marked': entity('Marked deploy'),
}
EDGES = {
    'edge-visible': ('runbook', 'deploy', 'Synthetic runbook documents the deploy checklist'),
    'edge-to-source': ('runbook', 'source', 'Synthetic runbook lives in the checklist store'),
    'edge-to-secret': ('runbook', 'secret', 'Synthetic runbook deploy checklist opens it'),
    'edge-to-elsewhere': ('runbook', 'elsewhere', 'Synthetic runbook deploy checklist feeds it'),
    'edge-to-referenced': ('runbook', 'referenced', 'Synthetic runbook deploy checklist cites it'),
    'edge-to-inherited': ('runbook', 'inherited', 'Synthetic runbook deploy checklist extends it'),
    'edge-to-marked': ('runbook', 'marked', 'Synthetic runbook deploy checklist marks it'),
    # Matches only by the hidden endpoint's name.
    'edge-named-by-hidden': ('runbook', 'source', 'Synthetic runbook points somewhere'),
}
# Edges scoped wider than the visitor scope by themselves.
EDGE_SCOPES = {'edge-referenced-itself': {'assignment_project_id': 'project-b', 'reference_project_ids': [PROJECT]},
               'edge-inherited-itself': {'assignment_project_id': PARENT, 'inheritance_mode': 'descendants'},
               'edge-global-itself': {'assignment_project_id': None, 'episode_project_ids': [],
                                      'has_global_episode': True}}
EDGES.update({edge_id: ('runbook', 'deploy', 'Synthetic runbook deploy checklist, again') for edge_id in EDGE_SCOPES})
BASIS = confirmation_basis()


class PersonalGraph(Graph):
    def __init__(self):
        super().__init__({**{key: {'sources': value['sources'], 'marked': key == 'marked'}
                             for key, value in ENTITIES.items()},
                          **{key: {'sources': [capture('normal')]} for key in EDGES}})

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if 'item.uuid AS origin' in query or 'row.origin AS origin' in query:
            return self.lineage_rows(query, parameters), None, None
        if 'PERSONAL_PROJECT_RELATION' in query:
            return [{'project_id': PARENT, 'scope_path': [PROJECT, PARENT], 'scope_distance': 1}], None, None
        if 'AS endpoints_visible' in query:
            return [{'id': edge_id, 'endpoints_visible': True, 'assignment_project_id': PROJECT,
                     'episode_project_ids': [PROJECT], 'reference_project_ids': [],
                     'inheritance_mode': 'descendants', **EDGE_SCOPES.get(edge_id, {})}
                    for edge_id in parameters['edge_ids']], None, None
        if 'coalesce(edge.fuli_origin_quadrant' in query:
            return [{'id': edge_id, 'confirmation_status': 'confirmed', 'confirmation_basis_json': BASIS}
                    for edge_id in parameters['edge_ids']], None, None
        if 'MATCH (node:Entity {group_id: $group_id})' in query:
            wanted = parameters['entity_ids']
            return [{'id': key, 'group_id': GROUP, 'summary': '', 'confirmation_status': 'confirmed',
                     'confirmation_basis_json': BASIS, 'inheritance_mode': 'descendants',
                     **{name: value for name, value in fields.items() if name != 'sources'}}
                    for key, fields in ENTITIES.items()
                    if (wanted is None or key in wanted)
                    and fields['type'] not in parameters['excluded_entity_types']], None, None
        if 'MATCH (n:Entity)' in query:
            return [{'uuid': uuid, 'name': ENTITIES[uuid]['name']} for uuid in parameters['uuids']], None, None
        if 'IN $excluded_entity_types' in query:
            return [{'uuid': uuid} for uuid in parameters['uuids']
                    if ENTITIES[uuid]['type'] in parameters['excluded_entity_types']], None, None
        return [], None, None


class PersonalStore:
    def __init__(self, graph):
        self.runtime = SimpleNamespace(graphiti=self, driver=graph)
        self.settings = SimpleNamespace(graph_limit=100)

    async def search(self, query, *, group_ids, num_results):
        del query, group_ids, num_results
        return [SimpleNamespace(uuid=edge_id, group_id=GROUP, name='RELATES', fact=fact, source_node_uuid=source,
                                target_node_uuid=target, valid_at=None, invalid_at=None,
                                created_at=datetime(2026, 11, 1, tzinfo=timezone.utc), episodes=[])
                for edge_id, (source, target, fact) in EDGES.items()]

    async def authorize(self, actor, space_id, role):
        del actor, role
        return {'id': space_id, 'kind': 'personal', 'group_id': GROUP}


@pytest.fixture(autouse=True)
def personal_projects(monkeypatch):
    async def authorized(*args, **kwargs):
        del args, kwargs
    monkeypatch.setattr(knowledge_search, 'authorize_personal_project', authorized)


async def found(query, widened=None, **fields):
    """The relationships and entities a search returns, and the endpoint
    names it read. widened: switches set after validation, as a future caller
    could build a request without the model's check."""
    graph = PersonalGraph()
    request = SearchRequest(**{'space_ids': ['personal-space'], 'query': query, 'personal_project_ids': [PROJECT],
                               'active_personal_project_id': PROJECT, 'inherit_project_knowledge': False,
                               'limit': 20, **fields})
    for name, value in (widened or {}).items():
        setattr(request, name, value)
    result = await search_knowledge(PersonalStore(graph), {'id': 'actor'}, request)
    named = {uuid for query_text, parameters in graph.calls if 'MATCH (n:Entity)' in query_text
             for uuid in parameters['uuids']}
    return sorted(fact.id for fact in result.facts), sorted(item.id for item in result.entities), named


OWN_EDGES = ['edge-visible']
OWN_ENTITIES = {'runbook', 'deploy'}


async def test_a_visitor_gets_a_relationship_only_when_both_ends_are_visible():
    facts, entities, named = await found('deploy checklist', **VISITOR)
    assert facts == OWN_EDGES
    assert named == {'runbook', 'deploy'}
    assert set(entities) <= OWN_ENTITIES


async def test_a_hidden_entity_name_neither_finds_nor_ranks_a_relationship():
    facts, _, named = await found('Hidden repository', **VISITOR)
    assert facts == []
    assert 'source' not in named


@pytest.mark.parametrize('widened', [
    {'include_project_references': True}, {'inherit_project_knowledge': True}, {'include_personal_global': True},
    {'include_project_references': True, 'inherit_project_knowledge': True, 'include_personal_global': True},
])
async def test_a_switch_left_on_never_widens_a_visitor_search(widened):
    facts, entities, named = await found('deploy checklist', widened=widened, **VISITOR)
    assert facts == OWN_EDGES
    assert set(entities) <= OWN_ENTITIES
    assert named == {'runbook', 'deploy'}


async def test_the_wider_items_are_there_for_the_owner():
    _, entities, _ = await found('deploy checklist', include_personal_global=True, include_project_references=True,
                                 inherit_project_knowledge=True)
    assert {'referenced', 'inherited', 'global', 'preference'} <= set(entities)


async def test_excluded_types_drop_relationships_without_max_sensitivity_and_an_empty_list_changes_nothing():
    assert (await found('Hidden repository', excluded_entity_types=[]))[0] == ['edge-named-by-hidden', 'edge-to-source']
    assert (await found('deploy checklist', excluded_entity_types=[]))[0] == (await found('deploy checklist'))[0]
    assert (await found('Hidden repository', excluded_entity_types=['ProjectSource']))[0] == []
    kept = (await found('deploy checklist', excluded_entity_types=['ProjectSource']))[0]
    assert 'edge-to-source' not in kept and 'edge-visible' in kept


async def test_the_owner_search_is_unchanged():
    facts, _, _ = await found('deploy checklist')
    assert {'edge-to-elsewhere', 'edge-to-secret', 'edge-to-marked', 'edge-visible'} <= set(facts)
    assert 'marked' in (await found('Marked deploy'))[1]
    hidden, _, named = await found('Hidden repository')
    assert hidden == ['edge-named-by-hidden', 'edge-to-source']
    assert 'source' in named
