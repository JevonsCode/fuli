"""Moving a personal project in the hierarchy, against a disposable loopback graph.

Synthetic projects only. A move changes which PART_OF relation is active and
nothing else: every other relation, its review state and the usage weights
keep their values, and the inherited scope follows the new parent.
"""

from types import SimpleNamespace

import pytest
from neo4j import AsyncGraphDatabase

from fuli_graph.collaboration_context import _project_scopes
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_system_hr_identity_neo4j import _create_space, _query

REVIEW_TOKEN = 'synthetic-hierarchy-review-token-0123456'
REVIEW = {'x-fuli-human-review-token': REVIEW_TOKEN}


def settings():
    return fixture_settings().model_copy(update={'human_review_token': REVIEW_TOKEN})


async def seed(client, config, space_id):
    for project_id in ['platform', 'tools', 'app', 'docs', 'mobile']:
        response = await client.put('/v1/personal-projects', json={
            'personal_space_id': space_id, 'project_id': project_id,
            'profile': {'name': 'Synthetic ' + project_id, 'lifecycle': 'active',
                        'purpose': 'Synthetic project for hierarchy moves.'},
        })
        assert response.status_code == 200, response.text
    # app is part of platform; mobile is part of app; app also uses tools'
    # knowledge, relates to docs and has used docs' memory 7 times.
    await _query(config, '''
        MATCH (space:FuliSpace {id: $space_id})-[:CONTAINS_PROJECT]->(project:FuliPersonalProject)
        WITH space, collect(project) AS projects
        WITH space, [p IN projects WHERE p.project_id = 'app'][0] AS app,
             [p IN projects WHERE p.project_id = 'platform'][0] AS platform,
             [p IN projects WHERE p.project_id = 'tools'][0] AS tools,
             [p IN projects WHERE p.project_id = 'docs'][0] AS docs,
             [p IN projects WHERE p.project_id = 'mobile'][0] AS mobile
        CREATE (app)-[:PERSONAL_PROJECT_RELATION {id: $space_id + '-app-platform', relation_type: 'PART_OF',
                status: 'active', confirmation_authority: 'human_review', decision_revision: 1}]->(platform)
        CREATE (mobile)-[:PERSONAL_PROJECT_RELATION {id: $space_id + '-mobile-app', relation_type: 'PART_OF',
                status: 'active', confirmation_authority: 'human_review', decision_revision: 1}]->(app)
        CREATE (app)-[:PERSONAL_PROJECT_RELATION {id: $space_id + '-app-tools', relation_type: 'USES_KNOWLEDGE_FROM',
                status: 'active', confirmation_authority: 'human_review', decision_revision: 2,
                review_reason: 'Synthetic reuse.'}]->(tools)
        CREATE (app)-[:PERSONAL_PROJECT_RELATION {id: $space_id + '-app-docs', relation_type: 'RELATED_TO',
                status: 'pending', decision_revision: 0}]->(docs)
        CREATE (app)-[:PROJECT_MEMORY_ACCESS {id: $space_id + '-usage', channel: 'roundtable_answer',
                context_keys: ['synthetic'], evidence_hash: 'synthetic', task_key: 'synthetic-task',
                used_at: datetime('2026-10-01T00:00:00Z')}]->(docs)
    ''', space_id=space_id)


async def relations(config, space_id):
    rows = await _query(config, '''
        MATCH (:FuliSpace {id: $space_id})-[:CONTAINS_PROJECT]->(source:FuliPersonalProject)
              -[relation:PERSONAL_PROJECT_RELATION|PROJECT_MEMORY_ACCESS]->(target:FuliPersonalProject)
        RETURN source.project_id AS source, target.project_id AS target, type(relation) AS kind,
               properties(relation) AS properties
        ORDER BY source, target, kind, properties.relation_type
    ''', space_id=space_id)
    return [dict(row) for row in rows]


def unchanged_except_part_of(before, after):
    keep = lambda rows: [row for row in rows if row['properties'].get('relation_type') != 'PART_OF']
    return keep(before) == keep(after)


async def move(client, space_id, project_id, parent, reason='Synthetic reorganization.', headers=REVIEW):
    return await client.post(
        f'/v1/personal-spaces/{space_id}/projects/{project_id}/parent',
        json={'parent_project_id': parent, 'reason': reason}, headers=headers,
    )


async def scopes(config, space_id, project_id):
    async with AsyncGraphDatabase.driver(config.neo4j_uri, auth=('neo4j', config.neo4j_password),
                                         database=config.neo4j_database) as driver:
        store = SimpleNamespace(runtime=SimpleNamespace(driver=driver))
        found, _ = await _project_scopes(store, {'id': space_id}, project_id)
        return set(found)


@pytest.mark.asyncio
async def test_a_move_changes_only_the_parent_and_scope_follows_it():
    config = settings()
    async with provider_client(config, raise_app_exceptions=False) as (client, _):
        space_id = await _create_space(client, 'Synthetic hierarchy move')
        await seed(client, config, space_id)
        before = await relations(config, space_id)
        assert await scopes(config, space_id, 'app') == {'app', 'platform', 'tools'}

        forged = await move(client, space_id, 'app', 'docs', headers={})
        assert forged.status_code == 403, forged.text

        moved = await move(client, space_id, 'app', 'docs')
        assert moved.status_code == 200, moved.text
        assert moved.json() == {'personal_space_id': space_id, 'project_id': 'app', 'parent_project_id': 'docs',
                                'previous_parent_project_ids': ['platform'], 'changed': True}
        after = await relations(config, space_id)
        assert unchanged_except_part_of(before, after), 'other relations and usage weights keep every value'
        part_of = {(row['source'], row['target']): row['properties'] for row in after
                   if row['properties'].get('relation_type') == 'PART_OF'}
        assert part_of[('app', 'platform')]['status'] == 'rejected'
        assert part_of[('app', 'platform')]['decision_revision'] == 2
        assert part_of[('app', 'docs')]['status'] == 'active'
        assert part_of[('app', 'docs')]['confirmation_authority'] == 'human_review'
        assert part_of[('mobile', 'app')]['status'] == 'active', 'children move with their parent'
        assert await scopes(config, space_id, 'app') == {'app', 'docs', 'tools'}
        assert await scopes(config, space_id, 'mobile') == {'mobile', 'app', 'docs', 'tools'}
        reviews = await _query(config, '''
            MATCH (:FuliSpace {id: $space_id})-[:HAS_PERSONAL_PROJECT_RELATION_REVIEW]->(review)
            RETURN review.decision AS decision, review.reason AS reason ORDER BY decision
        ''', space_id=space_id)
        assert [dict(row) for row in reviews] == [
            {'decision': 'active', 'reason': 'Synthetic reorganization.'},
            {'decision': 'rejected', 'reason': 'Synthetic reorganization.'},
        ]

        again = await move(client, space_id, 'app', 'docs')
        assert again.json()['changed'] is False

        back = await move(client, space_id, 'app', 'platform', reason='Back where it was.')
        assert back.status_code == 200, back.text
        restored = await relations(config, space_id)
        part_of = {(row['source'], row['target']): row['properties'] for row in restored
                   if row['properties'].get('relation_type') == 'PART_OF'}
        assert part_of[('app', 'platform')]['status'] == 'active'
        assert part_of[('app', 'platform')]['decision_revision'] == 3, 'the same relation, one revision on'
        assert part_of[('app', 'docs')]['status'] == 'rejected'

        top = await move(client, space_id, 'app', None)
        assert top.status_code == 200, top.text
        assert await scopes(config, space_id, 'app') == {'app', 'tools'}
        assert unchanged_except_part_of(before, await relations(config, space_id))


@pytest.mark.asyncio
async def test_a_move_that_would_break_the_hierarchy_is_refused_and_changes_nothing():
    config = settings()
    async with provider_client(config, raise_app_exceptions=False) as (client, _):
        space_id = await _create_space(client, 'Synthetic hierarchy refusals')
        await seed(client, config, space_id)
        before = await relations(config, space_id)
        for project_id, parent, status, code in [
            ('platform', 'mobile', 409, 'project_hierarchy_cycle'),
            ('app', 'mobile', 409, 'project_hierarchy_cycle'),
            ('app', 'app', 422, 'project_hierarchy_self'),
            ('app', 'synthetic-missing', 404, 'parent_not_found'),
            ('synthetic-missing', 'app', 404, 'project_not_found'),
        ]:
            refused = await move(client, space_id, project_id, parent)
            assert refused.status_code == status, refused.text
            assert refused.json()['detail']['code'] == code
        assert await relations(config, space_id) == before
