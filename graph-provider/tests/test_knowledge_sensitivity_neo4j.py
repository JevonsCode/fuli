"""max_sensitivity='normal' against a disposable graph, with synthetic records only.

An item reaches a visitor only when every non-edit source of every version
is explicitly normal (mixed, unset and absorbed private versions stay out)."""

import re
from types import SimpleNamespace
from uuid import uuid4

from neo4j import AsyncGraphDatabase

from fuli_graph.knowledge_search import _personal_entities
from fuli_graph.knowledge_sensitivity import normal_only_ids
from fuli_graph.knowledge_source_delete_copies import remove_source_copies
from fuli_graph.models import SearchRequest
from test_collaboration_context import confirmation_basis
from test_project_agent_memory_neo4j import fixture_settings

EDIT = ('human_knowledge_edit', 'private')
# A replaced version's id in these fixtures.
REPLACED = re.compile(r'-v\d+$')


def capture(sensitivity):
    return ('conversation', sensitivity)


# Each case: its versions oldest first, each the (source kind, sensitivity) of
# its source episodes (sensitivity None: stored without one). The last is current.
CASES = {
    'private': [[capture('private')]],
    'restricted-and-private': [[capture('restricted'), capture('private')]],
    'normal': [[capture('normal')]],
    'mixed': [[capture('private'), capture('normal')]],
    'unset': [[capture(None)]],
    'no-episode': [[]],
    'normal-then-edit': [[capture('normal')], [EDIT]],
    'private-then-edit': [[capture('private')], [EDIT]],
    'normal-edit-edit': [[capture('normal')], [EDIT], [EDIT]],
    'edits-only': [[EDIT], [EDIT]],
    # A private item absorbed into a normal one (a merge or supersede), then edited.
    'private-then-normal': [[capture('private')], [capture('normal')]],
    'private-normal-edit': [[capture('private')], [capture('normal')], [EDIT]],
    # Its relationship's episode list will name an episode that no longer exists.
    'deleted-source': [[capture('normal')]],
}
NORMAL_SAFE = {'normal', 'normal-then-edit', 'normal-edit-edit'}
# An entity keeps no list of its sources, so a deleted one cannot be seen there.
NORMAL_SAFE_ENTITIES = NORMAL_SAFE | {'deleted-source'}


async def _write_case(driver, group, project, case, versions):
    """One item's versions, oldest first. A replaced version carries what
    every FULI writer sets when it replaces one (knowledge_versions.write_version,
    knowledge_versions.py:190-195): its validity ends (fuli_invalid_at on an
    entity, invalid_at on a relationship), expired_at, and the link to the
    newer version."""
    newer = None
    for index in reversed(range(len(versions))):
        item_id = f'{group}-{case}' if index == len(versions) - 1 else f'{group}-{case}-v{index}'
        await driver.execute_query('''
            MERGE (target:SensitivityTestTarget {group_id: $group})
            WITH target, CASE WHEN $newer IS NULL THEN NULL ELSE datetime() END AS ended_at
            CREATE (node:Entity {uuid: $item_id, group_id: $group, name: $name,
                summary: 'Synthetic sensitivity evidence', fuli_replaced_by_item_id: $newer,
                fuli_confirmation_status: 'confirmed', fuli_confirmation_basis_json: $basis,
                fuli_invalid_at: ended_at, expired_at: ended_at,
                fuli_replaced_by_item_kind: CASE WHEN $newer IS NULL THEN NULL ELSE 'entity' END})
            CREATE (node)-[edge:RELATES_TO {uuid: $item_id + '-edge', group_id: $group, episodes: [],
                invalid_at: ended_at, expired_at: ended_at,
                fuli_replaced_by_item_id: CASE WHEN $newer IS NULL THEN NULL ELSE $newer + '-edge' END,
                fuli_replaced_by_item_kind: CASE WHEN $newer IS NULL THEN NULL ELSE 'relationship' END}]->(target)
            FOREACH (_ IN CASE WHEN $current THEN [1] ELSE [] END |
                CREATE (:FuliKnowledgeAssignment {space_id: $group, item_kind: 'entity', item_id: $item_id,
                    project_id: $project}))
            WITH node, edge
            UNWIND range(0, size($sources) - 1) AS index
            CREATE (episode:Episodic {uuid: $item_id + '-episode-' + toString(index), group_id: $group,
                fuli_personal_project_id: $project, fuli_source_kind: $sources[index][0]})
            SET episode.fuli_sensitivity = $sources[index][1]
            CREATE (episode)-[:MENTIONS]->(node)
            SET edge.episodes = edge.episodes + episode.uuid
        ''', group=group, project=project, item_id=item_id, newer=newer, current=newer is None,
            basis=confirmation_basis(),
            name=f'Sensitivity fixture {case}' if newer is None else f'Old version {case} {index}',
            sources=[list(source) for source in versions[index]])
        newer = item_id


async def test_only_items_with_a_normal_source_reach_a_visitor():
    settings = fixture_settings()
    group = f'synthetic-sensitivity-{uuid4()}'
    driver = AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password))
    store = SimpleNamespace(runtime=SimpleNamespace(driver=driver), settings=SimpleNamespace(graph_limit=100))
    space = {'id': group, 'group_id': group}
    project = 'shared-project'
    try:
        for case, versions in CASES.items():
            await _write_case(driver, group, project, case, versions)
        await driver.execute_query('''
            MATCH ()-[edge:RELATES_TO {uuid: $edge_id}]->() SET edge.episodes = edge.episodes + 'deleted-episode'
        ''', edge_id=f'{group}-deleted-source-edge')

        scopes = {project: {'scope_distance': 0, 'scope_path': [project], 'inherited': False}}
        found = {}
        for max_sensitivity in (None, 'normal'):
            request = SearchRequest(space_ids=[group], query='Sensitivity fixture', limit=20,
                                    personal_project_ids=[project], active_personal_project_id=project,
                                    inherit_project_knowledge=False, include_project_references=False,
                                    max_sensitivity=max_sensitivity)
            entities = await _personal_entities(store, space, request, scopes)
            found[max_sensitivity] = {item.id.removeprefix(f'{group}-') for item in entities}
        assert found[None] == set(CASES)
        assert found['normal'] == NORMAL_SAFE_ENTITIES
        # Every lineage above has replaced versions; none reaches anyone, a visitor least of all.
        assert not any(REPLACED.search(item) for item in found[None] | found['normal'])

        edges = await normal_only_ids(store, 'relationship', [f'{group}-{case}-edge' for case in CASES])
        assert {item.removeprefix(f'{group}-').removesuffix('-edge') for item in edges} == NORMAL_SAFE
    finally:
        # Delete only this test's unique fixture, even on assertion failure.
        await driver.execute_query('''
            MATCH (node) WHERE node.group_id = $group OR node.space_id = $group
            DETACH DELETE node
        ''', group=group)
        await driver.close()


# Each case: the (source kind, sensitivity) of the source FULI's source delete
# removes, and whether the item, which keeps its other, normal source, is marked.
DELETED_SOURCES = {
    'deleted-private': (capture('private'), True),
    'deleted-restricted': (capture('restricted'), True),
    'deleted-unset': (capture(None), True),
    'deleted-normal': (capture('normal'), False),
    'deleted-edit': (EDIT, False),
}


async def test_deleting_a_non_normal_source_keeps_the_item_from_a_visitor():
    settings = fixture_settings()
    group = f'synthetic-source-delete-{uuid4()}'
    driver = AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password))
    store = SimpleNamespace(runtime=SimpleNamespace(driver=driver), settings=SimpleNamespace(graph_limit=100))
    space = {'id': group, 'group_id': group}
    project = 'shared-project'
    try:
        for case, (source, _) in DELETED_SOURCES.items():
            await _write_case(driver, group, project, case, [[source, capture('normal')]])
        # A successor written after its predecessor loses a private source.
        await _write_case(driver, group, project, 'successor', [[capture('private'), capture('normal')], [EDIT]])
        deleted = [f'{group}-{case}-episode-0' for case in DELETED_SOURCES] + [f'{group}-successor-v0-episode-0']
        await remove_source_copies(store, space, {'episodes': [{'uuid': uuid} for uuid in deleted],
                                                  'event_ids': [], 'conversation_ids': [], 'task_tokens': []})

        records, _, _ = await driver.execute_query('''
            MATCH (item:Entity) WHERE item.group_id = $group AND item.fuli_had_restricted_source
            RETURN item.uuid AS id
        ''', group=group)
        assert {record['id'].removeprefix(f'{group}-') for record in records} == {
            case for case, (_, mark) in DELETED_SOURCES.items() if mark} | {'successor-v0'}

        cases = [*DELETED_SOURCES, 'successor']
        visible = {case for case, (_, mark) in DELETED_SOURCES.items() if not mark}
        entities = await normal_only_ids(store, 'entity', [f'{group}-{case}' for case in cases])
        assert {item.removeprefix(f'{group}-') for item in entities} == visible
        edges = await normal_only_ids(store, 'relationship', [f'{group}-{case}-edge' for case in cases])
        assert {item.removeprefix(f'{group}-').removesuffix('-edge') for item in edges} == visible

        # The owner's search reads no marker.
        scopes = {project: {'scope_distance': 0, 'scope_path': [project], 'inherited': False}}
        owner = SearchRequest(space_ids=[group], query='Sensitivity fixture', limit=20,
                              personal_project_ids=[project], active_personal_project_id=project)
        owned = await _personal_entities(store, space, owner, scopes)
        assert {item.id.removeprefix(f'{group}-') for item in owned} == set(cases)
    finally:
        # Delete only this test's unique fixture, even on assertion failure.
        await driver.execute_query('''
            MATCH (node) WHERE node.group_id = $group OR node.space_id = $group
            DETACH DELETE node
        ''', group=group)
        await driver.close()
