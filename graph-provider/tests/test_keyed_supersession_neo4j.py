"""Write-time supersession against an explicitly disposable Neo4j: a confirmed
value of a keyed relation (a port, a URL, a command, an owner) ends the old
value of the same subject and relation with no model call, a person can take
that back, and free text that may silently replace older knowledge is queued
for the person instead of ended. Current answers never carry the old value;
an explicit history search does. Synthetic projects and facts only; public
HTTP routes drive every write."""

import json
from uuid import uuid4

import pytest

from test_knowledge_unresolved_bases_neo4j import revise
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import commit, confirm, ok, space_with_projects, view

SERVICE = {'key': 'aurora-api', 'name': 'Aurora API', 'type': 'System'}


def port(number):
    return {'key': f'port-{number}', 'name': f'Port {number}', 'type': 'Setting'}


async def say_port(client, space_id, number, *, project='alpha'):
    saved = await commit(client, space_id, [SERVICE, port(number)], project=project, relationships=[{
        'key': f'aurora-port-{number}', 'source': 'aurora-api', 'target': f'port-{number}',
        'type': 'RUNS_ON_PORT', 'fact': f'Aurora API runs on port {number}'}])
    return saved['relationship_ids'][0], saved


async def search(client, space_id, query, *, project='alpha', **flags):
    found = ok(await client.post('/v1/search', json={
        'space_ids': [space_id], 'query': query, 'limit': 20, 'personal_project_ids': [project],
        'active_personal_project_id': project, **flags}))
    return {fact['id']: fact for fact in found['facts']}, {entity['id']: entity for entity in found['entities']}


def revisions(item, action):
    return [revision for revision in item['revisions'] if revision['action'] == action]


def attention(item):
    return item['weight']['basis']['requires_attention']


@pytest.mark.asyncio
async def test_a_confirmed_port_ends_the_old_port_and_current_answers_carry_only_the_new_one():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta')
        old_id, _ = await say_port(client, space_id, 3000)
        await confirm(client, space_id, old_id, 'relationship')
        beta_id, _ = await say_port(client, space_id, 5000, project='beta')
        await confirm(client, space_id, beta_id, 'relationship')

        # A new value an Agent proposed waits for the person; the old one stays
        # current and is queued for the person.
        new_id, saved = await say_port(client, space_id, 4000)
        assert saved['possibly_outdated'] == [{'item_kind': 'relationship', 'item_id': old_id}]
        assert saved['superseded'] == []
        old = await view(client, space_id, old_id, 'relationship')
        assert old['status'] == 'current' and attention(old)
        [queued] = revisions(old, 'possibly_outdated')
        assert queued['current']['possiblyOutdatedBy'] == {'itemKind': 'relationship', 'itemId': new_id}
        assert queued['current']['rule'] == 'keyed_value'
        facts, _ = await search(client, space_id, 'Aurora API runs on port')
        assert old_id in facts and new_id not in facts, 'a pending value is no current answer yet'

        # The person confirms the new value: the old one ends, with its words.
        await confirm(client, space_id, new_id, 'relationship')
        old = await view(client, space_id, old_id, 'relationship')
        assert old['status'] == 'superseded' and old['invalid_at'] is not None
        assert old['content'] == 'Aurora API runs on port 3000'
        [ended] = revisions(old, 'supersede')
        assert ended['current']['replacedByItemId'] == new_id
        assert ended['current']['keyedReplacement'] == {'relation': 'RUNS_ON_PORT'}
        assert ended['changed_by'] == 'user'
        assert (await view(client, space_id, new_id, 'relationship'))['status'] == 'current'

        # Current answers carry only the new value; history comes back only when asked for.
        facts, _ = await search(client, space_id, 'Aurora API runs on port')
        assert new_id in facts and old_id not in facts
        facts, _ = await search(client, space_id, 'Aurora API runs on port', include_historical=True)
        assert facts[new_id]['invalid_at'] is None
        assert facts[old_id]['invalid_at'] is not None, 'the old version is marked as history'

        # Another project's value of the same subject name is another subject.
        assert (await view(client, space_id, beta_id, 'relationship'))['status'] == 'current'
        facts, _ = await search(client, space_id, 'Aurora API runs on port', project='beta')
        assert beta_id in facts


@pytest.mark.asyncio
async def test_a_person_restores_the_old_port_and_the_new_one_ends_the_same_way():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        old_id, _ = await say_port(client, space_id, 3000)
        await confirm(client, space_id, old_id, 'relationship')
        new_id, _ = await say_port(client, space_id, 4000)
        await confirm(client, space_id, new_id, 'relationship')

        refused = await client.patch(f'/v1/knowledge/items/{old_id}', json={
            'personal_space_id': space_id, 'item_kind': 'relationship', 'action': 'restore',
            'reason': 'Synthetic Agent restore.', 'operation_actor': 'agent',
            'expected_version': (await view(client, space_id, old_id, 'relationship'))['version']})
        assert refused.status_code == 409 and refused.json()['detail']['code'] == 'reassert_as_new_version'

        restored = await revise(client, space_id, old_id, 'restore', 'relationship')
        assert restored.status_code == 200, restored.text
        old = await view(client, space_id, old_id, 'relationship')
        new = await view(client, space_id, new_id, 'relationship')
        assert (old['status'], old['invalid_at']) == ('current', None)
        assert new['status'] == 'superseded'
        assert revisions(new, 'supersede')[0]['current']['replacedByItemId'] == old_id
        assert {revision['action'] for revision in old['revisions']} >= {'supersede', 'restore'}
        facts, _ = await search(client, space_id, 'Aurora API runs on port')
        assert old_id in facts and new_id not in facts

        # The restored value is current: its lifecycle works as any current one's.
        again = await revise(client, space_id, new_id, 'restore', 'relationship')
        assert again.status_code == 200, again.text
        assert (await view(client, space_id, old_id, 'relationship'))['status'] == 'superseded'
        assert (await view(client, space_id, new_id, 'relationship'))['status'] == 'current'


@pytest.mark.asyncio
async def test_free_text_that_may_replace_an_older_note_queues_it_and_never_ends_it():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        note = 'Before deploying Aurora run npm run check and npm run build'
        unrelated = 'Aurora docs live in the docs folder of the repository'
        old_id, other_id = (await commit(client, space_id, [
            {'key': 'deploy-note', 'name': note, 'type': 'ProjectFact', 'summary': note},
            {'key': 'docs-note', 'name': unrelated, 'type': 'ProjectFact', 'summary': unrelated}],
            project='alpha'))['entity_ids']
        await confirm(client, space_id, old_id)
        read_version = (await view(client, space_id, old_id))['version']
        newer = 'Before deploying Aurora run npm run check, npm run build and npm run e2e'
        key = f'deploy-v2-{uuid4()}'
        saved = await commit(client, space_id, [{'key': 'deploy-note-v2', 'name': newer, 'type': 'ProjectFact',
                                                  'summary': newer}], project='alpha', key=key)
        new_id = saved['entity_ids'][0]
        assert saved['possibly_outdated'] == [{'item_kind': 'entity', 'item_id': old_id}]
        old = await view(client, space_id, old_id)
        assert old['status'] == 'current' and attention(old)
        assert old['version'] == read_version, 'a page open on the old note still saves'
        [queued] = revisions(old, 'possibly_outdated')
        assert queued['current']['possiblyOutdatedBy'] == {'itemKind': 'entity', 'itemId': new_id}
        assert queued['current']['rule'] == 'similar_text' and queued['current']['share'] >= 0.6
        assert not attention(await view(client, space_id, other_id)), 'unrelated knowledge is not queued'
        _, entities = await search(client, space_id, 'Before deploying Aurora')
        assert old_id in entities, 'queued knowledge stays in current answers until the person decides'

        # A replay and a later confirmation of the newer note queue nothing twice
        # and still end nothing: only a keyed value is replaced without a person.
        replay = await commit(client, space_id, [{'key': 'deploy-note-v2', 'name': newer, 'type': 'ProjectFact',
                                                   'summary': newer}], project='alpha', key=key)
        assert replay['status'] == 'duplicate' and replay['possibly_outdated'] == []
        await confirm(client, space_id, new_id)
        old = await view(client, space_id, old_id)
        assert old['status'] == 'current' and len(revisions(old, 'possibly_outdated')) == 1


@pytest.mark.asyncio
async def test_relations_with_many_values_and_preferences_are_left_alone():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        things = [SERVICE, {'key': 'redis', 'name': 'Redis', 'type': 'System'},
                  {'key': 'postgres', 'name': 'Postgres', 'type': 'System'}]
        first = (await commit(client, space_id, things, project='alpha', relationships=[{
            'key': 'uses-redis', 'source': 'aurora-api', 'target': 'redis', 'type': 'USES',
            'fact': 'Aurora API caches sessions in Redis'}]))['relationship_ids'][0]
        await confirm(client, space_id, first, 'relationship')
        second = await commit(client, space_id, things, project='alpha', relationships=[{
            'key': 'uses-postgres', 'source': 'aurora-api', 'target': 'postgres', 'type': 'USES',
            'fact': 'Aurora API stores orders in Postgres'}])
        await confirm(client, space_id, second['relationship_ids'][0], 'relationship')
        assert second['possibly_outdated'] == [] and second['superseded'] == []
        current = await view(client, space_id, first, 'relationship')
        assert current['status'] == 'current' and not attention(current)
        assert json.dumps(current['revisions']).count('possibly_outdated') == 0
