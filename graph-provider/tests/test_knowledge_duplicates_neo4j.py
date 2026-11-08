"""Automatic duplicate merging against an explicitly disposable Neo4j: the
same experience or fact stored twice becomes one current item when it is
written, confirmed, or found by the periodic pass. The other copy is history
with its words, the kept item carries both sources, recall returns only the
kept one, and a person's restore splits the copy back out for good.
Synthetic projects and items only; public HTTP routes drive every write."""
from uuid import uuid4

import pytest

from fuli_graph.knowledge_semantic import semantic_hash, semantic_text
from test_knowledge_unresolved_bases_neo4j import revise
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import commit, confirm, ok, space_with_projects, view


def checks(key, *scripts):
    listed = ', '.join(f'`{script}`' for script in scripts)
    return {'key': key, 'type': 'ReusableExperience', 'name': f'Project checks: {listed}',
            'summary': f'These project scripts ran clean at the end of a finished task: {listed}.'}


def fact(key, text, name=None):
    return {'key': key, 'type': 'ProjectFact', 'name': name or text, 'summary': text}


async def entities(client, space_id, query, project='alpha'):
    found = ok(await client.post('/v1/search', json={
        'space_ids': [space_id], 'query': query, 'limit': 20, 'personal_project_ids': [project],
        'active_personal_project_id': project, 'include_pending': True}))
    return {entity['id'] for entity in found['entities']}, {item['id'] for item in found['facts']}


async def scan(client, space_id):
    return ok(await client.post('/v1/knowledge/duplicates/merge', json={'personal_space_id': space_id}))['merged']


def merged_into(item):
    [ended] = [revision for revision in item['revisions'] if revision['action'] == 'supersede']
    return ended['current']['replacedByItemId'], ended['current']['duplicateMerge']['rule']


@pytest.mark.asyncio
async def test_a_longer_list_of_checks_absorbs_the_older_one_and_a_person_can_split_it_back():
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        [short_id] = (await commit(client, space_id, [checks('c1', 'npm run check', 'npm test')],
                                   project='alpha'))['entity_ids']
        saved = await commit(client, space_id, [checks('c2', 'npm run check', 'npm run fixtures', 'npm test')],
                             project='alpha')
        [long_id] = saved['entity_ids']
        assert saved['superseded'] == [{'item_kind': 'entity', 'item_id': short_id}]

        short = await view(client, space_id, short_id)
        assert short['status'] == 'superseded' and short['content'].endswith('`npm run check`, `npm test`.')
        assert merged_into(short) == (long_id, 'covers')
        kept = await view(client, space_id, long_id)
        assert kept['status'] == 'current' and kept['confirmation_status'] == 'pending', 'two pending stay pending'
        assert kept['evidence_count'] == 2, 'the kept item carries both sources'
        assert [version['item_id'] for version in kept['versions'] if version['merged_duplicate']] == [short_id]
        found, _ = await entities(client, space_id, 'Project checks npm run check npm test')
        assert long_id in found and short_id not in found, 'recall returns only the kept item'

        # The person splits it back: both are current again and stay apart.
        ok(await revise(client, space_id, short_id, 'restore'))
        short = await view(client, space_id, short_id)
        assert short['status'] == 'current'
        assert [revision['current'].get('duplicateSplit') for revision in short['revisions']
                if revision['action'] == 'restore'] == [{'fromItemId': long_id}]
        kept = await view(client, space_id, long_id)
        assert kept['evidence_count'] == 1
        assert not [version for version in kept['versions'] if version['merged_duplicate']]
        assert await scan(client, space_id) == []
        found, _ = await entities(client, space_id, 'Project checks npm run check npm test')
        assert {short_id, long_id} <= found


@pytest.mark.asyncio
async def test_a_longer_list_said_again_after_a_shorter_one_absorbs_it():
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        longer = checks('c2', 'npm run check', 'npm run fixtures', 'npm test')
        [long_id] = (await commit(client, space_id, [longer], project='alpha'))['entity_ids']
        later = await commit(client, space_id, [checks('c1', 'npm run check', 'npm test')], project='alpha')
        [short_id] = later['entity_ids']
        assert later['superseded'] == [], 'a shorter list said last may mean something was removed'
        again = await commit(client, space_id, [longer], project='alpha')
        assert again['superseded'] == [{'item_kind': 'entity', 'item_id': short_id}]
        assert merged_into(await view(client, space_id, short_id)) == (long_id, 'covers')


@pytest.mark.asyncio
async def test_a_copy_goes_into_the_confirmed_item_and_other_projects_or_conflicts_stay_apart():
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta')
        text = 'Ship a release with `make ship` from the main branch'
        [first_id] = (await commit(client, space_id, [fact('ship-1', text)], project='alpha'))['entity_ids']
        await confirm(client, space_id, first_id)
        beta = await commit(client, space_id, [fact('ship-2', text)], project='beta')
        assert beta['superseded'] == [], 'another project is another scope'
        conflict = await commit(client, space_id, [fact('ship-3', text.replace('`make ship`', '`make release`'))],
                                project='alpha')
        assert conflict['superseded'] == [], 'a different command is no duplicate'
        copy = await commit(client, space_id, [fact('ship-4', text.upper())], project='alpha')
        [copy_id] = copy['entity_ids']
        assert copy['superseded'] == [{'item_kind': 'entity', 'item_id': copy_id}]
        kept = await view(client, space_id, first_id)
        assert kept['status'] == 'current' and kept['confirmation_status'] == 'confirmed'
        assert merged_into(await view(client, space_id, copy_id)) == (first_id, 'same_text')


@pytest.mark.asyncio
async def test_confirming_the_longer_list_absorbs_a_confirmed_shorter_one():
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        [short_id] = (await commit(client, space_id, [checks('c1', 'npm test')], project='alpha'))['entity_ids']
        await confirm(client, space_id, short_id)
        saved = await commit(client, space_id, [checks('c2', 'npm run lint', 'npm test')], project='alpha')
        [long_id] = saved['entity_ids']
        assert saved['superseded'] == [], 'a pending list never absorbs a confirmed one'
        await confirm(client, space_id, long_id)
        assert merged_into(await view(client, space_id, short_id)) == (long_id, 'covers')


@pytest.mark.asyncio
async def test_a_restated_fact_between_the_same_entities_is_one_relationship():
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        ends = [{'key': 'relay', 'name': 'Relay', 'type': 'System'}, {'key': 'queue', 'name': 'Queue', 'type': 'System'}]

        async def say(key):
            saved = await commit(client, space_id, ends, project='alpha', relationships=[{
                'key': key, 'source': 'relay', 'target': 'queue', 'type': 'PUBLISHES_TO',
                'fact': 'Relay publishes every message to Queue'}])
            return saved['relationship_ids'][0], saved

        first_id, _ = await say('r1')
        second_id, saved = await say('r2')
        assert saved['superseded'] == [{'item_kind': 'relationship', 'item_id': second_id}]
        kept = await view(client, space_id, first_id, 'relationship')
        assert kept['status'] == 'current' and kept['evidence_count'] == 2
        _, facts = await entities(client, space_id, 'Relay publishes every message to Queue')
        assert first_id in facts and second_id not in facts
        ok(await revise(client, space_id, second_id, 'restore', kind='relationship'))
        assert (await view(client, space_id, first_id, 'relationship'))['evidence_count'] == 1


@pytest.mark.asyncio
async def test_the_periodic_pass_merges_the_same_meaning_once_vectors_arrive():
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        older = fact('day-1', 'We release on Thursdays after the standup', name='Release day')
        newer = fact('day-2', 'Releases go out every Thursday once standup ends', name='Release day')
        [older_id] = (await commit(client, space_id, [older], project='alpha'))['entity_ids']
        saved = await commit(client, space_id, [newer], project='alpha')
        [newer_id] = saved['entity_ids']
        assert saved['superseded'] == [], 'no vectors yet: different words stay apart'
        model = f'synthetic-embed-{uuid4()}'
        items = [{'item_kind': 'entity', 'item_id': item_id, 'vector': vector,
                  'hash': semantic_hash(semantic_text('entity', {'name': entity['name'], 'summary': entity['summary']}))}
                 for item_id, entity, vector in ((older_id, older, [1.0, 0.0, 0.0]), (newer_id, newer, [0.999, 0.01, 0.0]))]
        assert ok(await client.post('/v1/semantic/vectors', json={
            'personal_space_id': space_id, 'model': model, 'items': items}))['written'] == 2
        assert await scan(client, space_id) == [{'item_kind': 'entity', 'item_id': newer_id,
                                                 'kept_item_id': older_id, 'rule': 'same_meaning'}]
        assert await scan(client, space_id) == []
        assert merged_into(await view(client, space_id, newer_id)) == (older_id, 'same_meaning')
