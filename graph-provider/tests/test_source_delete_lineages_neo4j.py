"""Legacy provenance query compatibility on explicitly isolated test Neo4j."""
from types import SimpleNamespace
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from fuli_graph.knowledge_item_view import item_evidence
from fuli_graph.knowledge_source_delete_lineages import source_delete_lineages
from fuli_graph.knowledge_source_delete_selection import source_delete_selection
from test_knowledge_hard_delete_neo4j import reviewed


@pytest.mark.asyncio
@pytest.mark.parametrize('current_sources', [[], ['turn']])
async def test_legacy_relation_provenance_keeps_multisource_item(current_sources):
    settings = reviewed()
    group = 'synthetic-source-lineage-' + str(uuid4())
    turn, elsewhere = group + '-turn', group + '-elsewhere'
    async with AsyncGraphDatabase.driver(settings.neo4j_uri,
            auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
        try:
            await driver.execute_query('''
                CREATE (a:Entity {uuid: $left, group_id: $group})
                CREATE (b:Entity {uuid: $right, group_id: $group})
                CREATE (a)-[:RELATES_TO {uuid: $edge, group_id: $group, episodes: $sources,
                    fact: 'Synthetic retained relationship'}]->(b)
                CREATE (:Episodic {uuid: $turn, group_id: $group, entity_edges: [$edge]})
                CREATE (:Episodic {uuid: $elsewhere, group_id: $group, entity_edges: [$edge]})
                ''', group=group, left=group + '-left', right=group + '-right',
                edge=group + '-edge', sources=[turn] if current_sources else [], turn=turn, elsewhere=elsewhere)
            store = SimpleNamespace(runtime=SimpleNamespace(driver=driver))
            space = {'id': group, 'group_id': group}
            evidence, ids = await item_evidence(store, space, 'relationship', group + '-edge')
            assert sorted(ids) == sorted([elsewhere, turn])
            assert len(evidence) == 2
            rows = await source_delete_lineages(store, space, [turn])
            selection = source_delete_selection(rows, [turn])
            assert selection['selected_keys'] == []
            assert selection['retained_sources'] == {'relationship:' + group + '-edge': [elsewhere]}
        finally:
            await driver.execute_query('MATCH (node {group_id: $group}) DETACH DELETE node', group=group)
