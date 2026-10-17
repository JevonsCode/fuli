"""Occupation is an explicit human edit, kept apart from the profile and tasks."""

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


def engineer(roster):
    [value] = [item for item in roster if item['agent_id'] == 'engineer']
    return value


@pytest.mark.asyncio
async def test_occupation_is_set_explicitly_and_survives_profile_upserts():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic occupation acceptance', 'kind': 'personal',
        })
        assert space.status_code == 200, space.text
        space_id = space.json()['id']
        await seed_agent(client, space_id)
        listed = await client.get('/v1/project-agents', params={'personal_space_id': space_id})
        assert engineer(listed.json())['occupation']['role'] == 'engineering'

        updated = await client.put('/v1/project-agents/engineer/occupation', json={
            'personal_space_id': space_id, 'role': 'engineering', 'tags': ['testing', 'design'],
        })
        assert updated.status_code == 200, updated.text
        occupation = updated.json()['occupation']
        assert occupation['role'] == 'engineering'
        assert occupation['tags'] == ['testing', 'design']
        assert occupation['updated_at']

        # A profile write from any client keeps the separately stored occupation.
        await seed_agent(client, space_id)
        listed = await client.get('/v1/project-agents', params={'personal_space_id': space_id})
        assert engineer(listed.json())['occupation']['role'] == 'engineering'

        invalid = await client.put('/v1/project-agents/engineer/occupation', json={
            'personal_space_id': space_id, 'role': 'wizard', 'tags': [],
        })
        assert invalid.status_code == 422
        duplicate = await client.put('/v1/project-agents/engineer/occupation', json={
            'personal_space_id': space_id, 'role': None, 'tags': ['design', 'design'],
        })
        assert duplicate.status_code == 422

        cleared = await client.put('/v1/project-agents/engineer/occupation', json={
            'personal_space_id': space_id, 'role': None, 'tags': [],
        })
        assert cleared.status_code == 422, cleared.text

        missing = await client.put('/v1/project-agents/nobody/occupation', json={
            'personal_space_id': space_id, 'role': 'design', 'tags': [],
        })
        assert missing.status_code == 404
