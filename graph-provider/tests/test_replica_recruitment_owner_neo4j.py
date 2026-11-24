"""A follower's own project recruits while the roster is its host's
(docs/runner-roles-design.md §12; global_replica.RECRUITMENT_ON_OWNER), on a
disposable Neo4j through the full Provider app with the replica guard checking
every write (STRICT).

The recruitment stays with the follower's project and waits ('blocked' /
recruitment_on_owner): never a 409, never an FLA made here, never a 'requested'
record replayed into another refusal. The host makes the FLA (owner_hire.py,
tested in test_owner_hire_neo4j.py); here its next export of `global` is played
by adding that FLA to the host's envelope, and the import finishes the
recruitment with the follower's own records (replica_recruitment_completion.py).

The host is played first in the same graph, the follower after it under the same
space ID (test_follower_space_neo4j.py). Synthetic data only.

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1.
"""
import copy
from uuid import uuid4

import pytest

from fuli_graph.project_agent_models import ProjectAgentProfile
from fuli_graph.provider_values import graphiti_group_id, stable_uuid
from test_follower_space_neo4j import (  # noqa: F401
    alone, follower_settings, host_global, no_personal_space, strict, take_space,
)
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_scope_export_neo4j import checked, cleanup
from test_scope_import_neo4j import OWNER, import_envelope, node, retouched, scenario

LOCAL = 'synthetic-local'
ON_OWNER = 'recruitment_on_owner'


async def follower_with_local_project(client, settings, space_id, envelope):
    """The follower: the host's space, its copy of global, and a new project of its own."""
    await take_space(client, space_id, settings.provider_id)
    await import_envelope(client, envelope)
    await checked(await client.put('/v1/personal-projects', json={
        'personal_space_id': space_id, 'project_id': LOCAL,
        'profile': {'name': 'Synthetic local', 'lifecycle': 'active', 'purpose': 'A project of the follower.'}}))


async def copy_digest(client, space_id):
    """The copy of global as its summary reads it: what no write here may change."""
    return (await checked(await client.get('/v1/scopes/replica-summary', params={
        'personal_space_id': space_id, 'scope': 'global'})))['contentDigest']


async def staff_lead(client, space_id, project=LOCAL):
    return await checked(await client.post('/v1/project-agent-context/default-lead', json={
        'personal_space_id': space_id, 'personal_project_id': project, 'source_application': 'codex'}))


async def recruitments(client, space_id, project=LOCAL):
    return await checked(await client.get('/v1/project-agent-recruitments', params={
        'personal_space_id': space_id, 'personal_project_id': project}))


async def tasks(client, space_id, project=LOCAL):
    return await checked(await client.get('/v1/project-agent-tasks', params={
        'personal_space_id': space_id, 'personal_project_id': project}))


async def agent_exists(client, space_id, agent_id):
    response = await client.get(f'/v1/project-agents/{agent_id}', params={'personal_space_id': space_id})
    return response.status_code == 200


def new_durable_task(space_id, key):
    return {'personal_space_id': space_id, 'personal_project_id': LOCAL, 'idempotency_key': key,
            'title': 'Synthetic second hire', 'objective': 'Hire a second FLA for the sample.',
            'work_kind': 'verification', 'source_application': 'codex', 'staffing_intent': 'new_durable',
            'routing_reason': 'Synthetic acceptance.'}


def with_hired_fla(envelope, space_id, provider_id, recruitment, name='Synthetic hired lead'):
    """The host's next export of global: the FLA it made for this recruitment
    (owner_hire.py: under the proposed agent_id, carrying the recruitment), hung
    on the space as every FLA is. Shaped from an FLA the envelope already has."""
    agent_id = recruitment['proposed_agent_id']
    node_key = stable_uuid(provider_id, space_id, 'project-agent', agent_id)
    profile = ProjectAgentProfile.model_validate({**recruitment['proposed_profile'], 'display_name': name})

    def add(changed):
        template = next(entry for entry in changed['nodes'] if entry['id'].startswith('FuliProjectAgent:')
                        and entry['properties'].get('agent_id') == 'scope-writer')
        link = next(entry for entry in changed['relationships'] if entry['type'] == 'HAS_PROJECT_AGENT_IDENTITY'
                    and entry['end'] == template['id'])
        hired = copy.deepcopy(template)
        hired['id'] = f'FuliProjectAgent:{node_key}'
        properties = {key: value for key, value in hired['properties'].items()
                      if not key.startswith('employee_number') and key != 'temporary_task_id'}
        properties.update({
            'id': node_key, 'agent_id': agent_id, 'name': profile.name, 'profile_json': profile.model_dump_json(),
            'display_name_key': name.lower(), 'status': 'active', 'agent_type': 'durable',
            'system_managed': False, 'recruitment_id': recruitment['recruitment_id'],
            'occupation_recruitment_id': recruitment['recruitment_id'],
            'occupation_role': recruitment['occupation']['role'],
            'occupation_tags': recruitment['occupation']['tags'],
            'recruitment_reason': '来自 Synthetic laptop 的项目 Synthetic local 的招聘：Synthetic.',
            'recruited_at': {'$datetime': '2026-11-25T00:00:00+00:00'}})
        hired['properties'] = properties
        hung = copy.deepcopy(link)
        hung['end'] = hired['id']
        hung['id'] = f"HAS_PROJECT_AGENT_IDENTITY:{link['start']}->{hired['id']}"
        changed['nodes'] = sorted([*changed['nodes'], hired], key=lambda entry: entry['id'])
        changed['relationships'] = sorted([*changed['relationships'], hung], key=lambda entry: entry['id'])
        changed['ids'] = {'nodes': [entry['id'] for entry in changed['nodes']],
                          'relationships': [entry['id'] for entry in changed['relationships']]}
    return retouched(envelope, add), f'FuliProjectAgent:{node_key}'


@pytest.mark.asyncio
async def test_a_new_projects_first_lead_waits_for_the_owner_and_global_stays_as_copied(alone, strict):  # noqa: F811
    settings = fixture_settings()
    space_id, envelope = await host_global(settings)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            await follower_with_local_project(client, settings, space_id, envelope)
            digest = await copy_digest(client, space_id)
            staffed = await staff_lead(client, space_id)
            assert (staffed['status'], staffed['reason']) == ('unassigned', ON_OWNER)
            [recruitment] = await recruitments(client, space_id)
            assert (recruitment['status'], recruitment['reason_code']) == ('blocked', ON_OWNER)
            assert recruitment['hr_agent_id'] == 'employee.bole', 'the copied HR recruits'
            [task] = await tasks(client, space_id)
            assert task['status'] == 'awaiting_recruitment' and task['routing_outcome'] == 'recruitment_required'
            assert task['routing_reason'] != 'hr_unavailable'
            assert not await agent_exists(client, space_id, recruitment['proposed_agent_id'])
            assert await copy_digest(client, space_id) == digest
            # Every later entry replays the same staffing: the wait stays one record, never provisioned.
            for _ in range(3):
                again = await staff_lead(client, space_id)
                assert again['reason'] == ON_OWNER
                assert await recruitments(client, space_id) == [recruitment]
            assert not await agent_exists(client, space_id, recruitment['proposed_agent_id'])
            assert await copy_digest(client, space_id) == digest

            # The host made the FLA; its next copy brings it, and the recruitment finishes here.
            hired, hired_id = with_hired_fla(envelope, space_id, settings.provider_id, recruitment)
            imported = await import_envelope(client, hired)
            assert (imported['recruitmentsCompleted'], imported['recruitmentsPending'],
                    imported['recruitmentsFailed']) == (1, 0, 0)
            [finished] = await recruitments(client, space_id)
            assert finished['status'] == 'fulfilled' and finished['reason_code'] != ON_OWNER
            assert finished['recruited_agent_id'] == recruitment['proposed_agent_id']
            [task] = await tasks(client, space_id)
            assert task['status'] == 'completed', 'the lead took over, as on a single computer'
            assert task['lead_agent_id'] == recruitment['proposed_agent_id']
            policy = await checked(await client.get('/v1/project-agent-coordination-policy', params={
                'personal_space_id': space_id, 'personal_project_id': LOCAL}))
            assert policy['team_lead_agent_id'] == recruitment['proposed_agent_id']
            assignments = await checked(await client.get('/v1/project-agent-assignments', params={
                'personal_space_id': space_id, 'personal_project_id': LOCAL}))
            assert [item['agent_id'] for item in assignments] == [recruitment['proposed_agent_id']]
            # The FLA is the host's copy as it came: not one property of it was set here.
            entry = next(item for item in hired['nodes'] if item['id'] == hired_id)
            held = await node(driver, hired_id)
            assert held['fuli_replica_owner'] == OWNER
            assert {key: held[key] for key in ('agent_id', 'name', 'profile_json', 'recruitment_id', 'status')} == {
                key: entry['properties'][key] for key in ('agent_id', 'name', 'profile_json', 'recruitment_id',
                                                          'status')}
            assert await copy_digest(client, space_id) == imported['contentDigest']
            resolved = await checked(await client.post('/v1/project-agent-context/resolve', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL, 'source_application': 'codex'}))
            assert resolved['agent']['agent_id'] == recruitment['proposed_agent_id']
            # Imported again: nothing left to finish.
            again = await import_envelope(client, hired)
            assert (again['recruitmentsCompleted'], again['recruitmentsPending']) == (0, 0)
        finally:
            await cleanup(driver.maintenance(), space_id, group)


@pytest.mark.asyncio
async def test_a_hire_the_person_approves_on_the_follower_waits_for_the_owner_too(alone, strict):  # noqa: F811
    settings = fixture_settings()
    space_id, envelope = await host_global(settings)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            await follower_with_local_project(client, settings, space_id, envelope)
            await staff_lead(client, space_id)
            [lead] = await recruitments(client, space_id)
            hired, _ = with_hired_fla(envelope, space_id, settings.provider_id, lead)
            await import_envelope(client, hired)
            await checked(await client.put('/v1/project-agent-coordination-policy', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL, 'ask_before_recruitment': True,
                'auto_reuse_previous_agent': True, 'team_lead_agent_id': lead['proposed_agent_id']}))
            digest = await copy_digest(client, space_id)
            routed = await checked(await client.post('/v1/project-agent-tasks', json=new_durable_task(
                space_id, f'second-hire-{uuid4()}')))
            asked = routed['recruitment']
            assert asked['status'] == 'awaiting_confirmation' and routed['decision'] == 'awaiting_confirmation'
            approved = await checked(await client.post(
                f"/v1/project-agent-recruitments/{asked['recruitment_id']}/decision", json={
                    'personal_space_id': space_id, 'personal_project_id': LOCAL,
                    'recruitment_id': asked['recruitment_id'], 'decision': 'approve',
                    'expected_revision': asked['revision'], 'reason': 'Synthetic approval.'}))
            assert (approved['status'], approved['reason_code']) == ('blocked', ON_OWNER)
            assert not await agent_exists(client, space_id, asked['proposed_agent_id'])
            assert await copy_digest(client, space_id) == digest
            task = await checked(await client.get(f"/v1/project-agent-tasks/{asked['task_id']}", params={
                'personal_space_id': space_id, 'personal_project_id': LOCAL}))
            assert task['status'] == 'awaiting_recruitment'
            # The host refused (say the name was taken): the person cancels the wait and recruits again.
            cancelled = await checked(await client.post(
                f"/v1/project-agent-recruitments/{asked['recruitment_id']}/decision", json={
                    'personal_space_id': space_id, 'personal_project_id': LOCAL,
                    'recruitment_id': asked['recruitment_id'], 'decision': 'cancel',
                    'expected_revision': approved['revision'], 'reason': 'Synthetic: the host could not hire.'}))
            assert cancelled['status'] == 'cancelled'
            assert await copy_digest(client, space_id) == digest
        finally:
            await cleanup(driver.maintenance(), space_id, group)


@pytest.mark.asyncio
async def test_an_approved_hire_finishes_when_its_fla_arrives_and_the_task_moves_on(alone, strict):  # noqa: F811
    settings = fixture_settings()
    space_id, envelope = await host_global(settings)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            await follower_with_local_project(client, settings, space_id, envelope)
            await checked(await client.put('/v1/project-agent-coordination-policy', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL, 'ask_before_recruitment': False,
                'auto_reuse_previous_agent': True}))
            routed = await checked(await client.post('/v1/project-agent-tasks', json=new_durable_task(
                space_id, f'hire-{uuid4()}')))
            waiting = routed['recruitment']
            assert (waiting['status'], waiting['reason_code']) == ('blocked', ON_OWNER)
            assert routed['task']['status'] == 'awaiting_recruitment' and routed['decision'] == 'blocked'
            hired, _ = with_hired_fla(envelope, space_id, settings.provider_id, waiting)
            imported = await import_envelope(client, hired)
            assert imported['recruitmentsCompleted'] == 1
            task = await checked(await client.get(f"/v1/project-agent-tasks/{waiting['task_id']}", params={
                'personal_space_id': space_id, 'personal_project_id': LOCAL}))
            assert task['status'] != 'awaiting_recruitment'
            assert task['lead_agent_id'] == waiting['proposed_agent_id']
        finally:
            await cleanup(driver.maintenance(), space_id, group)


@pytest.mark.asyncio
async def test_a_requested_record_an_older_fuli_left_waits_for_the_owner_instead(alone, strict):  # noqa: F811
    settings = fixture_settings()
    space_id, envelope = await host_global(settings)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        maintenance = driver.maintenance()
        try:
            await follower_with_local_project(client, settings, space_id, envelope)
            await staff_lead(client, space_id)
            [recruitment] = await recruitments(client, space_id)
            digest = await copy_digest(client, space_id)
            older = '''
                MATCH (r:FuliProjectAgentRecruitment {recruitment_id: $id})
                SET r.status = 'requested', r.reason_code = 'no_match', r.provisioning_claim_id = 'synthetic-claim',
                    r.provisioning_claimed_at = datetime('2026-01-01T00:00:00Z')'''
            # As an older FULI left it: requested, its task saved (the replay recovers it) ...
            await maintenance.execute_query(older, id=recruitment['recruitment_id'])
            replayed = await staff_lead(client, space_id)
            assert replayed['reason'] == ON_OWNER
            [held] = await recruitments(client, space_id)
            assert (held['status'], held['reason_code']) == ('blocked', ON_OWNER)
            # ... or its task never saved (the hire failed before it): the submission meets the record.
            await maintenance.execute_query(older, id=recruitment['recruitment_id'])
            await maintenance.execute_query('MATCH (t:FuliProjectAgentTask {task_id: $id}) DETACH DELETE t',
                                            id=recruitment['task_id'])
            replayed = await staff_lead(client, space_id)
            assert replayed['reason'] == ON_OWNER
            [held] = await recruitments(client, space_id)
            assert (held['status'], held['reason_code']) == ('blocked', ON_OWNER)
            assert [task['status'] for task in await tasks(client, space_id)] == ['awaiting_recruitment']
            assert not await agent_exists(client, space_id, recruitment['proposed_agent_id'])
            assert await copy_digest(client, space_id) == digest
        finally:
            await cleanup(maintenance, space_id, group)


@pytest.mark.asyncio
async def test_a_graph_whose_global_is_its_own_hires_the_lead_at_once(alone, strict):  # noqa: F811
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        await no_personal_space(client)
        driver, space, group = await scenario(client)
        try:
            await checked(await client.put('/v1/personal-projects', json={
                'personal_space_id': space, 'project_id': LOCAL,
                'profile': {'name': 'Synthetic local', 'lifecycle': 'active', 'purpose': 'A project.'}}))
            staffed = await staff_lead(client, space)
            assert staffed['status'] == 'ready' and staffed['reason'] == 'default_project_lead'
            [recruitment] = await recruitments(client, space)
            assert recruitment['status'] == 'fulfilled' and recruitment['reason_code'] != ON_OWNER
            assert [task['status'] for task in await tasks(client, space)] == ['completed']
        finally:
            await cleanup(driver, space, group)

