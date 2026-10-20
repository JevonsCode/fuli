"""Tag vocabulary scenarios on a disposable Neo4j through the full Provider app.

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1. Every scenario
uses its own synthetic personal space; only that space's nodes are removed.
"""
import asyncio
from uuid import uuid4

import pytest

from knowledge_tag_scenarios import SCENARIOS, create, post, resolve
from test_project_agent_memory_neo4j import fixture_settings, provider_client


class Neo4jWorld:
    def __init__(self, client, store, space):
        self.client, self.store, self.space = client, store, space
        self.counter = 0

    @property
    def driver(self):
        return self.store.runtime.driver

    async def group_id(self):
        records, _, _ = await self.driver.execute_query(
            'MATCH (space:FuliSpace {id: $id}) RETURN space.group_id AS group_id', id=self.space)
        return records[0]['group_id']

    async def project(self, project_id):
        response = await self.client.put('/v1/personal-projects', json={
            'personal_space_id': self.space, 'project_id': project_id,
            'profile': {'name': f'Synthetic {project_id}', 'lifecycle': 'active',
                        'purpose': 'Synthetic tag vocabulary acceptance.'}})
        assert response.status_code == 200, response.text

    async def item(self, project_id, name):
        self.counter += 1
        item_id = f'{self.space}-item-{self.counter}'
        await self.driver.execute_query('''
            CREATE (:Entity {uuid: $item_id, group_id: $group_id, name: $name,
                summary: 'Synthetic preference', fuli_type: 'PersonalPreference',
                fuli_profile_aspect: 'taste', fuli_confirmation_status: 'agent_confirmed',
                fuli_confirmation_basis_json: '{}', fuli_qualified_use_count: 3,
                fuli_utility_score: 0.4, fuli_preference_scope: 'global'})
            WITH 1 AS _
            MATCH (space:FuliSpace {id: $space_id})
            FOREACH (_ IN CASE WHEN $project_id IS NULL THEN [] ELSE [1] END |
                CREATE (space)-[:HAS_KNOWLEDGE_ASSIGNMENT]->(:FuliKnowledgeAssignment {
                    id: $item_id + '-assignment', space_id: $space_id, item_kind: 'entity',
                    item_id: $item_id, project_id: $project_id, reason: 'Synthetic owner',
                    created_at: datetime(), updated_at: datetime()}))
        ''', item_id=item_id, group_id=await self.group_id(), name=name,
            project_id=project_id, space_id=self.space)
        return {'item_kind': 'entity', 'item_id': item_id}

    async def item_state(self, item):
        records, _, _ = await self.driver.execute_query(
            'MATCH (item:Entity {uuid: $id}) RETURN properties(item) AS item', id=item['item_id'])
        return records[0]['item']


async def cleanup(world):
    group_id = await world.group_id()
    await world.driver.execute_query('''
        MATCH (node) WHERE node.space_id = $space OR node.group_id = $group
            OR node.personal_space_id = $space OR node.id = $space
        DETACH DELETE node
    ''', space=world.space, group=group_id)


async def run_in_world(scenario):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': f'Synthetic tags {uuid4().hex[:8]}', 'kind': 'personal'})
        assert space.status_code == 200, space.text
        store = client._transport.app.state.store
        world = Neo4jWorld(client, store, space.json()['id'])
        try:
            await scenario(world)
        finally:
            await cleanup(world)


@pytest.mark.asyncio
@pytest.mark.parametrize('scenario', SCENARIOS, ids=lambda scenario: scenario.__name__)
async def test_tag_vocabulary_scenario_on_neo4j(scenario):
    await run_in_world(scenario)


async def alias_races_create(world):
    """An alias and a creation of the same word race; never both identities."""
    for attempt in range(8):
        # One project per attempt keeps earlier attempts out of the candidates.
        project, word = f'race-{attempt}', f'野外教学{attempt}'
        await world.project(project)
        outdoor = (await create(world, f'户外学习{attempt}', project))['tag']
        aliased, created = await asyncio.gather(
            post(world, 'aliases', {'personal_project_id': project, 'tag_id': outdoor['id'],
                                    'alias': word, 'reason': 'synonym'}),
            create(world, word, project, reason='race', distinct_from=[outdoor['id']]))
        holders = {candidate['id'] for candidate in await resolve(world, word, project)
                   if candidate['match'] in {'exact', 'alias'}}
        assert len(holders) == 1, (aliased, created)
        if aliased['outcome'] == 'added':
            assert (created['outcome'], created['tag']['id']) == ('existing', outdoor['id'])
        else:
            assert aliased['outcome'] == 'conflict' and created['outcome'] == 'created'


async def one_node_one_revision(world):
    """G4-4 in storage: one tag node, one creation revision, one link per item."""
    await world.project('nature-notes')
    item = await world.item('nature-notes', 'Bird sketch')
    results = await asyncio.gather(*[create(world, '自然笔记', 'nature-notes', reason=f'Agent {index}')
                                      for index in range(6)])
    tag_id = results[0]['tag']['id']
    await asyncio.gather(*[post(world, 'attach', {'personal_project_id': 'nature-notes',
                                                  'tag_id': tag_id, **item}) for _ in range(4)])
    records, _, _ = await world.driver.execute_query('''
        MATCH (tag:FuliKnowledgeTag {space_id: $space})
        OPTIONAL MATCH (tag)-[:HAS_TAG_REVISION]->(revision:FuliKnowledgeTagRevision)
        OPTIONAL MATCH (tag)-[:TAGS]->(link:FuliKnowledgeTagLink)
        RETURN count(DISTINCT tag) AS tags, count(DISTINCT revision) AS revisions,
               count(DISTINCT link) AS links, collect(DISTINCT tag.version) AS versions
    ''', space=world.space)
    assert dict(records[0]) == {'tags': 1, 'revisions': 1, 'links': 1, 'versions': [1]}


@pytest.mark.asyncio
@pytest.mark.parametrize('scenario', [alias_races_create, one_node_one_revision],
                         ids=lambda scenario: scenario.__name__)
async def test_concurrent_vocabulary_writes_on_neo4j(scenario):
    await run_in_world(scenario)
