"""The owner of `global` makes the FLA a follower's project recruited
(owner_hire.py), on a disposable Neo4j through the full Provider app.

Made once and never changed: the same recruitment is answered with the same
FLA; another recruitment, a hand-made FLA or a fixed role under that agent_id,
a name another FLA is called by and an occupation the catalog does not have are
refused with their codes, nothing written; a follower's graph refuses it whole.
Synthetic data only.

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1.
"""
import pytest

from fuli_graph.provider_values import graphiti_group_id
from fuli_graph.system_agents import SYSTEM_COORDINATOR_AGENT_ID
from test_follower_space_neo4j import (  # noqa: F401
    alone, follower_settings, host_global, no_personal_space, strict, take_space,
)
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_scope_export_neo4j import checked, cleanup
from test_scope_import_neo4j import import_envelope, node, scenario

PROPOSED = 'synthetic-proposed-lead'
FOLLOWER = 'c' * 64


def hire(space, **changes):
    return {'personal_space_id': space, 'recruitment_id': 'synthetic-recruitment', 'agent_id': PROPOSED,
            'profile': {'name': 'Synthetic local 负责人', 'responsibility': 'Lead the synthetic project.',
                        'allowed_clients': ['codex'], 'work_kinds': ['planning'], 'capabilities': ['delegation']},
            'occupation': {'role': 'engineering', 'tags': []}, 'reason': 'Every task needs a FULI Agent.',
            'origin_computer': 'Synthetic laptop', 'origin_project': 'Synthetic local',
            'origin_fingerprint': FOLLOWER, **changes}


async def refused(client, body, status, code):
    response = await client.post('/v1/project-agents/owner-hire', json=body)
    assert response.status_code == status, response.text
    if code:
        assert response.json()['detail']['code'] == code, response.text


@pytest.mark.asyncio
async def test_the_owner_makes_the_fla_once_with_where_its_recruitment_came_from(alone, strict):  # noqa: F811
    async with provider_client(fixture_settings()) as (client, _):
        await no_personal_space(client)
        driver, space, group = await scenario(client)
        try:
            made = await checked(await client.post('/v1/project-agents/owner-hire', json=hire(space)))
            assert made['outcome'] == 'created'
            agent = made['agent']
            assert agent['agent_id'] == PROPOSED and agent['profile']['status'] == 'active'
            records, _, _ = await driver.execute_query(
                'MATCH (a:FuliProjectAgent {agent_id: $id}) RETURN properties(a) AS p', id=PROPOSED)
            stored = records[0]['p']
            assert stored['system_managed'] is False
            assert (stored['recruitment_id'], stored['occupation_recruitment_id']) == ('synthetic-recruitment',) * 2
            assert stored['occupation_role'] == 'engineering' and stored['recruited_at'] is not None
            assert stored['recruitment_reason'].startswith(
                f'来自 Synthetic laptop（{FOLLOWER}）的项目 Synthetic local 的招聘')
            assert stored['employee_number'] is not None
            listed = await checked(await client.get('/v1/project-agents', params={'personal_space_id': space}))
            assert PROPOSED in {item['agent_id'] for item in listed}
            # The same recruitment again: the same FLA, unchanged.
            again = await checked(await client.post('/v1/project-agents/owner-hire', json=hire(
                space, profile={**hire(space)['profile'], 'name': 'Something else'})))
            assert again['outcome'] == 'existing' and again['agent'] == agent
            assert (await node(driver, f"FuliProjectAgent:{stored['id']}")) == stored
            # Every refusal names its code (a 404 without one is a Provider without this route).
            await refused(client, hire('synthetic-no-such-space'), 403, 'space_access_denied')
            # Never changes or takes over another FLA.
            await refused(client, hire(space, recruitment_id='another-recruitment'), 409, 'agent_id_taken')
            await refused(client, hire(space, agent_id='scope-writer'), 409, 'agent_id_taken')
            await refused(client, hire(space, agent_id=SYSTEM_COORDINATOR_AGENT_ID, recruitment_id='r2'), 409,
                          'agent_id_reserved')
            await refused(client, hire(space, agent_id='synthetic-coordinator', recruitment_id='r3', profile={
                **hire(space)['profile'], 'agent_type': 'coordinator'}), 422, None)
            assert (await node(driver, f"FuliProjectAgent:{stored['id']}")) == stored
            # A name another FLA is called by, an occupation the catalog does not have: nothing made.
            writer = await checked(await client.get('/v1/project-agents/scope-writer',
                                                    params={'personal_space_id': space}))
            await refused(client, hire(space, agent_id='synthetic-namesake', recruitment_id='r4', profile={
                **hire(space)['profile'], 'display_name': writer['profile']['display_name']}), 409,
                'agent_name_taken')
            await refused(client, hire(space, agent_id='synthetic-unknown', recruitment_id='r5',
                                       occupation={'role': 'custom_missing', 'tags': []}), 422, None)
            for agent_id in ('synthetic-namesake', 'synthetic-unknown', 'synthetic-coordinator'):
                response = await client.get(f'/v1/project-agents/{agent_id}', params={'personal_space_id': space})
                assert response.status_code == 404, agent_id
        finally:
            await cleanup(driver, space, group)


@pytest.mark.asyncio
async def test_a_follower_never_makes_an_fla_for_its_owner(alone, strict):  # noqa: F811
    settings = fixture_settings()
    space_id, envelope = await host_global(settings)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            await take_space(client, space_id, settings.provider_id)
            await import_envelope(client, envelope)
            await refused(client, hire(space_id), 409, 'replica_read_only')
            response = await client.get(f'/v1/project-agents/{PROPOSED}', params={'personal_space_id': space_id})
            assert response.status_code == 404
        finally:
            await cleanup(driver.maintenance(), space_id, group)
