"""A person's "new project" never replaces an existing project."""

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client


@pytest.mark.asyncio
async def test_create_only_refuses_an_existing_project_and_upsert_still_updates():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={'name': 'Synthetic create-only', 'kind': 'personal'})
        assert space.status_code == 200, space.text
        space_id = space.json()['id']
        body = {
            'personal_space_id': space_id, 'project_id': 'synthetic-console',
            'profile': {'name': 'Synthetic console', 'purpose': 'Original purpose.', 'lifecycle': 'active'},
            'create_only': True,
        }
        created = await client.put('/v1/personal-projects', json=body)
        assert created.status_code == 200, created.text
        assert created.json()['profile']['purpose'] == 'Original purpose.'

        again = await client.put('/v1/personal-projects', json={
            **body, 'profile': {**body['profile'], 'purpose': 'Overwritten purpose.'},
        })
        assert again.status_code == 409, again.text
        current = await client.get('/v1/personal-projects/synthetic-console', params={'personal_space_id': space_id})
        assert current.json()['profile']['purpose'] == 'Original purpose.'

        # The ordinary upsert used by existing clients keeps updating.
        updated = await client.put('/v1/personal-projects', json={
            **{key: value for key, value in body.items() if key != 'create_only'},
            'profile': {**body['profile'], 'purpose': 'Edited purpose.'},
        })
        assert updated.status_code == 200, updated.text
        assert updated.json()['profile']['purpose'] == 'Edited purpose.'

@pytest.mark.asyncio
async def test_brief_required_for_new_projects_but_legacy_edits_remain_compatible():
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        response = await client.post('/v1/spaces', json={'name': 'Synthetic brief acceptance', 'kind': 'personal'})
        space_id = response.json()['id']
        body = {'personal_space_id': space_id, 'project_id': 'synthetic-brief', 'profile': {'name': 'Sample'}}
        for create_only in [False, True]:
            rejected = await client.put('/v1/personal-projects', json={**body, 'create_only': create_only})
            assert rejected.status_code == 422, rejected.text
        missing = await client.get('/v1/personal-projects/synthetic-brief', params={'personal_space_id': space_id})
        assert missing.status_code == 404
        created = await client.put('/v1/personal-projects', json={**body, 'profile': {'name': 'Sample', 'purpose': 'Track synthetic requests.'}})
        assert created.status_code == 200, created.text
        # Seed only this synthetic project's historical pre-brief shape.
        import json
        from neo4j import AsyncGraphDatabase
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
            await driver.execute_query('''
                MATCH (:FuliSpace {id: $space_id})-[:CONTAINS_PROJECT]->
                      (project:FuliPersonalProject {project_id: 'synthetic-brief'})
                SET project.profile_json = $profile
            ''', space_id=space_id, profile=json.dumps({'name': 'Legacy'}))
        renamed = await client.put('/v1/personal-projects', json={**body, 'profile': {'name': 'Renamed', 'lifecycle': 'archived'}})
        assert renamed.status_code == 200, renamed.text
        assert renamed.json()['profile']['purpose'] is None
        assert renamed.json()['profile']['name'] == 'Renamed'
        duplicate = await client.put('/v1/personal-projects', json={**body, 'create_only': True, 'profile': {'name': 'Duplicate', 'purpose': 'Do not overwrite.'}})
        assert duplicate.status_code == 409, duplicate.text
        edited = await client.put('/v1/personal-projects', json={**body, 'profile': {'name': 'Renamed', 'purpose': 'Human-edited purpose.'}})
        assert edited.status_code == 200, edited.text
        assert edited.json()['profile']['brief_draft'] is None
