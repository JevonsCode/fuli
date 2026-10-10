"""Fixed Jefa (project manager) and Bole (AR) roles against a disposable Neo4j."""

import json
from uuid import uuid4

import pytest

from fuli_graph.provider_values import stable_uuid
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_system_hr_identity_neo4j import _create_space, _query


@pytest.mark.asyncio
@pytest.mark.parametrize('responsibility, expected', [
    ('HR：维护 Agent 人员分布与工作状态，按需招募并保留招募记录。',
     'AR：维护 Agent 人员分布与工作状态，按需招募并保留招募记录。'),
    ('HR：这是用户自定义的职责。', 'HR：这是用户自定义的职责。'),
])
async def test_bole_role_copy_upgrade_preserves_custom_profile_and_employee_number(responsibility, expected):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await _create_space(client, 'Synthetic Bole role upgrade')
        params = {'personal_space_id': space_id}
        original = await client.post('/v1/project-agents/system-hr', params=params)
        assert original.status_code == 200, original.text
        profile = {**original.json()['profile'], 'responsibility': responsibility,
                   'expectations': 'Keep this custom expectation.'}
        await _query(settings, '''
            MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: 'employee.bole'})
            SET agent.profile_json = $profile_json, agent.responsibility = $responsibility
            ''', space_id=space_id, profile_json=json.dumps(profile), responsibility=responsibility)
        for _ in range(2):
            upgraded = await client.post('/v1/project-agents/system-hr', params=params)
            assert upgraded.status_code == 200, upgraded.text
            assert upgraded.json()['profile']['responsibility'] == expected
            assert upgraded.json()['profile']['expectations'] == profile['expectations']
            assert upgraded.json()['profile']['agent_type'] == 'hr'
            assert upgraded.json()['employee_number'] == original.json()['employee_number']
        rows = await _query(settings, '''
            MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: 'employee.bole'})
            RETURN agent.responsibility AS responsibility
            ''', space_id=space_id)
        assert rows[0]['responsibility'] == expected


@pytest.mark.asyncio
async def test_every_space_has_fixed_project_manager_and_hr():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await _create_space(client, 'Synthetic fixed roles')
        response = await client.post('/v1/project-agents/system-hr', params={
            'personal_space_id': space_id,
        })
        assert response.status_code == 200, response.text

        listed = await client.get('/v1/project-agents', params={'personal_space_id': space_id})
        assert listed.status_code == 200, listed.text
        roles = {agent['agent_id']: agent['profile']['agent_type'] for agent in listed.json()}
        assert roles['employee.jefa'] == 'coordinator'
        assert roles['employee.bole'] == 'hr'
        assert roles['employee.tonborg'] == 'durable'

        archived = await client.request('DELETE', '/v1/project-agents/employee.jefa', params={
            'personal_space_id': space_id, 'reason': 'try to remove the PM',
        })
        assert archived.status_code == 422


@pytest.mark.asyncio
async def test_recruited_jefa_is_adopted_and_legacy_coordinator_retired():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await _create_space(client, 'Synthetic adopted project manager')
        legacy_id = f'synthetic-legacy-coordinator-{uuid4().hex}'
        jefa_node = stable_uuid(settings.provider_id, space_id, 'project-agent', 'employee.jefa')
        recruited = {
            'name': 'Jefa', 'responsibility': '项目经理：用户自定义职责。',
            'expectations': '每天汇总一次进展。', 'agent_type': 'durable',
            'capabilities': ['项目规划', 'fuli.employee:jefa'], 'status': 'inactive',
        }
        await _query(settings, '''
            MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
            CREATE (jefa:FuliProjectAgent {id: $jefa_node, agent_id: 'employee.jefa',
              name: 'Jefa', profile_json: $profile_json, agent_type: 'durable', status: 'inactive',
              memory_scope: 'reviewed_agent', created_at: datetime(), updated_at: datetime()})
            CREATE (legacy:FuliProjectAgent {id: $legacy_id, agent_id: 'fuli-project-coordinator',
              name: '项目协调人', profile_json: '{}', agent_type: 'coordinator', status: 'active',
              created_at: datetime(), updated_at: datetime()})
            CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(jefa)
            CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(legacy)
            ''', space_id=space_id, jefa_node=jefa_node, legacy_id=legacy_id,
            profile_json=json.dumps(recruited, ensure_ascii=False))

        response = await client.post('/v1/project-agents/system-coordinator', params={
            'personal_space_id': space_id,
        })
        assert response.status_code == 200, response.text
        jefa = response.json()
        assert jefa['agent_id'] == 'employee.jefa'
        assert jefa['profile']['agent_type'] == 'coordinator'
        assert jefa['profile']['status'] == 'active'
        assert jefa['profile']['expectations'] == '每天汇总一次进展。'

        rows = await _query(settings, '''
            MATCH (agent:FuliProjectAgent {id: $legacy_id})
            RETURN agent.status AS status, agent.superseded_by AS superseded_by
            ''', legacy_id=legacy_id)
        assert rows[0]['status'] == 'archived'
        assert rows[0]['superseded_by'] == 'employee.jefa'
        listed = await client.get('/v1/project-agents', params={'personal_space_id': space_id})
        assert 'fuli-project-coordinator' not in {agent['agent_id'] for agent in listed.json()}
        count = await _query(settings, '''
            MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: 'employee.jefa'})
            RETURN count(agent) AS count
            ''', space_id=space_id)
        assert count[0]['count'] == 1


@pytest.mark.asyncio
async def test_first_task_in_a_project_has_bole_hire_its_lead():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await _create_space(client, 'Synthetic default lead')
        assert (await client.post('/v1/project-agents/system-hr', params={
            'personal_space_id': space_id,
        })).status_code == 200
        project = await client.put('/v1/personal-projects', json={
            'personal_space_id': space_id, 'project_id': 'sample-app',
            'profile': {'name': 'Sample App', 'lifecycle': 'active'},
        })
        assert project.status_code == 200, project.text
        body = {'personal_space_id': space_id, 'personal_project_id': 'sample-app',
                'source_application': 'claude_code'}

        staffed = await client.post('/v1/project-agent-context/default-lead', json=body)
        assert staffed.status_code == 200, staffed.text
        result = staffed.json()
        assert result['status'] == 'ready'
        lead = result['agent']
        assert lead['profile']['agent_type'] == 'durable'
        assert lead['profile']['name'] == 'Sample App 负责人'

        policy = await client.get('/v1/project-agent-coordination-policy', params={
            'personal_space_id': space_id, 'personal_project_id': 'sample-app',
        })
        assert policy.json()['team_lead_agent_id'] == lead['agent_id']
        recruitments = await client.get('/v1/project-agent-recruitments', params={
            'personal_space_id': space_id, 'personal_project_id': 'sample-app',
        })
        [recruitment] = recruitments.json()
        assert recruitment['hr_agent_id'] == 'employee.bole'
        assert recruitment['status'] == 'fulfilled'
        assert recruitment['recruited_agent_id'] == lead['agent_id']
        tasks = await client.get('/v1/project-agent-tasks', params={
            'personal_space_id': space_id, 'personal_project_id': 'sample-app',
        })
        assert [task['status'] for task in tasks.json()] == ['completed']

        resolved = await client.post('/v1/project-agent-context/resolve', json=body)
        assert resolved.json()['agent']['agent_id'] == lead['agent_id']
        again = await client.post('/v1/project-agent-context/default-lead', json=body)
        assert again.json()['status'] == 'unassigned'
        agents = await client.get('/v1/project-agents', params={
            'personal_space_id': space_id, 'personal_project_id': 'sample-app',
        })
        assert sum(agent['profile']['agent_type'] == 'durable' for agent in agents.json()) == 1
