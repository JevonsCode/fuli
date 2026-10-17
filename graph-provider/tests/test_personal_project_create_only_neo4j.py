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
