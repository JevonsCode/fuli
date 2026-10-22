"""Tag vocabulary scenarios on a disposable Neo4j through the full Provider app.

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1. Every scenario
uses its own synthetic personal space; only that space's nodes are removed.
"""
import asyncio
from uuid import uuid4

import pytest

from fuli_graph.knowledge_versions import lock_knowledge
from fuli_graph.provider_values import native_datetime
from fuli_graph.store_transactions import query_store_transaction
from knowledge_tag_governance_scenarios import GOVERNANCE_SCENARIOS
from knowledge_tag_scenarios import REVIEW_TOKEN, SCENARIOS, alias, create, post, resolve
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

    async def sourced_item(self, kind, project_ids):
        """A non-preference item mentioned only by the given projects' episodes."""
        self.counter += 1
        item_id = f'{self.space}-sourced-{self.counter}'
        episodes = [{'uuid': f'{item_id}-episode-{project}', 'project': project}
                    for project in project_ids]
        await self.driver.execute_query('''
            UNWIND $episodes AS episode
            CREATE (:Episodic {uuid: episode.uuid, group_id: $group_id, name: 'Synthetic episode',
                               fuli_personal_project_id: episode.project})
        ''', episodes=episodes, group_id=await self.group_id())
        if kind == 'entity':
            await self.driver.execute_query('''
                CREATE (item:Entity {uuid: $item_id, group_id: $group_id, name: 'Synthetic concept',
                                     summary: 'Synthetic concept'})
                WITH item
                UNWIND $episode_ids AS episode_id
                MATCH (episode:Episodic {uuid: episode_id})
                CREATE (episode)-[:MENTIONS]->(item)
            ''', item_id=item_id, group_id=await self.group_id(),
                episode_ids=[episode['uuid'] for episode in episodes])
        else:
            await self.driver.execute_query('''
                CREATE (:Entity {uuid: $item_id + '-from', group_id: $group_id, name: 'From'})
                       -[:RELATES_TO {uuid: $item_id, group_id: $group_id, name: 'RELATES_TO',
                                      fact: 'Synthetic fact', episodes: $episode_ids}]->
                       (:Entity {uuid: $item_id + '-to', group_id: $group_id, name: 'To'})
            ''', item_id=item_id, group_id=await self.group_id(),
                episode_ids=[episode['uuid'] for episode in episodes])
        return {'item_kind': kind, 'item_id': item_id}

    async def item_state(self, item):
        records, _, _ = await self.driver.execute_query(
            'MATCH (item:Entity {uuid: $id}) RETURN properties(item) AS item', id=item['item_id'])
        return records[0]['item']

    async def stored(self):
        """Every tag's and link's stored record, for exact before/after comparisons."""
        tags, _, _ = await self.driver.execute_query(
            'MATCH (tag:FuliKnowledgeTag {space_id: $space}) RETURN properties(tag) AS tag', space=self.space)
        links, _, _ = await self.driver.execute_query(
            'MATCH (link:FuliKnowledgeTagLink {space_id: $space}) RETURN properties(link) AS link',
            space=self.space)
        return ({record['tag']['id']: _native(record['tag']) for record in tags},
                {record['link']['id']: _native(record['link']) for record in links})

    async def attached(self, item):
        """The tag IDs an item's attached links name, one entry per link."""
        records, _, _ = await self.driver.execute_query('''
            MATCH (tag:FuliKnowledgeTag)-[:TAGS]->(link:FuliKnowledgeTagLink {
                space_id: $space, item_kind: $kind, item_id: $id, status: 'attached'})
            RETURN tag.id AS tag_id ORDER BY tag_id
        ''', space=self.space, kind=item['item_kind'], id=item['item_id'])
        return [record['tag_id'] for record in records]


def _native(record):
    return {key: native_datetime(value) for key, value in record.items()}


async def cleanup(world):
    group_id = await world.group_id()
    await world.driver.execute_query('''
        MATCH (node) WHERE node.space_id = $space OR node.group_id = $group
            OR node.personal_space_id = $space OR node.id = $space
        DETACH DELETE node
    ''', space=world.space, group=group_id)


async def run_in_world(scenario):
    settings = fixture_settings().model_copy(update={'human_review_token': REVIEW_TOKEN})
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


async def alias_history_in_storage(world):
    """Alias statuses, proposals and their history are stored, not only returned."""
    await world.project('class')
    draft = (await create(world, '户外学习', 'class'))['tag']
    mine = (await create(world, '观察记录', 'class', operation_actor='human', reason='mine'))['tag']
    await alias(world, draft['id'], '野外课', 'class')
    await alias(world, mine['id'], '观察日志', 'class')
    # First confirmation upgrades; a second confirmation does not duplicate.
    for _ in range(2):
        await alias(world, draft['id'], '野外课', 'class', operation_actor='human', reason='accept')
        await alias(world, mine['id'], '观察日志', 'class', operation_actor='human', reason='accept')
    records, _, _ = await world.driver.execute_query('''
        MATCH (tag:FuliKnowledgeTag {space_id: $space})-[:HAS_TAG_REVISION]->(revision)
        WITH tag, revision ORDER BY revision.version
        RETURN tag.name AS name, tag.aliases AS aliases, tag.alias_statuses AS statuses,
               tag.proposed_aliases AS proposed, tag.version AS version,
               collect([revision.action, revision.alias_status, revision.version]) AS history
        ORDER BY name
    ''', space=world.space)
    assert [dict(record) for record in records] == [
        {'name': '户外学习', 'aliases': ['野外课'], 'statuses': ['active'], 'proposed': [],
         'version': 3, 'history': [['create', None, 1], ['add_alias', 'provisional', 2],
                                   ['confirm_alias', 'active', 3]]},
        {'name': '观察记录', 'aliases': ['观察日志'], 'statuses': ['active'], 'proposed': [],
         'version': 3, 'history': [['create', None, 1], ['propose_alias', 'proposed', 2],
                                   ['add_alias', 'active', 3]]}]
    created, _, _ = await world.driver.execute_query('''
        MATCH (:FuliKnowledgeTag {space_id: $space})-[:HAS_TAG_REVISION]->(revision {action: 'create'})
        RETURN DISTINCT revision.similarity_version AS version
    ''', space=world.space)
    assert [record['version'] for record in created] == ['lexical-hash/fuli-embed-v1/384@0.35']


async def stale_personal_tag_is_rechecked_under_the_lock(world):
    """A personal tag created after a project create's first look still wins under the lock."""
    await world.project('novel')
    results = await asyncio.gather(create(world, '写作', namespace='personal'),
                                   create(world, '写作', 'novel'))
    personal, project = results
    assert personal['outcome'] == 'created'
    if project['outcome'] == 'existing':
        assert project['tag']['id'] == personal['tag']['id']
    else:
        # The project tag came first; a personal tag never scans project vocabularies.
        assert (project['outcome'], project['tag']['namespace']) == ('created', 'project')


@pytest.mark.asyncio
@pytest.mark.parametrize('scenario', [alias_races_create, one_node_one_revision,
                                      alias_history_in_storage,
                                      stale_personal_tag_is_rechecked_under_the_lock],
                         ids=lambda scenario: scenario.__name__)
async def test_concurrent_vocabulary_writes_on_neo4j(scenario):
    await run_in_world(scenario)


@pytest.mark.asyncio
@pytest.mark.parametrize('scenario', GOVERNANCE_SCENARIOS, ids=lambda scenario: scenario.__name__)
async def test_tag_governance_scenario_on_neo4j(scenario):
    await run_in_world(scenario)


async def an_attach_queued_behind_a_delete_never_tags_the_deleted_item(world):
    """The tag/assignment follow-up, deterministically: a transaction holds the
    space's knowledge lock (as a hard delete does) and removes the item; the
    attach that was waiting for the lock reads the item again and finds nothing."""
    await world.project('class')
    tag = (await create(world, '户外学习', 'class'))['tag']
    item = await world.item('class', 'Bird walk')
    async with query_store_transaction(world.store) as scoped:
        await lock_knowledge(scoped, {'id': world.space})
        pending = asyncio.create_task(world.client.post('/v1/knowledge-tags/attach', json={
            'personal_space_id': world.space, 'personal_project_id': 'class', 'tag_id': tag['id'], **item}))
        await asyncio.sleep(1.0)
        assert not pending.done(), 'the attach waits for the lock'
        await scoped.runtime.driver.execute_query('''
            MATCH (entity:Entity {uuid: $item_id})
            OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {item_id: $item_id})
            DETACH DELETE entity, assignment
        ''', item_id=item['item_id'])
    refused = await pending
    assert refused.status_code == 404, refused.text
    assert await world.attached(item) == []
    records, _, _ = await world.driver.execute_query(
        'MATCH (link:FuliKnowledgeTagLink {item_id: $item_id}) RETURN count(link) AS links', item_id=item['item_id'])
    assert records[0]['links'] == 0


@pytest.mark.asyncio
async def test_an_attach_rereads_the_item_under_the_lock_on_neo4j():
    await run_in_world(an_attach_queued_behind_a_delete_never_tags_the_deleted_item)
