"""Opt-in disposable graph acceptance; never targets a daily service."""
from neo4j import GraphDatabase
import pytest

from fuli_graph.migrate_lead_occupation import migrate
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_system_hr_identity_neo4j import _create_space, _query


@pytest.mark.asyncio
async def test_three_leads_migrate_and_rollback_without_changing_memory_or_identity():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await _create_space(client, 'Synthetic lead migration')
        projects = [f'synthetic-{i}' for i in range(3)]
        for i, project in enumerate(projects):
            await seed_agent(client, space, project=project, agent=f'lead-{i}')
            await _query(settings, '''
                MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->(project:FuliPersonalProject {project_id: $project})
                CREATE (project)-[:HAS_PROJECT_AGENT_COORDINATION_POLICY]->(:FuliProjectAgentCoordinationPolicy {team_lead_agent_id: $agent})
                WITH project
                MATCH (:FuliSpace {id: $space})-[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent {agent_id: $agent})
                SET agent.occupation_role = 'engineering', agent.occupation_tags = ['testing'],
                    agent.occupation_updated_at = datetime('2026-01-01T00:00:00Z')
                CREATE (agent)-[:HAS_AGENT_MEMORY]->(:SyntheticMemory {value: 'preserve'})
                ''', space=space, project=project, agent=f'lead-{i}')
        snapshot_query = '''
            MATCH (:FuliSpace {id: $space})-[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent)-
                  [:HAS_AGENT_MEMORY]->(memory:SyntheticMemory)
            RETURN agent.id AS id, agent.profile_json AS profile, memory.value AS memory,
                   agent.occupation_role AS role, agent.occupation_updated_at AS updated_at
            ORDER BY id
        '''
        before = await _query(settings, snapshot_query, space=space)
        with GraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
            with driver.session() as session:
                preview = session.execute_read(migrate, space, projects)
                assert len(preview['changes']) == 3
                applied = session.execute_write(migrate, space, projects, expected_digest=preview['digest'])
                assert session.execute_read(migrate, space, projects)['changes'] == []
                session.execute_write(migrate, space, projects, rollback_id=applied['migration_id'])
        assert await _query(settings, snapshot_query, space=space) == before


@pytest.mark.asyncio
async def test_builtin_occupation_backfill_preserves_human_role_and_assistant_is_global():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space = await _create_space(client, 'Synthetic builtin occupation')
        params = {'personal_space_id': space}
        await client.post('/v1/project-agents/system-hr', params=params)
        assistant = await client.get('/v1/project-agents/employee.assistant', params=params)
        assert assistant.status_code == 200, assistant.text
        assert assistant.json()['personal_project_id'] is None
        assert assistant.json()['assignments'] == []
        assert assistant.json()['memory_scope'] == 'task_only'
        assert assistant.json()['occupation']['role'] == 'assistant'
        # The four built-in roles keep their occupation; a person cannot reassign it.
        changed = await client.put('/v1/project-agents/employee.bole/occupation', json={**params, 'role': 'research'})
        assert changed.status_code == 409, changed.text
        assert changed.json()['detail']['code'] == 'occupation_locked'
        await client.post('/v1/project-agents/system-hr', params=params)
        bole = await client.get('/v1/project-agents/employee.bole', params=params)
        assert bole.json()['occupation']['role'] == 'management'
