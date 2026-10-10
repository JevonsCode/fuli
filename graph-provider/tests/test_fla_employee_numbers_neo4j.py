"""Identity numbering acceptance against an explicitly disposable graph."""

import asyncio
import json

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_system_hr_identity_neo4j import _create_space, _query


async def put_agent(client, space_id, agent_id, **changes):
    response = await client.put('/v1/project-agents', json={
        'personal_space_id': space_id, 'agent_id': agent_id,
        'profile': {'name': 'Synthetic member', 'responsibility': 'Verify numbering'},
        **changes,
    })
    assert response.status_code == 200, response.text
    return response.json()


async def ensure_system(client, space_id):
    response = await client.post('/v1/project-agents/system-hr', params={'personal_space_id': space_id})
    assert response.status_code == 200, response.text


@pytest.mark.asyncio
async def test_numbers_start_at_one_and_concurrent_creates_and_replays_are_unique():
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await _create_space(client, 'Synthetic concurrent FLA numbering')
        await ensure_system(client, space_id)
        initial = (await client.get('/v1/project-agents', params={'personal_space_id': space_id})).json()
        assert sorted(a['employee_number'] for a in initial) == ['000001', '000002']
        results = await asyncio.gather(*[
            put_agent(client, space_id, f'member-{i}') for i in list(range(8)) * 2
        ])
        numbers = {}
        for agent in results:
            key, number = agent['agent_id'], agent['employee_number']
            assert numbers.setdefault(key, number) == number
        assert len(set(numbers.values())) == 8
        assert sorted(numbers.values()) == [f'{i:06d}' for i in range(3, 11)]
        other = await _create_space(client, 'Synthetic independent FLA numbering')
        await ensure_system(client, other)
        other_agents = (await client.get('/v1/project-agents', params={'personal_space_id': other})).json()
        assert sorted(a['employee_number'] for a in other_agents) == ['000001', '000002']
        rejected = await client.put('/v1/project-agents', json={
            'personal_space_id': space_id, 'agent_id': 'member-0', 'employee_number': '999999',
            'profile': {'name': 'Synthetic member', 'responsibility': 'Cannot assign a number'},
        })
        assert rejected.status_code == 422


@pytest.mark.asyncio
async def test_legacy_identities_backfill_in_creation_order_once_including_archives():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await _create_space(client, 'Synthetic legacy FLA numbering')
        profile = json.dumps({'name': 'Legacy member', 'responsibility': 'Synthetic history'})
        await _query(settings, '''
            MATCH (space:FuliSpace {id: $space_id})
            UNWIND [{id: 'older', date: '2020-01-01T00:00:00Z', status: 'archived'},
                    {id: 'newer', date: '2021-01-01T00:00:00Z', status: 'active'}] AS item
            CREATE (agent:FuliProjectAgent {id: $space_id + item.id, agent_id: item.id,
              status: item.status, profile_json: $profile, created_at: datetime(item.date),
              updated_at: datetime(item.date)})
            CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
            ''', space_id=space_id, profile=profile)
        await ensure_system(client, space_id)
        async def snapshot():
            response = await client.get('/v1/project-agents', params={'personal_space_id': space_id})
            assert response.status_code == 200, response.text
            return {a['agent_id']: a['employee_number'] for a in response.json()}
        first = await snapshot()
        assert first['older'] == '000001'
        assert first['newer'] == '000002'
        await ensure_system(client, space_id)
        assert await snapshot() == first


@pytest.mark.asyncio
async def test_number_survives_project_move_archive_and_six_digit_rollover():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await _create_space(client, 'Synthetic FLA rollover')
        await ensure_system(client, space_id)
        await _query(settings, 'MATCH (s:FuliSpace {id: $id}) SET s.fla_employee_sequence = 999998', id=space_id)
        first = await put_agent(client, space_id, 'last-six')
        assert first['employee_number'] == '999999'
        for project in ['first', 'second']:
            response = await client.put('/v1/personal-projects', json={
                'personal_space_id': space_id, 'project_id': project,
                'profile': {'name': project, 'lifecycle': 'active'},
            })
            assert response.status_code == 200, response.text
            updated = await put_agent(client, space_id, 'last-six', personal_project_id=project)
            assert updated['employee_number'] == '999999'
        archived = await client.delete('/v1/project-agents/last-six', params={
            'personal_space_id': space_id, 'reason': 'Synthetic archive',
        })
        assert archived.status_code == 200, archived.text
        assert archived.json()['employee_number'] == '999999'
        second = await put_agent(client, space_id, 'first-seven')
        assert second['employee_number'] == '1000000'
        await ensure_system(client, space_id)
        third = await put_agent(client, space_id, 'next-seven')
        assert third['employee_number'] == '1000001'
