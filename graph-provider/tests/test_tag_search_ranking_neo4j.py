"""D-31 against disposable Neo4j: real vocabulary Cypher and search filtering.

Uses the existing opt-in loopback fixture and its per-space cleanup. Only the
Graphiti candidate generator is deterministic; ranking, authorization, item
projection and all vocabulary reads use the actual Provider and graph.
"""
import json
from unittest.mock import AsyncMock, patch

import pytest

from fuli_graph.knowledge_search import search_knowledge
from fuli_graph.models import SearchRequest
from test_knowledge_tags_neo4j import run_in_world


async def ranking_scenario(world):
    await world.project('synthetic-hidden-project')
    labels = ['plain', 'direct', 'child', 'related', 'grandchild', 'hidden', 'detached']
    items = {label: await world.item(None, 'Deployment legacy forbidden') for label in labels}
    basis = json.dumps({
        'existence_reason': 'Synthetic ranking acceptance', 'quadrant_reason': 'Synthetic evidence',
        'proposed_by': {'kind': 'agent'}, 'confirmed_by': {'kind': 'user'},
        'confirmed_at': '2026-10-18T00:00:00Z'})
    await world.driver.execute_query('''
        MATCH (item:Entity {group_id: $group})
        SET item.summary = 'Synthetic deployment legacy forbidden guidance',
            item.fuli_confirmation_status = 'confirmed', item.fuli_confirmation_basis_json = $basis
    ''', group=await world.group_id(), basis=basis)

    def tag(key, name, **changes):
        return {'id': f'{world.space}-tag-{key}', 'space_id': world.space,
                'namespace_key': 'personal', 'namespace_kind': 'personal',
                'name': name, 'name_key': name, 'status': 'active',
                'alias_keys': [], 'alias_statuses': [], 'parent_ids': [], 'related_ids': [], **changes}

    root = tag('root', 'deployment', alias_keys=['launch'], alias_statuses=['active'])
    child = tag('child', 'canary', parent_ids=[root['id']])
    related = tag('related', 'operations', related_ids=[root['id']])
    grandchild = tag('grandchild', 'leaf', parent_ids=[child['id']])
    hidden = tag('hidden', 'deployment', namespace_key='project:synthetic-hidden-project',
                 namespace_kind='project', namespace_project_id='synthetic-hidden-project',
                 parent_ids=[root['id']])
    merged = tag('old', 'legacy', status='merged', merged_into_id=root['id'])
    blocked = tag('blocked', 'forbidden', status='merged', merged_into_id=hidden['id'])
    retired = tag('retired', 'retired', status='retired', parent_ids=[root['id']])
    provisional = tag('provisional', 'draft', status='provisional', parent_ids=[root['id']])
    tags = [root, child, related, grandchild, hidden, merged, blocked, retired, provisional]
    await world.driver.execute_query('''
        MATCH (space:FuliSpace {id: $space})
        UNWIND $tags AS row
        CREATE (space)-[:HAS_KNOWLEDGE_TAG]->(tag:FuliKnowledgeTag)
        SET tag = row
    ''', space=world.space, tags=tags)

    links = []
    for label, attached_tag in [('direct', root), ('child', child), ('related', related),
                                ('grandchild', grandchild), ('hidden', hidden), ('detached', root)]:
        links.append({'id': f'{world.space}-link-{label}', 'space_id': world.space,
                      'tag_id': attached_tag['id'], 'item_kind': 'entity', 'item_id': items[label]['item_id'],
                      'status': 'detached' if label == 'detached' else 'attached'})
    # Extra links cannot introduce a candidate or cross the entity/relationship boundary.
    links.extend([
        {'id': f'{world.space}-link-absent', 'space_id': world.space, 'tag_id': root['id'],
         'item_kind': 'entity', 'item_id': f'{world.space}-absent', 'status': 'attached'},
        {'id': f'{world.space}-link-other-kind', 'space_id': world.space, 'tag_id': root['id'],
         'item_kind': 'relationship', 'item_id': items['plain']['item_id'], 'status': 'attached'},
    ])
    await world.driver.execute_query('''
        UNWIND $links AS row
        MATCH (tag:FuliKnowledgeTag {space_id: $space, id: row.tag_id})
        CREATE (tag)-[:TAGS]->(link:FuliKnowledgeTagLink)
        SET link = row
    ''', space=world.space, links=links)

    reader = world.store.knowledge_tag_vocabulary().reader(world.space)
    visible = ['personal']
    assert [row['id'] for row in await reader.ranking_roots(visible, ['deployment'])] == [root['id']]
    assert [row['id'] for row in await reader.ranking_roots(visible, ['launch'])] == [root['id']]
    assert await reader.ranking_target(visible, hidden['id']) is None
    assert (await reader.ranking_target(visible, root['id']))['id'] == root['id']
    assert {row['id'] for row in await reader.ranking_neighbors(visible, [root['id']])} == {
        child['id'], related['id']}
    assert [row['item_id'] for row in await reader.ranking_links(
        [root['id']], 'entity', [item['item_id'] for item in items.values()])] == [items['direct']['item_id']]

    principals, _, _ = await world.driver.execute_query('''
        MATCH (principal:FuliPrincipal)-[:OWNS]->(:FuliSpace {id: $space})
        RETURN principal.id AS id
    ''', space=world.space)
    actor = {'id': principals[0]['id']}
    query = SearchRequest(space_ids=[world.space], query='deployment', include_personal_global=True, limit=20)
    with patch.object(world.store.runtime.graphiti, 'search', AsyncMock(return_value=[])):
        explanations = {}
        results = await search_knowledge(world.store, actor, query, tag_explanations=explanations)
        assert {item.id for item in results.entities} == {item['item_id'] for item in items.values()}
        assert results.entities[0].id == items['direct']['item_id']
        assert results.facts == []
        factor = lambda label: explanations['entity', items[label]['item_id']]['multiplier']
        assert factor('direct') == 1.25
        assert factor('child') == factor('related') == 1.1
        assert all(factor(label) == 1 for label in ['plain', 'grandchild', 'hidden', 'detached'])
        assert explanations['entity', items['child']['item_id']]['matches'][0]['method'] == 'child_of'

        # A real merged record resolves its target with the scoped Cypher read.
        merged_details = {}
        await search_knowledge(world.store, actor, query.model_copy(update={'query': 'legacy'}),
                               tag_explanations=merged_details)
        assert merged_details['entity', items['direct']['item_id']]['matches'][0]['method'] == 'redirect_from'
        assert merged_details['entity', items['direct']['item_id']]['multiplier'] == 1.25

        # Even a damaged cross-namespace redirect cannot expose the hidden target.
        blocked_details = {}
        await search_knowledge(world.store, actor, query.model_copy(update={'query': 'forbidden'}),
                               tag_explanations=blocked_details)
        assert all(detail['multiplier'] == 1 and detail['matches'] == [] for detail in blocked_details.values())


@pytest.mark.asyncio
async def test_tag_ranking_reader_and_search_pipeline_on_neo4j():
    await run_in_world(ranking_scenario)
