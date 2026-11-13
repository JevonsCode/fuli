"""max_sensitivity='normal' against a disposable graph, with synthetic records only.

An item reaches a visitor only when every non-edit source of every version
is explicitly normal (mixed, unset and absorbed private versions stay out)."""

from types import SimpleNamespace
from uuid import uuid4

from neo4j import AsyncGraphDatabase

from fuli_graph.knowledge_search import _personal_entities
from fuli_graph.knowledge_sensitivity import normal_only_ids
from fuli_graph.models import SearchRequest
from test_project_agent_memory_neo4j import fixture_settings

EDIT = ('human_knowledge_edit', 'private')


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
}
NORMAL_SAFE = {'normal', 'normal-then-edit', 'normal-edit-edit'}


async def _write_case(driver, group, project, case, versions):
    newer = None
    for index in reversed(range(len(versions))):
        item_id = f'{group}-{case}' if index == len(versions) - 1 else f'{group}-{case}-v{index}'
        await driver.execute_query('''
            MERGE (target:SensitivityTestTarget {group_id: $group})
            CREATE (node:Entity {uuid: $item_id, group_id: $group, name: $name,
                summary: 'Synthetic sensitivity evidence', fuli_replaced_by_item_id: $newer,
                fuli_replaced_by_item_kind: CASE WHEN $newer IS NULL THEN NULL ELSE 'entity' END})
            CREATE (node)-[edge:RELATES_TO {uuid: $item_id + '-edge', group_id: $group, episodes: [],
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

        scopes = {project: {'scope_distance': 0, 'scope_path': [project], 'inherited': False}}
        found = {}
        for max_sensitivity in (None, 'normal'):
            request = SearchRequest(space_ids=[group], query='Sensitivity fixture', limit=20,
                                    personal_project_ids=[project], active_personal_project_id=project,
                                    include_pending=True, max_sensitivity=max_sensitivity)
            entities = await _personal_entities(store, space, request, scopes)
            found[max_sensitivity] = {item.id.removeprefix(f'{group}-') for item in entities}
        assert found[None] == set(CASES)
        assert found['normal'] == NORMAL_SAFE

        edges = await normal_only_ids(store, 'relationship', [f'{group}-{case}-edge' for case in CASES])
        assert {item.removeprefix(f'{group}-').removesuffix('-edge') for item in edges} == NORMAL_SAFE
    finally:
        # Delete only this test's unique fixture, even on assertion failure.
        await driver.execute_query('''
            MATCH (node) WHERE node.group_id = $group OR node.space_id = $group
            DETACH DELETE node
        ''', group=group)
        await driver.close()
