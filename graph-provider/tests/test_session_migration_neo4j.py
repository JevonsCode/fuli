"""rec#20 part 2 against an explicitly disposable Neo4j: a session's batch
migration from its temporary project into the formal project it linked to, and
facts or experiences that apply to several projects. Synthetic data only;
public HTTP routes drive every write."""

import json
from uuid import uuid4

import pytest

from fuli_graph.temporary_project_scope import session_temporary_project_id
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import commit, confirm, move, ok, preference, space_with_projects, view

SESSION = 'synthetic-migration-session'


async def held_session(client, space_id, session=SESSION):
    temporary_id = session_temporary_project_id(space_id, 'codex', session)
    temporary = ok(await client.post('/v1/temporary-projects/ensure', json={
        'personal_space_id': space_id, 'scope_key': temporary_id.removeprefix('temporary-'),
        'source_application': 'codex', 'lifetime': 'session'}))
    assert temporary['project_id'] == temporary_id
    return temporary_id


async def link_task(client, space_id, project, *, session=SESSION):
    token = f'fuli-task-{uuid4()}'
    ok(await client.put('/v1/task-contexts', json={
        'personal_space_id': space_id, 'personal_project_id': project, 'session_id': session,
        'source_application': 'codex', 'token': token, 'turn_id': f'turn-{uuid4()}'}))
    return token


async def preview(client, space_id, target, *, session=SESSION, include_items=True):
    return ok(await client.post('/v1/knowledge/session-migrations/preview', json={
        'personal_space_id': space_id, 'source_application': 'codex', 'session_id': session,
        'target_project_id': target, 'include_items': include_items}))


async def migrate(client, space_id, target, items, *, session=SESSION):
    return await client.post('/v1/knowledge/session-migrations/apply', json={
        'personal_space_id': space_id, 'source_application': 'codex', 'session_id': session,
        'target_project_id': target, 'reason': 'Synthetic: this session belongs to the project.',
        'items': [{'item_kind': item['item_kind'], 'item_id': item['item_id'],
                   'expected_version': item['version']} for item in items]})


async def found_in(client, space_id, project, text):
    response = ok(await client.post('/v1/search', json={
        'space_ids': [space_id], 'query': text, 'limit': 20, 'personal_project_ids': [project],
        'active_personal_project_id': project, 'include_pending': True}))
    return json.dumps(response, ensure_ascii=False)


@pytest.mark.asyncio
async def test_a_linked_session_offers_exactly_its_held_items_and_moves_only_the_chosen_ones():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta')
        temporary_id = await held_session(client, space_id)
        held = await commit(client, space_id, [
            preference('brief', 'Prefer brief status lines', content_source='agent_inferred'),
            {'key': 'gate', 'name': 'Synthetic staging gate', 'type': 'ProjectFact',
             'summary': 'Synthetic staging gate', 'content_source': 'agent_inferred'},
            {'key': 'retry', 'name': 'Synthetic retry lesson', 'type': 'TaskExperience',
             'summary': 'Synthetic retry lesson', 'content_source': 'agent_inferred'}],
            project=temporary_id, scope_status='undetermined')
        # The person already placed this one: it is no longer the session's to migrate.
        shared = (await commit(client, space_id, [{'key': 'shared', 'name': 'Synthetic placed fact',
                                                   'type': 'ProjectFact', 'summary': 'Synthetic placed fact'}],
                               project=temporary_id, scope_status='undetermined'))['entity_ids'][0]
        assert (await move(client, space_id, shared, 'projects', version=(await view(client, space_id, shared))[
            'version'], projects=['beta'])).status_code == 200
        await link_task(client, space_id, 'alpha')
        offer = await preview(client, space_id, 'alpha')
        assert offer['temporary_project_id'] == temporary_id
        assert offer['target_project']['id'] == 'alpha' and offer['linked_task_count'] == 1
        assert offer['held_count'] == 3 and not offer['truncated']
        assert {item['item_id'] for item in offer['items']} == set(held['entity_ids'])
        assert shared not in {item['item_id'] for item in offer['items']}
        assert all(item['scope']['kind'] == 'temporary' and item['scope']['status'] == 'undetermined'
                   for item in offer['items'])
        count_only = await preview(client, space_id, 'alpha', include_items=False)
        assert (count_only['held_count'], count_only['items']) == (3, [])
        # The person deselects the experience and moves the other two.
        by_title = {item['title']: item for item in offer['items']}
        chosen = [by_title['Prefer brief status lines'], by_title['Synthetic staging gate']]
        moved = await migrate(client, space_id, 'alpha', chosen)
        assert moved.status_code == 200, moved.text
        assert {row['item_id'] for row in moved.json()['moved']} == {item['item_id'] for item in chosen}
        for item in chosen:
            after = await view(client, space_id, item['item_id'])
            assert after['item_id'] == item['item_id'], 'the same item moves; nothing is copied'
            assert (after['scope']['kind'], after['scope']['status']) == ('projects', 'set')
            assert [project['id'] for project in after['scope']['projects']] == ['alpha']
            assert after['confirmation_status'] == 'pending', 'an Agent inference stays pending'
            [revision] = [row for row in after['revisions'] if row['action'] == 'scope_change']
            assert revision['previous']['scope']['kind'] == 'temporary'
            assert revision['current']['scope']['projects'][0]['id'] == 'alpha'
        assert 'Synthetic staging gate' in await found_in(client, space_id, 'alpha', 'Synthetic staging gate')
        left = await preview(client, space_id, 'alpha')
        assert [item['title'] for item in left['items']] == ['Synthetic retry lesson']
        # A later task of the same session in the project is no longer the link.
        await link_task(client, space_id, 'alpha')
        assert (await preview(client, space_id, 'alpha', include_items=False))['linked_task_count'] == 2


@pytest.mark.asyncio
async def test_a_changed_item_refuses_the_whole_batch_and_names_it():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta')
        temporary_id = await held_session(client, space_id)
        await commit(client, space_id, [preference('a', 'Synthetic held one'), preference('b', 'Synthetic held two')],
                     project=temporary_id, scope_status='undetermined')
        offer = (await preview(client, space_id, 'alpha'))['items']
        one, two = offer
        await confirm(client, space_id, one['item_id'])
        refused = await migrate(client, space_id, 'alpha', offer)
        assert refused.status_code == 409
        detail = refused.json()['detail']
        assert detail['code'] == 'stale_version'
        assert [row['item_id'] for row in detail['stale_items']] == [one['item_id']]
        assert detail['stale_items'][0]['reason'] == 'changed'
        assert (await view(client, space_id, two['item_id']))['scope']['kind'] == 'temporary', 'nothing moved'
        # Placed elsewhere meanwhile: no longer held, so not migrated over the person's choice.
        current = await view(client, space_id, two['item_id'])
        assert (await move(client, space_id, two['item_id'], 'projects', version=current['version'],
                           projects=['beta'])).status_code == 200
        fresh = (await preview(client, space_id, 'alpha'))['items']
        assert [item['item_id'] for item in fresh] == [one['item_id']]
        gone = await migrate(client, space_id, 'alpha', [two])
        assert gone.status_code == 409 and gone.json()['detail']['stale_items'][0]['reason'] == 'not_held'
        assert (await migrate(client, space_id, 'alpha', fresh)).status_code == 200
        after = await view(client, space_id, one['item_id'])
        assert after['confirmation_status'] == 'confirmed', 'a migration never changes confirmation'
        assert [project['id'] for project in after['scope']['projects']] == ['alpha']


@pytest.mark.asyncio
async def test_a_migration_targets_a_registered_project_of_the_owner_only():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        temporary_id = await held_session(client, space_id)
        await commit(client, space_id, [preference('a', 'Synthetic owner only')], project=temporary_id,
                     scope_status='undetermined')
        offer = (await preview(client, space_id, 'alpha'))['items']
        assert (await client.post('/v1/knowledge/session-migrations/preview', json={
            'personal_space_id': space_id, 'source_application': 'codex', 'session_id': SESSION,
            'target_project_id': temporary_id})).status_code == 422
        assert (await migrate(client, space_id, temporary_id, offer)).status_code == 422
        other_session = await preview(client, space_id, 'alpha', session='another-session')
        assert (other_session['held_count'], other_session['items']) == (0, []), 'another session holds nothing here'
        stranger = ok(await client.post('/v1/principals', json={'name': 'Synthetic stranger'}))
        async with provider_client(settings, stranger['access_token']) as (other, _):
            assert (await other.post('/v1/knowledge/session-migrations/preview', json={
                'personal_space_id': space_id, 'source_application': 'codex', 'session_id': SESSION,
                'target_project_id': 'alpha'})).status_code in {403, 404}
            assert (await migrate(other, space_id, 'alpha', offer)).status_code in {403, 404}
        assert (await view(client, space_id, offer[0]['item_id']))['scope']['kind'] == 'temporary'


@pytest.mark.asyncio
async def test_a_fact_applies_to_several_projects_and_narrowing_ends_the_extra_reference():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta', 'gamma')
        text = f'Synthetic multi-project fact {uuid4().hex[:8]}'
        fact = (await commit(client, space_id, [{'key': 'multi', 'name': text, 'type': 'ProjectFact',
                                                 'summary': text}], project='alpha'))['entity_ids'][0]
        await confirm(client, space_id, fact)
        before = await view(client, space_id, fact)
        assert text not in await found_in(client, space_id, 'beta', text)
        widened = await move(client, space_id, fact, 'projects', version=before['version'], projects=['alpha', 'beta'])
        assert widened.status_code == 200, widened.text
        after = await view(client, space_id, fact)
        assert after['item_id'] == fact and after['confirmation_status'] == 'confirmed'
        assert [project['id'] for project in after['scope']['projects']] == ['alpha', 'beta']
        assert text in await found_in(client, space_id, 'beta', text)
        assert text not in await found_in(client, space_id, 'gamma', text)
        # Global and one FLA stay a preference's scope.
        for scope in ('global',):
            assert (await move(client, space_id, fact, scope, version=after['version'])).status_code == 422
        # Narrowed to beta only: alpha stops, the item and its history stay.
        narrowed = await move(client, space_id, fact, 'projects', version=after['version'], projects=['beta'])
        assert narrowed.status_code == 200, narrowed.text
        last = await view(client, space_id, fact)
        assert [project['id'] for project in last['scope']['projects']] == ['beta']
        assert text in await found_in(client, space_id, 'beta', text)
        assert text not in await found_in(client, space_id, 'alpha', text)
        revisions = [row for row in last['revisions'] if row['action'] == 'scope_change']
        assert [[project['id'] for project in row['current']['scope']['projects']] for row in revisions] == [
            ['beta'], ['alpha', 'beta']]
        # A stale page cannot undo it.
        assert (await move(client, space_id, fact, 'projects', version=after['version'],
                           projects=['alpha'])).status_code == 409


@pytest.mark.asyncio
async def test_a_new_version_keeps_every_project_and_a_project_with_a_match_is_left_to_join_project():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta', 'gamma')
        fact = (await commit(client, space_id, [{'key': 'cfg', 'name': 'Synthetic config path', 'type': 'ProjectFact',
                                                 'summary': 'Config lives in etc'}], project='alpha'))['entity_ids'][0]
        version = (await view(client, space_id, fact))['version']
        assert (await move(client, space_id, fact, 'projects', version=version,
                           projects=['alpha', 'beta'])).status_code == 200
        current = await view(client, space_id, fact)
        edited = ok(await client.patch(f'/v1/knowledge/items/{fact}', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'update',
            'reason': 'Synthetic wording fix.', 'name': 'Synthetic config path', 'summary': 'Config lives in /etc',
            'operation_actor': 'human', 'expected_version': current['version']}))
        newer = await view(client, space_id, edited['version_item_id'])
        assert [project['id'] for project in newer['scope']['projects']] == ['alpha', 'beta']
        # gamma already holds a confirmed item of the same name with other words.
        other = (await commit(client, space_id, [{'key': 'cfg2', 'name': 'Synthetic config path',
                                                  'type': 'ProjectFact', 'summary': 'Config lives in a vault'}],
                              project='gamma'))['entity_ids'][0]
        await confirm(client, space_id, other)
        refused = await move(client, space_id, newer['item_id'], 'projects', version=newer['version'],
                             projects=['alpha', 'beta', 'gamma'])
        assert refused.status_code == 409 and refused.json()['detail']['code'] == 'project_has_match'
        assert refused.json()['detail']['project_id'] == 'gamma'
        assert [project['id'] for project in (await view(client, space_id, newer['item_id']))['scope']['projects']] == [
            'alpha', 'beta'], 'a refused change leaves the scope as it was'
