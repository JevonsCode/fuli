"""Scope export on a disposable Neo4j through the full Provider app
(docs/runner-roles-design.md, "Scopes in the graph").

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1. The scenario
uses its own synthetic personal space; only that space's records are removed.
"""
import json
from uuid import uuid4

import pytest
from neo4j.exceptions import ClientError

from test_project_agent_memory_neo4j import fixture_settings, provider_client, write_payload

PROJECTS = ('alpha', 'beta', 'gamma')


async def export(client, space, scope, **options):
    response = await client.post('/v1/scopes/export', json={'personal_space_id': space, 'scope': scope, **options})
    assert response.status_code == 200, response.text
    return response.json()


async def checked(response):
    assert response.status_code == 200, response.text
    return response.json()


async def seed_people_and_work(client, space):
    """Projects, two FLAs (the lead in two projects), their global and project
    memories, and one client session whose tasks span two projects."""
    for project in PROJECTS:
        await checked(await client.put('/v1/personal-projects', json={
            'personal_space_id': space, 'project_id': project,
            'profile': {'name': f'Synthetic {project}', 'lifecycle': 'active', 'purpose': 'Scope export check.'}}))
    for agent, project in (('scope-lead', 'alpha'), ('scope-lead', 'beta'), ('scope-writer', 'beta')):
        await checked(await client.put('/v1/project-agents', json={
            'personal_space_id': space, 'personal_project_id': project, 'agent_id': agent,
            'occupation': {'role': 'engineering'},
            'profile': {'name': f'Synthetic {agent}', 'responsibility': 'Keep the sample.',
                        'allowed_clients': ['codex'], 'work_kinds': ['implementation'], 'capabilities': ['coding']}}))
    for agent, project in (('scope-lead', None), ('scope-lead', 'alpha'), ('scope-lead', 'beta'),
                           ('scope-writer', 'beta')):
        await checked(await client.put(f'/v1/project-agents/{agent}/memory', json=write_payload(
            space, personal_project_id=project, agent_id=agent, idempotency_key=f'memory-{agent}-{project}')))
    for project in ('alpha', 'beta'):
        await checked(await client.put('/v1/task-contexts', json={
            'personal_space_id': space, 'personal_project_id': project, 'source_application': 'codex',
            'session_id': 'synthetic-cross-project-session', 'token': f'fuli-task-scope-{project}-0001',
            'turn_id': f'turn-{project}'}))


async def seed_knowledge(driver, space, group):
    """Habits (a global one with its earlier version, a project one, one in two
    projects, one inherited), knowledge with a referenced project, the episode
    that is evidence for both kinds, and a global-project conflict."""
    await driver.execute_query('''
        MATCH (space:FuliSpace {id: $space})
        CREATE (:Entity {uuid: $space + '-habit-old', group_id: $group, name: 'Short answers, v1',
                fuli_profile_aspect: 'taste', fuli_preference_scope: 'global',
                fuli_replaced_by_item_id: $space + '-habit', fuli_replaced_by_item_kind: 'entity'})
        CREATE (:Entity {uuid: $space + '-habit', group_id: $group, name: 'Short answers',
                fuli_profile_aspect: 'taste', fuli_preference_scope: 'global', fuli_human_change_version: 2,
                fuli_derived_from_item_ids: [$space + '-habit-old'], name_embedding: [0.25, 0.5]})
        CREATE (space)-[:HAS_KNOWLEDGE_REVISION]->(:FuliKnowledgeRevision {id: $space + '-revision',
                space_id: $space, item_id: $space + '-habit', item_kind: 'entity', action: 'supersede',
                reason: 'Synthetic edit', previous_json: '{}', current_json: '{}', created_by: 'synthetic',
                created_at: datetime('2026-11-01T00:00:00Z')})
        CREATE (:Entity {uuid: $space + '-habit-alpha', group_id: $group, name: 'Alpha uses tabs',
                fuli_profile_aspect: 'taste', fuli_preference_scope: 'project', fuli_preference_project_id: 'alpha'})
        CREATE (:Entity {uuid: $space + '-habit-beta', group_id: $group, name: 'Beta uses spaces',
                fuli_profile_aspect: 'taste', fuli_preference_scope: 'project', fuli_preference_project_id: 'beta'})
        CREATE (:Entity {uuid: $space + '-habit-both', group_id: $group, name: 'Both review on Friday',
                fuli_profile_aspect: 'taste', fuli_preference_scope: 'project', fuli_preference_project_id: 'alpha',
                fuli_preference_project_ids: ['alpha', 'beta']})
        CREATE (:Entity {uuid: $space + '-habit-inherited', group_id: $group, name: 'Alpha and gamma lint',
                fuli_profile_aspect: 'taste', fuli_preference_scope: 'project', fuli_preference_project_id: 'alpha',
                fuli_inheritance_mode: 'selected_projects', fuli_inherited_project_ids: ['gamma']})
        CREATE (fact:Entity {uuid: $space + '-fact', group_id: $group, name: 'Alpha ships weekly'})
        CREATE (beta_fact:Entity {uuid: $space + '-fact-beta', group_id: $group, name: 'Beta ships monthly'})
        CREATE (space)-[:HAS_KNOWLEDGE_ASSIGNMENT]->(:FuliKnowledgeAssignment {id: $space + '-assign',
                space_id: $space, item_kind: 'entity', item_id: $space + '-fact', project_id: 'alpha',
                reason: 'Synthetic', changed_by: 'synthetic', created_at: datetime(), updated_at: datetime()})
        CREATE (space)-[:HAS_KNOWLEDGE_ASSIGNMENT]->(:FuliKnowledgeAssignment {id: $space + '-assign-beta',
                space_id: $space, item_kind: 'entity', item_id: $space + '-fact-beta', project_id: 'beta',
                reason: 'Synthetic', changed_by: 'synthetic', created_at: datetime(), updated_at: datetime()})
        CREATE (space)-[:HAS_KNOWLEDGE_REFERENCE]->(:FuliKnowledgeProjectReference {id: $space + '-reference',
                space_id: $space, item_kind: 'entity', item_id: $space + '-fact', project_id: 'beta',
                source_project_id: 'alpha', status: 'active', reason: 'Synthetic', changed_by: 'synthetic',
                created_at: datetime(), updated_at: datetime()})
        CREATE (episode:Episodic {uuid: $space + '-episode', group_id: $group, name: 'Synthetic checkpoint',
                fuli_personal_project_id: 'alpha', content: ''})
        CREATE (episode)-[:MENTIONS {uuid: $space + '-mention-fact', group_id: $group}]->(fact)
        WITH space, episode
        MATCH (habit:Entity {uuid: $space + '-habit'})
        CREATE (episode)-[:MENTIONS {uuid: $space + '-mention-habit', group_id: $group}]->(habit)
        CREATE (space)-[:HAS_PREFERENCE_CONFLICT]->(:FuliPreferenceConflict {id: $space + '-conflict',
                personal_space_id: $space, left_item_kind: 'entity', left_item_id: $space + '-habit',
                right_item_kind: 'entity', right_item_id: $space + '-habit-alpha', preference_key: 'answers',
                preference_scope: 'project', preference_project_id: 'alpha', status: 'ai_pending',
                reason: 'Synthetic', requested_by: 'synthetic', deferred_at: datetime(), updated_at: datetime()})
    ''', space=space, group=group)


async def cleanup(driver, space, group):
    """Only this scenario's space: its knowledge, what hangs under it, and its owner."""
    await driver.execute_query('''
        MATCH (space:FuliSpace {id: $space})
        OPTIONAL MATCH (space)-[*1..3]->(below) WHERE NOT below:FuliSpace
        WITH space, collect(DISTINCT below) AS below
        OPTIONAL MATCH (owner:FuliPrincipal)-[:OWNS]->(space)
        WITH space, below, collect(owner) AS owners
        UNWIND below + owners + [space] AS node
        DETACH DELETE node
    ''', space=space)
    await driver.execute_query('''
        MATCH (node) WHERE node.group_id = $group OR node.space_id = $space OR node.personal_space_id = $space
            OR node.space = $space
        DETACH DELETE node
    ''', space=space, group=group)


def ids(envelope):
    return set(envelope['ids']['nodes'])


def agent_ids(envelope):
    """The export ID of each FLA in the envelope, by its agent ID."""
    return {node['properties']['agent_id']: node['id'] for node in envelope['nodes']
            if 'FuliProjectAgent' in node['labels']}


@pytest.mark.asyncio
async def test_scope_exports_are_complete_separate_and_deterministic():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = (await checked(await client.post('/v1/spaces', json={
            'name': f'Synthetic scope export {uuid4().hex[:8]}', 'kind': 'personal'})))['id']
        driver = client._transport.app.state.store.runtime.driver
        records, _, _ = await driver.execute_query('MATCH (s:FuliSpace {id: $id}) RETURN s.group_id AS g', id=space)
        group = records[0]['g']
        try:
            await seed_people_and_work(client, space)
            await seed_knowledge(driver, space, group)
            exports = {scope: await export(client, space, scope)
                       for scope in ('global', 'project:alpha', 'project:beta', 'project:gamma')}
            await assert_scopes(driver, space, group, exports)
            for envelope in exports.values():
                assert envelope['complete'] is True
                assert (envelope['unclassifiedLabels'], envelope['unclassifiedRelationshipTypes'],
                        envelope['unidentifiedNodes'], envelope['unidentifiedRelationships']) == ({}, [], {}, {})
                # The client session is this computer's: counted, not carried.
                assert envelope['localOnlyCount'].get('FuliTaskContextSession') == 1
            await assert_deterministic(client, driver, space, exports)
            lighter = await export(client, space, 'global', vectors=False)
            assert (lighter['vectors'], lighter['embeddingModel']) == (False, None)
            habit = next(node for node in lighter['nodes'] if node['id'] == f'Entity:{space}-habit')
            assert 'name_embedding' not in habit['properties']
            # The export's transaction is in Neo4j's read access mode: the database refuses a write in it.
            with pytest.raises(ClientError):
                async with driver.read_transaction() as transaction:
                    await (await transaction.run('CREATE (:Entity {uuid: $id})', id=f'{space}-probe')).consume()
            missing = await client.post('/v1/scopes/export', json={'personal_space_id': space,
                                                                     'scope': 'project:not-here'})
            assert missing.status_code == 404 and missing.json()['detail']['code'] == 'scope_not_found'
        finally:
            await cleanup(driver, space, group)


async def assert_scopes(driver, space, group, exports):
    global_export, alpha, beta, gamma = exports.values()
    entity = lambda name: f'Entity:{space}-{name}'  # noqa: E731
    agents = agent_ids(global_export)
    lead, writer = agents['scope-lead'], agents['scope-writer']
    # Global: habits with their history, the roster, global memory; nothing of a project.
    assert {entity('habit'), entity('habit-old'), f'FuliKnowledgeRevision:{space}-revision'} <= ids(global_export)
    assert all('global' in node['scopes'] for node in global_export['nodes'])
    assert global_export['externalRefs'] == []
    habit = next(node for node in global_export['nodes'] if node['id'] == entity('habit'))
    assert habit['properties']['name_embedding'] == [0.25, 0.5]
    assert habit['properties']['fuli_human_change_version'] == 2
    memories = [node for node in global_export['nodes'] if 'FuliProjectAgentMemory' in node['labels']]
    assert [node['properties'].get('personal_project_id') for node in memories] == [None]
    checkpoints = [node for node in global_export['nodes'] if 'FuliProjectAgentMemoryCheckpoint' in node['labels']]
    assert len(checkpoints) == 1
    # Each project: its habits (the shared and the inherited one too), knowledge, memories and tasks.
    assert {entity('habit-alpha'), entity('habit-both'), entity('habit-inherited'), entity('fact'),
            f'FuliPreferenceConflict:{space}-conflict'} <= ids(alpha)
    assert {entity('habit-beta'), entity('habit-both'), entity('fact'), entity('fact-beta')} <= ids(beta)
    assert ids(gamma) >= {entity('habit-inherited')}
    assert not ids(alpha) & {entity('habit-beta'), entity('fact-beta'), entity('habit-old')}
    assert not ids(beta) & {entity('habit-alpha'), entity('habit-inherited')}
    for envelope, project in ((alpha, 'alpha'), (beta, 'beta')):
        assert all(f'project:{project}' in node['scopes'] for node in envelope['nodes'])
        contexts = [node for node in envelope['nodes'] if 'FuliTaskContext' in node['labels']]
        assert [node['properties']['personal_project_id'] for node in contexts] == [project]
        assert not any('FuliTaskContextSession' in node['labels'] for node in envelope['nodes'])
    # Shared knowledge names every project it is in, for a later owner check.
    both = next(node for node in alpha['nodes'] if node['id'] == entity('habit-both'))
    assert both['scopes'] == ['project:alpha', 'project:beta']
    # Cross-scope relationships go to the project end and point at the global end by ID only.
    assigned = [rel for rel in alpha['relationships'] if rel['type'] == 'ASSIGNED_AGENT']
    assert [rel['end'] for rel in assigned] == [lead]
    assert {'id': lead, 'scope': 'global'} in alpha['externalRefs']
    assert {'id': entity('habit'), 'scope': 'global'} in alpha['externalRefs']
    assert not agent_ids(alpha) and not agent_ids(beta)
    staffed = [rel for rel in beta['relationships'] if rel['type'] == 'ASSIGNED_AGENT']
    assert sorted(rel['end'] for rel in staffed) == sorted([lead, writer])
    working = {(rel['start'], rel['scopes'][0]) for rel in global_export['relationships']
               if rel['type'] == 'HAS_WORKING_MEMORY'}
    assert working == {(lead, 'global')}
    # The episode is evidence for the global habit and the alpha fact: both scopes keep it.
    assert f'Episodic:{space}-episode' in ids(global_export) & ids(alpha)
    mentions = {rel['end'] for rel in global_export['relationships'] if rel['type'] == 'MENTIONS'}
    assert mentions == {entity('habit')}
    # Every exportable node of the space is in some scope.
    everywhere = ids(global_export) | ids(alpha) | ids(beta) | ids(gamma)
    records, _, _ = await driver.execute_query('''
        MATCH (node) WHERE (node.group_id = $group AND NOT node:FuliSpace)
           OR (node.personal_space_id = $space AND (node:FuliProjectAgentMemory OR node:FuliTaskContext
               OR node:FuliPreferenceConflict))
           OR (node.space_id = $space AND (node:FuliKnowledgeAssignment OR node:FuliKnowledgeProjectReference
               OR node:FuliKnowledgeRevision))
        RETURN count(node) AS count
    ''', space=space, group=group)
    counted = {node_id for node_id in everywhere if node_id.split(':')[0] in {
        'Entity', 'Episodic', 'FuliProjectAgentMemory', 'FuliTaskContext', 'FuliPreferenceConflict',
        'FuliKnowledgeAssignment', 'FuliKnowledgeProjectReference', 'FuliKnowledgeRevision'}}
    assert len(counted) == records[0]['count']


async def assert_deterministic(client, driver, space, exports):
    again = await export(client, space, 'project:alpha')
    first = exports['project:alpha']
    assert {**again, 'exportedAt': None} == {**first, 'exportedAt': None}
    await driver.execute_query("MATCH (n:Entity {uuid: $id}) SET n.summary = 'Beta now uses tabs'",
                               id=f'{space}-habit-beta')
    changed = {scope: (await export(client, space, scope))['digest'] for scope in exports}
    assert changed['project:beta'] != exports['project:beta']['digest']
    for scope in ('global', 'project:alpha', 'project:gamma'):
        assert changed[scope] == exports[scope]['digest'], scope


@pytest.mark.asyncio
async def test_scope_export_counts_what_it_cannot_carry():
    """A node without its key, two nodes under one key, labels and a
    relationship type in no rule: the envelope says so, never names a node by this computer's element ID, and is
    not complete."""
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = (await checked(await client.post('/v1/spaces', json={
            'name': f'Synthetic scope gaps {uuid4().hex[:8]}', 'kind': 'personal'})))['id']
        driver = client._transport.app.state.store.runtime.driver
        records, _, _ = await driver.execute_query('MATCH (s:FuliSpace {id: $id}) RETURN s.group_id AS g', id=space)
        group = records[0]['g']
        try:
            records, _, _ = await driver.execute_query('''
                MATCH (space:FuliSpace {id: $space})
                CREATE (space)-[:HAS_KNOWLEDGE_ASSIGNMENT]->(keyless:FuliKnowledgeAssignment {space_id: $space,
                        item_kind: 'entity', item_id: 'gone', reason: 'Synthetic early record'})
                CREATE (fact:Entity {uuid: $space + '-fact', group_id: $group, name: 'Synthetic fact'})
                CREATE (:Entity {uuid: $space + '-twice', group_id: $group, name: 'Synthetic twin one'})
                CREATE (:Entity {uuid: $space + '-twice', group_id: $group, name: 'Synthetic twin two'})
                CREATE (:ScopeTestLoose {space_id: $space, note: 'no relationship at all'})
                CREATE (:ScopeTestLinked {marker: $space})-[:SCOPE_TEST_LINK]->(fact)
                CREATE (fact)-[:SCOPE_TEST_LINK]->(:ScopeTestTarget {marker: $space})
                RETURN elementId(keyless) AS keyless
            ''', space=space, group=group)
            keyless = records[0]['keyless']
            envelope = await export(client, space, 'global')
            text = json.dumps(envelope)
            assert keyless not in text and ':element:' not in text
            # Two records under one key: neither has an identity another computer shares.
            assert envelope['unidentifiedNodes'] == {'Entity': 2, 'FuliKnowledgeAssignment': 1}
            assert f'Entity:{space}-twice' not in envelope['ids']['nodes']
            assert envelope['unidentifiedRelationships'] == {'HAS_KNOWLEDGE_ASSIGNMENT': 1}
            assert not any('FuliKnowledgeAssignment' in node['labels'] for node in envelope['nodes'])
            assert envelope['unclassifiedLabels'] == {'ScopeTestLinked': 1, 'ScopeTestLoose': 1,
                                                      'ScopeTestTarget': 1}
            assert envelope['unclassifiedRelationshipTypes'] == ['SCOPE_TEST_LINK']
            assert envelope['complete'] is False
            assert f'Entity:{space}-fact' in envelope['ids']['nodes']
            # The counts are covered by the digest.
            await driver.execute_query('MATCH (n:ScopeTestLoose {space_id: $space}) DELETE n', space=space)
            after = await export(client, space, 'global')
            assert after['unclassifiedLabels'] == {'ScopeTestLinked': 1, 'ScopeTestTarget': 1}
            assert after['digest'] != envelope['digest']
        finally:
            await driver.execute_query('MATCH (n) WHERE n.marker = $space DETACH DELETE n', space=space)
            await cleanup(driver, space, group)
