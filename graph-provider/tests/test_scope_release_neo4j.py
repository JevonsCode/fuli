"""A follower that owns a project of its own stops keeping its host's copies
(scope_release.py), on a disposable Neo4j through the full Provider app.

The copies its own records point at (an FLA its project is staffed with) stay,
its own from now on, without the copy marker; every other copy goes; nothing of
its own changes. Synthetic data only.

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1.
"""
from uuid import uuid4

import pytest

from fuli_graph.provider_values import graphiti_group_id
from test_follower_space_neo4j import (  # noqa: F401
    HABIT, alone, follower_settings, host_global, no_personal_space, snapshot, strict, take_space,
)
from test_ai_review_neo4j import _commit_project_entity
from test_replica_write_guard_neo4j import personal_tag, episode
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_replica_recruitment_owner_neo4j import LOCAL, follower_with_local_project
from test_scope_export_neo4j import checked, cleanup
from test_scope_import_neo4j import OWNER, scenario


async def release(client, space_id, owner=OWNER, status=200):
    response = await client.post('/v1/scopes/release', params={'personal_space_id': space_id, 'owner': owner})
    assert response.status_code == status, response.text
    return response.json() if status == 200 else response.json()['detail']


async def copies(driver):
    records, _, _ = await driver.execute_query('''
        RETURN COUNT { MATCH (n) WHERE n.fuli_replica_owner IS NOT NULL } AS nodes,
               COUNT { MATCH ()-[r]->() WHERE r.fuli_replica_owner IS NOT NULL } AS links''')
    return records[0]['nodes'], records[0]['links']


async def own_project(driver, space_id):
    """This computer's own project, as text: what a release must leave as it was (but the copy
    marker of a record it reaches, which the release takes off)."""
    records, _, _ = await driver.execute_query('''
        MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->(project:FuliPersonalProject {project_id: $project})
        OPTIONAL MATCH (project)-[*1..2]->(below)
        WITH project, collect(DISTINCT below) AS below
        RETURN properties(project) AS project,
               [item IN below | [key IN keys(item) WHERE NOT key STARTS WITH 'fuli_replica' | [key, item[key]]]]
               AS below''',
        space=space_id, project=LOCAL)
    below = sorted(str(sorted(map(str, item))) for item in records[0]['below'])
    return str(below) + str(sorted(map(str, records[0]['project'].items())))


@pytest.mark.asyncio
async def test_a_release_keeps_the_copies_its_project_points_at_and_lets_the_rest_go(alone, strict):  # noqa: F811
    settings = fixture_settings()
    space_id, envelope = await host_global(settings, seed=personal_tag)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            await follower_with_local_project(client, settings, space_id, envelope)
            await checked(await client.post('/v1/project-agent-assignments', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL, 'agent_id': 'scope-lead',
                'idempotency_key': f'assign-{uuid4()}', 'responsibility': 'Keep the sample.',
                'work_kinds': ['implementation'], 'capabilities': ['coding'], 'reason': 'Synthetic staffing.'}))
            tag = next(n['properties']['id'] for n in envelope['nodes'] if
                       n['properties'].get('name') == 'Synthetic language' and 'FuliKnowledgeTag' in n['labels'])
            scope = {'personal_space_id': space_id, 'personal_project_id': LOCAL}
            item = await _commit_project_entity(client, space_id, LOCAL, 'release-item',
                                                name='Synthetic ledger', summary='A project record.')
            await checked(await client.post('/v1/knowledge-tags/attach', json={
                **scope, 'tag_id': tag, 'item_kind': 'entity', 'item_id': item}))
            # A project preference and the inherited global habit it has to
            # reconcile. Conflict members are named only by kind and UUID.
            local = episode('project-habit', habit=True)
            await checked(await client.post('/v1/knowledge/commits', json={
                'space_id': space_id, 'personal_project_id': LOCAL, 'episode': local}))
            await driver.execute_query("""
                MATCH (s:FuliSpace {id: $space}), (p:Entity {group_id: $group, name: $name})
                CREATE (s)-[:HAS_PREFERENCE_CONFLICT]->(:FuliPreferenceConflict {
                    id: $id, personal_space_id: $space, preference_project_id: $project,
                    left_item_kind: 'entity', left_item_id: p.uuid, right_item_kind: 'entity',
                    right_item_id: $global_item})
                """, space=space_id, group=group, name=local['entities'][0]['name'], project=LOCAL,
                id=f'{space_id}-local-conflict', global_item=f'{space_id}-pref-global')
            own = await own_project(driver, space_id)
            assert (await copies(driver))[0] > 0
            released = await release(client, space_id)
            assert released['owner'] == OWNER
            assert released['kept']['nodes'] >= 1 and released['deleted']['nodes'] >= 1
            left, _, _ = await driver.execute_query(
                'MATCH (n) WHERE n.fuli_replica_owner IS NOT NULL RETURN labels(n) AS labels')
            assert await copies(driver) == (0, 0), [row['labels'] for row in left]
            records, _, _ = await driver.execute_query('''
                MATCH (space:FuliSpace {id: $space})-[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent)
                RETURN agent.agent_id AS agent_id, [key IN keys(agent) WHERE key STARTS WITH 'fuli_replica'] AS marker
                ''', space=space_id)
            agents = {row['agent_id']: row['marker'] for row in records}
            assert agents.get('scope-lead') == [], 'the staffed FLA stays, its own now'
            assert 'scope-writer' not in agents, 'a copy nothing here points at goes'
            assert await own_project(driver, space_id) == own
            prefs = await checked(await client.get('/v1/collaboration-preferences', params=scope))
            assert HABIT in str(prefs)
            tags, _, _ = await driver.execute_query(
                'MATCH (t:FuliKnowledgeTag {id: $tag})-[:TAGS]->(l:FuliKnowledgeTagLink {item_id: $item}) '
                'RETURN t.name AS name', tag=tag, item=item)
            assert [row['name'] for row in tags] == ['Synthetic language']
            assigned = await checked(await client.get('/v1/project-agent-assignments', params={
                'personal_space_id': space_id, 'personal_project_id': LOCAL}))
            assert [item['agent_id'] for item in assigned] == ['scope-lead']
            assert (await release(client, space_id, status=409))['code'] == 'replica_not_held'
        finally:
            await cleanup(driver.maintenance(), space_id, group)


@pytest.mark.asyncio
async def test_a_graph_without_copies_has_nothing_to_release(alone):  # noqa: F811
    async with provider_client(fixture_settings()) as (client, _):
        await no_personal_space(client)
        driver, space, group = await scenario(client)
        try:
            before = await snapshot(driver, space)
            assert (await release(client, space, status=409))['code'] == 'replica_not_held'
            assert await snapshot(driver, space) == before
        finally:
            await cleanup(driver, space, group)
