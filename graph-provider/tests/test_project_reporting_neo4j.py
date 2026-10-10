"""Project ownership must survive role lifecycle changes."""

import asyncio

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_system_hr_identity_neo4j import _create_space


@pytest.mark.asyncio
async def test_project_lead_must_handoff_before_leaving():
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await _create_space(client, 'Synthetic project handoff')
        await seed_agent(client, space_id, agent='lead')
        await seed_agent(client, space_id, agent='successor')
        scope = {'personal_space_id': space_id, 'personal_project_id': 'sample-project'}
        policy = await client.put('/v1/project-agent-coordination-policy', json={
            **scope, 'team_lead_agent_id': 'lead', 'team_member_agent_ids': ['successor'],
        })
        assert policy.status_code == 200, policy.text
        lead = (await client.get('/v1/project-agents/lead', params=scope)).json()
        [assignment] = lead['assignments']
        inactive = await client.put('/v1/project-agents', json={
            **scope, 'agent_id': 'lead', 'profile': {
                'name': 'Lead', 'responsibility': 'Synthetic lead', 'status': 'inactive',
            },
        })
        assert inactive.status_code == 409, inactive.text
        ended = await client.post('/v1/project-agent-assignments/end', json={
            **scope, 'assignment_id': assignment['assignment_id'],
            'expected_revision': assignment['revision'], 'reason': 'Synthetic departure',
        })
        assert ended.status_code == 409, ended.text
        replacement = await client.post('/v1/project-agent-assignments/replace', json={
            **scope, 'assignment_id': assignment['assignment_id'],
            'expected_revision': assignment['revision'], 'reason': 'Synthetic replacement',
            'replacement_agent_id': 'successor', 'idempotency_key': 'synthetic-replacement',
            'responsibility': 'Synthetic work',
        })
        assert replacement.status_code == 409, replacement.text
        archived = await client.delete('/v1/project-agents/lead', params={
            'personal_space_id': space_id, 'reason': 'Synthetic departure',
        })
        assert archived.status_code == 409, archived.text
        handed_off = await client.put('/v1/project-agent-coordination-policy', json={
            **scope, 'team_lead_agent_id': 'successor', 'team_member_agent_ids': [],
            'expected_updated_at': policy.json()['updated_at'],
        })
        assert handed_off.status_code == 200, handed_off.text
        archived = await client.delete('/v1/project-agents/lead', params={
            'personal_space_id': space_id, 'reason': 'Synthetic completed handoff',
        })
        assert archived.status_code == 200, archived.text


@pytest.mark.asyncio
async def test_disabling_optional_team_growth_still_requires_a_project_lead():
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await _create_space(client, 'Synthetic required lead')
        await seed_agent(client, space_id, agent='existing-specialist')
        scope = {'personal_space_id': space_id, 'personal_project_id': 'sample-project'}
        policy = await client.put('/v1/project-agent-coordination-policy', json={
            **scope, 'auto_grow_team': False,
        })
        assert policy.status_code == 200, policy.text
        response = await client.post('/v1/project-agent-context/default-lead', json={
            **scope, 'source_application': 'codex',
        })
        assert response.status_code == 200, response.text
        assert response.json()['status'] == 'ready'
        saved = await client.get('/v1/project-agent-coordination-policy', params=scope)
        assert saved.json()['team_lead_agent_id'] == response.json()['agent']['agent_id']
        await seed_agent(client, space_id, agent='another-specialist')
        resolved = await client.post('/v1/project-agent-context/resolve', json={
            **scope, 'source_application': 'codex', 'agent_id': 'another-specialist',
        })
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()['agent']['agent_id'] == saved.json()['team_lead_agent_id']
        assert resolved.json()['requested_agent_id'] == 'another-specialist'


@pytest.mark.asyncio
async def test_concurrent_archive_cannot_install_an_unavailable_project_lead(monkeypatch):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver
    reached, proceed = asyncio.Event(), asyncio.Event()
    execute = Neo4jDriver.execute_query
    async def pause_policy(driver, query, **kwargs):
        if kwargs.get('team_agent_ids') == ['successor']:
            reached.set()
            await proceed.wait()
        return await execute(driver, query, **kwargs)
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await _create_space(client, 'Synthetic concurrent handoff')
        for agent in ['lead', 'successor']:
            await seed_agent(client, space_id, agent=agent)
        scope = {'personal_space_id': space_id, 'personal_project_id': 'sample-project'}
        original = await client.put('/v1/project-agent-coordination-policy', json={
            **scope, 'team_lead_agent_id': 'lead',
        })
        assert original.status_code == 200, original.text
        with monkeypatch.context() as patch:
            patch.setattr(Neo4jDriver, 'execute_query', pause_policy)
            saving = asyncio.create_task(client.put('/v1/project-agent-coordination-policy', json={
                **scope, 'team_lead_agent_id': 'successor',
                'expected_updated_at': original.json()['updated_at'],
            }))
            try:
                await asyncio.wait_for(reached.wait(), timeout=5)
                archived = await client.delete('/v1/project-agents/successor', params={
                    'personal_space_id': space_id, 'reason': 'Synthetic concurrent departure',
                })
                assert archived.status_code == 200, archived.text
            finally:
                proceed.set()
            result = await saving
            assert result.status_code == 409, result.text
        saved = await client.get('/v1/project-agent-coordination-policy', params=scope)
        assert saved.json()['team_lead_agent_id'] == 'lead'
