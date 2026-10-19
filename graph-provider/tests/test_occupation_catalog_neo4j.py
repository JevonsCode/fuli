"""R-05 against a disposable local graph, never the installed daily graph."""

import asyncio
import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


async def create_space(client):
    response = await client.post('/v1/spaces', json={'name': 'Synthetic occupation catalog', 'kind': 'personal'})
    assert response.status_code == 200, response.text
    return response.json()['id']


@pytest.mark.asyncio
async def test_catalog_crud_cas_scope_and_assignment_lifecycle():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await create_space(client)
        other = await create_space(client)
        listing = await client.get('/v1/occupations', params={'personal_space_id': space})
        assert listing.status_code == 200, listing.text
        entries = listing.json()
        assert len(entries) == 25
        assert {'lead', 'assistant', 'product', 'engineering', 'design', 'operations', 'testing',
                'research', 'data', 'writing', 'management'} <= {entry['key'] for entry in entries}
        assert all(entry['builtin'] and entry['name_zh'] and entry['name_en']
                   and entry['description_zh'] and entry['description_en'] for entry in entries)
        assert all(entry['agent_count'] == 0 for entry in entries)
        invalid = await client.post('/v1/occupations', json={'personal_space_id': space,
            'name_zh': 'Sample', 'description_zh': '   '})
        assert invalid.status_code == 422
        created = await client.post('/v1/occupations', json={'personal_space_id': space,
            'name_zh': '接口维护员', 'description_zh': '维护服务接口并验证兼容性。'})
        assert created.status_code == 200, created.text
        item = created.json()
        assert item['key'].startswith('custom_') and item['builtin'] is False
        assert item['revision'] == 0 and item['created_at'] == item['updated_at']
        key = item['key']
        edit = {'personal_space_id': space, 'revision': 0, 'name_en': 'API maintainer'}
        changed = await client.put(f'/v1/occupations/{key}', json=edit)
        assert changed.status_code == 200, changed.text
        assert changed.json()['revision'] == 1
        stale = await client.put(f'/v1/occupations/{key}', json=edit)
        assert stale.status_code == 409
        foreign = await client.put(f'/v1/occupations/{key}', json={**edit, 'personal_space_id': other})
        assert foreign.status_code == 404
        await seed_agent(client, space)
        assigned = await client.put('/v1/project-agents/engineer/occupation', json={
            'personal_space_id': space, 'role': key, 'tags': ['backend']})
        assert assigned.status_code == 200, assigned.text
        counts = (await client.get('/v1/occupations', params={'personal_space_id': space})).json()
        assert next(v for v in counts if v['key'] == key)['agent_count'] == 1
        assert next(v for v in counts if v['key'] == 'backend')['agent_count'] == 1
        blocked = await client.request('DELETE', f'/v1/occupations/{key}', json={'personal_space_id': space, 'revision': 1})
        assert blocked.status_code == 409
        assert blocked.json()['detail']['code'] == 'occupation_in_use'
        archived = await client.post(f'/v1/occupations/{key}/archive', json={'personal_space_id': space, 'revision': 1})
        assert archived.status_code == 200, archived.text
        assert archived.json()['status'] == 'archived' and archived.json()['revision'] == 2
        retained = await client.get('/v1/project-agents/engineer', params={'personal_space_id': space})
        assert retained.json()['occupation']['role'] == key
        rejected = await client.put('/v1/project-agents/engineer/occupation', json={'personal_space_id': space, 'role': key})
        assert rejected.status_code == 422
        wrong_space = await client.put('/v1/project-agents/engineer/occupation', json={'personal_space_id': other, 'role': key})
        assert wrong_space.status_code in {404, 422}
        reassigned = await client.put('/v1/project-agents/engineer/occupation', json={'personal_space_id': space, 'role': 'engineering'})
        assert reassigned.status_code == 200, reassigned.text
        deleted = await client.request('DELETE', f'/v1/occupations/{key}', json={'personal_space_id': space, 'revision': 2})
        assert deleted.status_code == 200, deleted.text
        assert key not in {v['key'] for v in (await client.get('/v1/occupations', params={'personal_space_id': space})).json()}
        builtin = await client.request('DELETE', '/v1/occupations/engineering', json={'personal_space_id': space, 'revision': 0})
        assert builtin.status_code == 409 and builtin.json()['detail']['code'] == 'occupation_builtin'


@pytest.mark.asyncio
async def test_builtin_locks_and_active_tags():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await create_space(client)
        await seed_agent(client, space)
        ensured = await client.post('/v1/project-agents/system-hr', params={'personal_space_id': space})
        assert ensured.status_code == 200, ensured.text
        agents = await client.get('/v1/project-agents', params={'personal_space_id': space})
        assert agents.status_code == 200, agents.text
        fixed = [item for item in agents.json() if item['agent_id'] in {
            'employee.bole', 'employee.jefa', 'employee.tonborg', 'employee.assistant'}]
        assert len(fixed) == 4
        for agent in fixed:
            assert agent['occupation_locked'] is True
            changed = await client.put(f"/v1/project-agents/{agent['agent_id']}/occupation", json={
                'personal_space_id': space, 'role': 'engineering'})
            assert changed.status_code == 409, changed.text
            assert changed.json()['detail']['code'] == 'occupation_locked'
        archive = await client.post('/v1/occupations/frontend/archive', json={'personal_space_id': space, 'revision': 0})
        assert archive.status_code == 200, archive.text
        rejected = await client.put('/v1/project-agents/engineer/occupation', json={
            'personal_space_id': space, 'role': 'engineering', 'tags': ['frontend']})
        assert rejected.status_code == 422
        restore = await client.put('/v1/occupations/frontend', json={'personal_space_id': space, 'revision': 1, 'status': 'active'})
        assert restore.status_code == 200, restore.text
        allowed = await client.put('/v1/project-agents/engineer/occupation', json={
            'personal_space_id': space, 'role': 'frontend'})
        assert allowed.status_code == 200, allowed.text


@pytest.mark.asyncio
async def test_direct_identity_write_rejects_unknown_archived_and_locked_occupations():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await create_space(client)
        await seed_agent(client, space)
        ensured = await client.post('/v1/project-agents/system-hr', params={'personal_space_id': space})
        assert ensured.status_code == 200, ensured.text
        payload = {'personal_space_id': space, 'agent_id': 'invalid-role',
                   'profile': {'name': 'Synthetic', 'responsibility': 'Verify occupation writes.'},
                   'occupation': {'role': 'not_in_catalog'}}
        unknown = await client.put('/v1/project-agents', json=payload)
        assert unknown.status_code == 422, unknown.text
        hidden = await client.post('/v1/occupations/backend/archive', json={'personal_space_id': space, 'revision': 0})
        assert hidden.status_code == 200, hidden.text
        inactive = await client.put('/v1/project-agents', json={**payload, 'occupation': {'role': 'backend'}})
        assert inactive.status_code == 422, inactive.text
        bole = ensured.json()
        bypass = await client.put('/v1/project-agents', json={'personal_space_id': space,
            'agent_id': 'employee.bole', 'profile': bole['profile'], 'occupation': {'role': 'engineering'}})
        assert bypass.status_code == 409, bypass.text
        assert bypass.json()['detail']['code'] == 'occupation_locked'


@pytest.mark.asyncio
async def test_only_one_concurrent_catalog_edit_wins():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await create_space(client)
        payload = {'personal_space_id': space, 'revision': 0}
        responses = await asyncio.gather(*[
            client.put('/v1/occupations/backend', json={**payload, 'name_en': f'Backend {index}'})
            for index in range(5)])
        assert sorted(value.status_code for value in responses) == [200, 409, 409, 409, 409]


@pytest.mark.asyncio
async def test_assignment_and_delete_cannot_leave_an_orphan_occupation():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await create_space(client)
        await seed_agent(client, space)
        created = await client.post('/v1/occupations', json={'personal_space_id': space,
            'name_en': 'Maintainer', 'description_en': 'Maintain the sample service and its interfaces.'})
        assert created.status_code == 200, created.text
        key = created.json()['key']
        assigned, deleted = await asyncio.gather(
            client.put('/v1/project-agents/engineer/occupation', json={'personal_space_id': space, 'role': key}),
            client.request('DELETE', f'/v1/occupations/{key}', json={'personal_space_id': space, 'revision': 0}))
        assert (assigned.status_code, deleted.status_code) in {(200, 409), (422, 200)}, (assigned.text, deleted.text)
        agent = (await client.get('/v1/project-agents/engineer', params={'personal_space_id': space})).json()
        keys = {entry['key'] for entry in (await client.get('/v1/occupations', params={'personal_space_id': space})).json()}
        assert agent['occupation']['role'] in keys


@pytest.mark.asyncio
async def test_deletion_retains_occupations_referenced_by_archived_agents():
    from neo4j import AsyncGraphDatabase
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        space = await create_space(client)
        await seed_agent(client, space)
        created = await client.post('/v1/occupations', json={'personal_space_id': space,
            'name_en': 'Historical maintainer', 'description_en': 'Maintain the synthetic service and preserve its history.'})
        key = created.json()['key']
        assigned = await client.put('/v1/project-agents/engineer/occupation', json={
            'personal_space_id': space, 'role': key})
        assert assigned.status_code == 200, assigned.text
        # Simulate only this newly created fixture's historical archived identity.
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
            await driver.execute_query('''MATCH (:FuliSpace {id: $space})-[:HAS_PROJECT_AGENT_IDENTITY]->
                (agent:FuliProjectAgent {agent_id: 'engineer'}) SET agent.status = 'archived' ''', space=space)
        entries = (await client.get('/v1/occupations', params={'personal_space_id': space})).json()
        assert next(entry for entry in entries if entry['key'] == key)['agent_count'] == 0
        deleted = await client.request('DELETE', f'/v1/occupations/{key}', json={
            'personal_space_id': space, 'revision': 0})
        assert deleted.status_code == 409, deleted.text
        assert deleted.json()['detail']['code'] == 'occupation_in_use'


@pytest.mark.asyncio
async def test_catalog_does_not_backfill_an_old_agent_and_new_default_lead_is_explicit():
    from neo4j import AsyncGraphDatabase
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        space = await create_space(client)
        await seed_agent(client, space)
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
            await driver.execute_query('''MATCH (:FuliSpace {id: $space})-[:HAS_PROJECT_AGENT_IDENTITY]->
                (agent:FuliProjectAgent {agent_id: 'engineer'})
                REMOVE agent.occupation_role, agent.occupation_tags, agent.occupation_updated_at''', space=space)
            before, _, _ = await driver.execute_query('''MATCH (:FuliSpace {id: $space})-[:HAS_PROJECT_AGENT_IDENTITY]->
                (agent:FuliProjectAgent {agent_id: 'engineer'}) RETURN properties(agent) AS value''', space=space)
            assert (await client.get('/v1/occupations', params={'personal_space_id': space})).status_code == 200
            after, _, _ = await driver.execute_query('''MATCH (:FuliSpace {id: $space})-[:HAS_PROJECT_AGENT_IDENTITY]->
                (agent:FuliProjectAgent {agent_id: 'engineer'}) RETURN properties(agent) AS value''', space=space)
            assert before[0]['value'] == after[0]['value']
        legacy = await client.get('/v1/project-agents/engineer', params={'personal_space_id': space})
        assert legacy.json()['occupation'] is None
        ensured = await client.post('/v1/project-agents/system-hr', params={'personal_space_id': space})
        assert ensured.status_code == 200, ensured.text
        hired = await client.post('/v1/project-agent-context/default-lead', json={
            'personal_space_id': space, 'personal_project_id': 'sample-project'})
        assert hired.status_code == 200, hired.text
        assert hired.json()['agent']['occupation']['role'] == 'lead'
        assert hired.json()['agent']['agent_id'] != 'engineer'
