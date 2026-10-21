"""rec#20 part 1 against an explicitly disposable Neo4j: the per-turn receipt's
read-back, the undecided scope of a temporary session project, the scope quick
edit with its version check, and one-time receipt delivery. Synthetic data only;
public HTTP routes drive every write."""

import asyncio
import hashlib
from uuid import uuid4

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


async def space_with_projects(client, *projects):
    space_id = ok(await client.post('/v1/spaces', json={'name': f'Synthetic receipt {uuid4()}',
                                                         'kind': 'personal'}))['id']
    for project in projects:
        ok(await client.put('/v1/personal-projects', json={
            'personal_space_id': space_id, 'project_id': project,
            'profile': {'name': f'Synthetic {project}', 'lifecycle': 'active',
                        'purpose': 'Verify the per-turn knowledge receipt.'}}))
    return space_id


def preference(key, text, **fields):
    return {'key': key, 'name': text, 'type': 'PersonalPreference', 'summary': text,
            'profile_aspect': 'taste', 'origin_quadrant': 'known_known', **fields}


async def commit(client, space_id, entities, *, project=None, key=None, scope_status=None, relationships=()):
    return ok(await client.post('/v1/knowledge/commits', json={
        'space_id': space_id, 'personal_project_id': project,
        **({'scope_status': scope_status} if scope_status else {}),
        'episode': {'idempotency_key': key or f'receipt-{uuid4()}', 'session_id': 'synthetic-session',
                    'name': 'Synthetic turn', 'source_kind': 'task_remember',
                    'source_description': 'Synthetic items a turn kept.', 'source_application': 'codex',
                    'reference_time': '2026-10-21T00:00:00Z', 'entities': entities,
                    'relationships': list(relationships)}}))


async def receipt(client, space_id, *episodes):
    return ok(await client.post('/v1/knowledge/turn-receipts', json={
        'personal_space_id': space_id, 'episode_ids': list(episodes)}))


async def view(client, space_id, item_id, kind='entity'):
    return ok(await client.post('/v1/knowledge/item-views', json={
        'personal_space_id': space_id, 'item_kind': kind, 'item_id': item_id}))


async def confirm(client, space_id, item_id, kind='entity'):
    current = await view(client, space_id, item_id, kind)
    ok(await client.patch(f'/v1/knowledge/items/{item_id}', json={
        'personal_space_id': space_id, 'item_kind': kind, 'action': 'confirm', 'reason': 'Synthetic confirmation.',
        'confirmation_status': 'confirmed', 'operation_actor': 'human', 'expected_version': current['version'],
        'confirmation_basis': {'existence_reason': 'Synthetic.', 'quadrant_reason': 'Synthetic.',
                               'proposed_by': {'kind': 'agent', 'label': 'Codex'},
                               'confirmed_by': {'kind': 'user', 'label': 'Synthetic user'},
                               'confirmed_at': '2026-10-21T00:00:00Z'}}))


async def applied(client, space_id, project):
    response = ok(await client.get('/v1/collaboration-preferences', params={
        'personal_space_id': space_id, 'personal_project_id': project}))
    return {item['id'] for item in response['effective_preferences']}


async def move(client, space_id, item_id, scope, *, version, projects=(), agent=None, kind='entity'):
    return await client.post(f'/v1/knowledge/items/{item_id}/scope', json={
        'personal_space_id': space_id, 'item_kind': kind, 'expected_version': version,
        'reason': 'Synthetic quick edit.', 'scope': scope, 'project_ids': list(projects), 'agent_id': agent})


@pytest.mark.asyncio
async def test_receipt_reads_back_only_what_a_turn_created_or_replaced():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        first = await commit(client, space_id, [
            preference('lead', 'Lead with the conclusion', content_source='user_explicit'),
            {'key': 'gate', 'name': 'Deploys use the staging gate', 'type': 'ProjectFact',
             'summary': 'Deploys use the staging gate', 'content_source': 'agent_inferred'}], project='alpha')
        entries = (await receipt(client, space_id, first['episode_id']))['entries']
        assert len(entries) == 2
        by_key = {entry['title']: entry for entry in entries}
        lead = by_key['Lead with the conclusion']
        assert (lead['change'], lead['category'], lead['content_source'], lead['confirmation_status']) == (
            'created', 'taste', 'user_explicit', 'pending')
        assert lead['scope']['kind'] == 'projects' and lead['scope']['projects'][0]['id'] == 'alpha'
        assert lead['weight']['percent'] < 70 and lead['weight']['basis']['source_count'] == 1
        assert lead['tags'] == []
        assert by_key['Deploys use the staging gate']['category'] == 'fact'
        # The same items in a later turn are already stored: nothing new to report.
        again = await commit(client, space_id, [preference('lead', 'Lead with the conclusion')], project='alpha')
        repeated = await receipt(client, space_id, again['episode_id'])
        assert repeated == {'entries': [], 'unchanged_count': 1}
        # A replayed commit of the same batch is a duplicate with the same receipt.
        replay = await commit(client, space_id, [preference('lead', 'x')], project='alpha', key='fixed-key')
        assert (await commit(client, space_id, [preference('lead', 'x')], project='alpha',
                             key='fixed-key'))['status'] == 'duplicate'
        assert replay['status'] == 'committed'


@pytest.mark.asyncio
async def test_a_replacing_fact_is_reported_as_updated_not_new():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        endpoints = [{'key': 'svc', 'name': 'Service', 'type': 'System'},
                     {'key': 'port', 'name': 'Port', 'type': 'Setting'}]
        relation = {'key': 'listens', 'source': 'svc', 'target': 'port', 'type': 'LISTENS_ON'}
        await commit(client, space_id, endpoints, project='alpha',
                     relationships=[{**relation, 'fact': 'Service listens on 8080'}])
        second = await commit(client, space_id, endpoints, project='alpha', relationships=[{
            **relation, 'key': 'listens-v2', 'fact': 'Service listens on 9090', 'supersedes': ['listens'],
            'valid_at': '2026-10-22T00:00:00Z'}])
        entries = (await receipt(client, space_id, second['episode_id']))['entries']
        assert [(entry['item_kind'], entry['change']) for entry in entries] == [('relationship', 'updated')]
        assert entries[0]['content'] == 'Service listens on 9090'


@pytest.mark.asyncio
async def test_undecided_scope_stays_in_the_temporary_session_project_until_the_person_moves_it():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta')
        scope_key = hashlib.sha256(b'synthetic-session-scope').hexdigest()
        temporary = ok(await client.post('/v1/temporary-projects/ensure', json={
            'personal_space_id': space_id, 'scope_key': scope_key, 'source_application': 'codex',
            'lifetime': 'session'}))
        assert temporary['scope_type'] == 'temporary'
        assert temporary['profile']['name'].startswith('临时会话')
        held = await commit(client, space_id, [preference('short', 'Prefer short status lines')],
                            project=temporary['project_id'], scope_status='undetermined')
        item_id = held['entity_ids'][0]
        [entry] = (await receipt(client, space_id, held['episode_id']))['entries']
        assert entry['scope']['kind'] == 'temporary'
        assert entry['scope']['status'] == 'undetermined'
        assert entry['confirmation_status'] == 'pending', 'scope pending and content pending are separate'
        await confirm(client, space_id, item_id)
        assert item_id not in await applied(client, space_id, 'alpha'), 'never shared with other projects'
        assert item_id in await applied(client, space_id, temporary['project_id'])
        current = await view(client, space_id, item_id)
        assert (await move(client, space_id, item_id, 'projects', version=current['version'],
                           projects=[temporary['project_id']])).status_code == 422
        # Confirmed while held there: the person's choice places it; nothing to widen from.
        placed = await move(client, space_id, item_id, 'projects', version=current['version'], projects=['beta'])
        assert placed.status_code == 200, placed.text
        after = await view(client, space_id, item_id)
        assert after['item_id'] == item_id and after['confirmation_status'] == 'confirmed'
        assert (after['scope']['kind'], after['scope']['status']) == ('projects', 'set')
        assert [project['id'] for project in after['scope']['projects']] == ['beta']
        [revision] = [item for item in after['revisions'] if item['action'] == 'scope_change']
        assert revision['previous']['scope'] == {'kind': 'temporary', 'status': 'undetermined', 'agent_id': None,
            'projects': [{'id': temporary['project_id'], 'name': temporary['profile']['name'], 'temporary': True}]}
        assert item_id in await applied(client, space_id, 'beta')
        assert item_id not in await applied(client, space_id, temporary['project_id'])
        assert item_id not in await applied(client, space_id, 'alpha')


@pytest.mark.asyncio
async def test_quick_edit_keeps_the_same_item_and_history_and_refuses_a_stale_version():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta', 'gamma')
        saved = await commit(client, space_id, [preference('lead', 'Lead with the conclusion')])
        item_id = saved['entity_ids'][0]
        await confirm(client, space_id, item_id)
        assert {item_id} <= await applied(client, space_id, 'gamma')
        before = await view(client, space_id, item_id)
        assert before['scope']['kind'] == 'global'
        narrowed = await move(client, space_id, item_id, 'projects', version=before['version'],
                              projects=['alpha', 'beta'])
        assert narrowed.status_code == 200, narrowed.text
        after = await view(client, space_id, item_id)
        assert after['item_id'] == item_id
        assert [project['id'] for project in after['scope']['projects']] == ['alpha', 'beta']
        assert after['version'] > before['version']
        assert after['confirmation_status'] == 'confirmed', 'a scope change is not a content change'
        assert item_id in await applied(client, space_id, 'alpha')
        assert item_id in await applied(client, space_id, 'beta')
        assert item_id not in await applied(client, space_id, 'gamma'), 'narrowing stops later use elsewhere'
        [revision] = [item for item in after['revisions'] if item['action'] == 'scope_change']
        assert revision['previous']['scope']['kind'] == 'global'
        assert revision['current']['scope']['kind'] == 'projects'
        stale = await move(client, space_id, item_id, 'projects', version=before['version'], projects=['alpha'])
        assert stale.status_code == 409 and stale.json()['detail']['code'] == 'stale_version'
        stale_edit = await client.patch(f'/v1/knowledge/items/{item_id}', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'update', 'reason': 'Old link.',
            'name': 'Overwritten from an old link', 'operation_actor': 'human',
            'expected_version': before['version']})
        assert stale_edit.status_code == 409
        assert (await view(client, space_id, item_id))['title'] == 'Lead with the conclusion'
        widen = await move(client, space_id, item_id, 'global', version=after['version'])
        assert widen.status_code == 409 and widen.json()['detail']['code'] == 'widening_requires_review'
        # A content edit writes a new version that keeps where it applies
        # (rec#5 C7); the old one keeps its words and history.
        current = await view(client, space_id, item_id)
        edited = ok(await client.patch(f'/v1/knowledge/items/{item_id}', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'update', 'reason': 'Clearer wording.',
            'name': 'Lead with the answer', 'summary': 'Lead with the answer', 'operation_actor': 'human',
            'expected_version': current['version']}))
        version_id = edited['version_item_id']
        old = await view(client, space_id, item_id)
        assert (old['title'], old['status'], old['current_item_id']) == (
            'Lead with the conclusion', 'superseded', version_id)
        current = await view(client, space_id, version_id)
        assert current['title'] == 'Lead with the answer'
        assert [project['id'] for project in current['scope']['projects']] == ['alpha', 'beta']
        ok(await client.patch(f'/v1/knowledge/items/{version_id}', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'invalidate',
            'reason': 'No longer wanted.', 'operation_actor': 'human', 'expected_version': current['version']}))
        final = await view(client, space_id, version_id)
        assert final['invalid_at'] is not None and final['status'] == 'inactive'
        assert {revision['action'] for revision in old['revisions']} >= {'scope_change', 'supersede'}
        assert {revision['action'] for revision in final['revisions']} >= {'invalidate'}
        assert item_id not in await applied(client, space_id, 'alpha')


@pytest.mark.asyncio
async def test_pending_items_move_freely_and_other_knowledge_moves_to_one_project():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta')
        pending = (await commit(client, space_id, [preference('p', 'Synthetic pending preference')],
                                project='alpha'))['entity_ids'][0]
        version = (await view(client, space_id, pending))['version']
        assert (await move(client, space_id, pending, 'global', version=version)).status_code == 200
        assert (await view(client, space_id, pending))['scope']['kind'] == 'global'
        fact = (await commit(client, space_id, [{'key': 'f', 'name': 'Synthetic fact', 'type': 'ProjectFact',
                                                  'summary': 'Synthetic fact'}], project='alpha'))['entity_ids'][0]
        version = (await view(client, space_id, fact))['version']
        assert (await move(client, space_id, fact, 'projects', version=version,
                           projects=['alpha', 'beta'])).status_code == 422
        assert (await move(client, space_id, fact, 'global', version=version)).status_code == 422
        assert (await move(client, space_id, fact, 'projects', version=version, projects=['beta'])).status_code == 200
        moved = await view(client, space_id, fact)
        assert [project['id'] for project in moved['scope']['projects']] == ['beta']
        assert moved['item_id'] == fact


@pytest.mark.asyncio
async def test_another_person_cannot_read_or_edit_through_a_link():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        item_id = (await commit(client, space_id, [preference('x', 'Synthetic private preference')]))['entity_ids'][0]
        stranger = ok(await client.post('/v1/principals', json={'name': 'Synthetic stranger'}))
        async with provider_client(settings, stranger['access_token']) as (other, _):
            read = await other.post('/v1/knowledge/item-views', json={
                'personal_space_id': space_id, 'item_kind': 'entity', 'item_id': item_id})
            assert read.status_code in {403, 404}
            edit = await move(other, space_id, item_id, 'projects', version=0, projects=['alpha'])
            assert edit.status_code in {403, 404}
        assert (await view(client, space_id, item_id))['scope']['kind'] == 'global'


async def begin(client, space_id, token, turn):
    return ok(await client.put('/v1/task-contexts', json={
        'personal_space_id': space_id, 'personal_project_id': 'alpha', 'session_id': 'receipt-session',
        'source_application': 'codex', 'token': token, 'turn_id': turn}))


async def complete(client, space_id, token, episode, entity):
    return ok(await client.put(f'/v1/task-contexts/{token}/checkpoint', json={
        'personal_space_id': space_id, 'source_application': 'codex', 'phase': 'complete',
        'disposition': 'capture_candidates', 'reason': 'Synthetic capture.', 'fingerprint': 'a' * 64,
        'capture_status': 'committed', 'capture_results': [{'scope': 'current_project',
            'personal_project_id': 'alpha', 'status': 'committed', 'episode_id': episode,
            'entity_ids': [entity], 'relationship_ids': []}]}))


async def claim(client, space_id, token):
    return ok(await client.post(f'/v1/task-contexts/{token}/turn-receipt/claim', json={
        'personal_space_id': space_id, 'source_application': 'codex'}))['deliver']


@pytest.mark.asyncio
async def test_a_turn_receipt_is_delivered_once_by_its_reply_or_else_by_the_next_entry():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        first, second, third, fourth = (f'fuli-task-{uuid4()}' for _ in range(4))
        await begin(client, space_id, first, 'turn-1')
        await complete(client, space_id, first, 'episode-1', 'entity-1')
        assert await claim(client, space_id, first) is True
        assert await claim(client, space_id, first) is True, 'a retry of the same reply shows it again'
        entry = await begin(client, space_id, second, 'turn-2')
        assert 'unread_turn_receipts' not in entry, 'already delivered by its own reply'
        # The reply of turn 2 never claimed its receipt. Turn 3's entry is told about
        # it but could not read it back, so it claims nothing and it stays unread.
        await complete(client, space_id, second, 'episode-2', 'entity-2')
        unreadable = await begin(client, space_id, third, 'turn-3')
        assert [item['capture_results'][0]['episode_id'] for item in unreadable['unread_turn_receipts']] == ['episode-2']
        # Turn 4's entry reads it back and claims it: shown once.
        late = await begin(client, space_id, fourth, 'turn-4')
        ids = [item['receipt_id'] for item in late['unread_turn_receipts']]
        assert ids == [item['receipt_id'] for item in unreadable['unread_turn_receipts']]
        assert await claim_unread(client, space_id, fourth, ids) == ids
        retried = await begin(client, space_id, fourth, 'turn-4')
        assert retried['unread_turn_receipts'] == late['unread_turn_receipts'], 'a retried entry gets the same'
        assert await claim_unread(client, space_id, fourth, ids) == ids
        assert await claim(client, space_id, second) is False, 'never shown twice'
        fifth = f'fuli-task-{uuid4()}'
        assert 'unread_turn_receipts' not in await begin(client, space_id, fifth, 'turn-5')
        assert await claim_unread(client, space_id, fifth, ids) == [], 'another entry cannot take it'


async def claim_unread(client, space_id, token, ids):
    return ok(await client.post(f'/v1/task-contexts/{token}/turn-receipts/claim-unread', json={
        'personal_space_id': space_id, 'source_application': 'codex', 'receipt_ids': ids}))['claimed']


@pytest.mark.asyncio
async def test_a_preference_can_belong_to_one_fla_and_then_applies_only_to_it():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client)
        await seed_agent(client, space_id)
        item_id = (await commit(client, space_id, [preference('fla', 'Synthetic reviewer habit')],
                                project='sample-project'))['entity_ids'][0]
        version = (await view(client, space_id, item_id))['version']
        assert (await move(client, space_id, item_id, 'agent', version=version, projects=['sample-project'],
                           agent='missing-agent')).status_code == 404
        moved = await move(client, space_id, item_id, 'agent', version=version, projects=['sample-project'],
                           agent='engineer')
        assert moved.status_code == 200, moved.text
        current = await view(client, space_id, item_id)
        assert (current['scope']['kind'], current['scope']['agent_id'], current['scope']['agent_name']) == (
            'agent', 'engineer', 'Synthetic engineer')
        await confirm(client, space_id, item_id)
        for_agent = ok(await client.get('/v1/collaboration-preferences', params={
            'personal_space_id': space_id, 'personal_project_id': 'sample-project', 'project_agent_id': 'engineer'}))
        assert item_id in {item['id'] for item in for_agent['effective_preferences']}
        assert item_id not in await applied(client, space_id, 'sample-project')


async def held_confirmed(client, space_id, key, text):
    scope_key = hashlib.sha256(f'synthetic-{key}'.encode()).hexdigest()
    temporary = ok(await client.post('/v1/temporary-projects/ensure', json={
        'personal_space_id': space_id, 'scope_key': scope_key, 'source_application': 'codex', 'lifetime': 'session'}))
    item_id = (await commit(client, space_id, [preference(key, text)], project=temporary['project_id'],
                            scope_status='undetermined'))['entity_ids'][0]
    await confirm(client, space_id, item_id)
    return item_id, (await view(client, space_id, item_id))['version']


@pytest.mark.asyncio
async def test_a_confirmed_held_item_is_placed_global_or_with_one_fla_by_the_person():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        await seed_agent(client, space_id)
        to_global, version = await held_confirmed(client, space_id, 'held-global', 'Synthetic held preference')
        assert (await move(client, space_id, to_global, 'global', version=version)).status_code == 200
        placed = await view(client, space_id, to_global)
        assert (placed['item_id'], placed['scope']['kind'], placed['scope']['status'], placed['confirmation_status']) == (
            to_global, 'global', 'set', 'confirmed')
        assert any(item['action'] == 'scope_change' for item in placed['revisions'])
        assert to_global in await applied(client, space_id, 'alpha')
        to_fla, version = await held_confirmed(client, space_id, 'held-fla', 'Synthetic held reviewer habit')
        assert (await move(client, space_id, to_fla, 'agent', version=version, projects=['sample-project'],
                           agent='engineer')).status_code == 200
        placed = await view(client, space_id, to_fla)
        assert (placed['scope']['kind'], placed['scope']['agent_id']) == ('agent', 'engineer')
        # Once placed it is in use: widening that place again goes through review.
        widened = await move(client, space_id, to_fla, 'global', version=placed['version'])
        assert widened.status_code == 409 and widened.json()['detail']['code'] == 'widening_requires_review'


@pytest.mark.asyncio
async def test_a_retried_entry_with_a_new_token_reads_and_claims_as_the_turns_saved_token():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        first, second = (f'fuli-task-{uuid4()}' for _ in range(2))
        await begin(client, space_id, first, 'turn-a')
        await complete(client, space_id, first, 'episode-a', 'entity-a')
        entry = await begin(client, space_id, second, 'turn-b')
        ids = [item['receipt_id'] for item in entry['unread_turn_receipts']]
        assert await claim_unread(client, space_id, entry['token'], ids) == ids
        # The host retries the same turn with a fresh random token: the Provider
        # returns the turn's saved token and the receipts that token claimed.
        retried = await begin(client, space_id, f'fuli-task-{uuid4()}', 'turn-b')
        assert retried['token'] == second
        assert [item['receipt_id'] for item in retried['unread_turn_receipts']] == ids
        assert await claim_unread(client, space_id, retried['token'], ids) == ids


@pytest.mark.asyncio
async def test_a_reply_and_an_entry_claiming_at_once_never_both_show_the_receipt():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        for round_number in range(4):
            reply, entry = f'fuli-task-{uuid4()}', f'fuli-task-{uuid4()}'
            await begin(client, space_id, reply, f'race-{round_number}')
            await complete(client, space_id, reply, f'episode-race-{round_number}', f'entity-race-{round_number}')
            unread = (await begin(client, space_id, entry, f'race-next-{round_number}'))['unread_turn_receipts']
            ids = [item['receipt_id'] for item in unread]
            own, other = await asyncio.gather(claim(client, space_id, reply), claim_unread(client, space_id, entry, ids))
            assert [own, bool(other)].count(True) == 1, (own, other)


@pytest.mark.asyncio
async def test_a_saved_turn_retried_as_a_duplicate_still_leaves_its_receipt_unread():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        token, nxt = f'fuli-task-{uuid4()}', f'fuli-task-{uuid4()}'
        await begin(client, space_id, token, 'turn-dup')
        ok(await client.put(f'/v1/task-contexts/{token}/checkpoint', json={
            'personal_space_id': space_id, 'source_application': 'codex', 'phase': 'complete',
            'disposition': 'capture_candidates', 'reason': 'Synthetic retry.', 'fingerprint': 'b' * 64,
            'capture_status': 'duplicate', 'capture_results': [{'scope': 'current_project',
                'personal_project_id': 'alpha', 'status': 'duplicate', 'episode_id': 'episode-dup',
                'entity_ids': ['entity-dup'], 'relationship_ids': []}]}))
        unread = (await begin(client, space_id, nxt, 'turn-dup-next'))['unread_turn_receipts']
        assert [item['capture_results'][0]['episode_id'] for item in unread] == ['episode-dup']


@pytest.mark.asyncio
async def test_a_project_tag_of_the_second_project_is_named_with_its_project_and_removable_there():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta')
        item_id = (await commit(client, space_id, [preference('two', 'Synthetic two-project preference')],
                                project='alpha'))['entity_ids'][0]
        version = (await view(client, space_id, item_id))['version']
        assert (await move(client, space_id, item_id, 'projects', version=version,
                           projects=['alpha', 'beta'])).status_code == 200
        created = ok(await client.post('/v1/knowledge-tags/create', json={
            'personal_space_id': space_id, 'personal_project_id': 'beta', 'name': 'beta-only', 'namespace': 'project',
            'reason': 'Synthetic tag.', 'operation_actor': 'human'}))
        link = {'personal_space_id': space_id, 'tag_id': created['tag']['id'], 'item_kind': 'entity',
                'item_id': item_id, 'operation_actor': 'human'}
        ok(await client.post('/v1/knowledge-tags/attach', json={**link, 'personal_project_id': 'beta'}))
        [tag] = (await view(client, space_id, item_id))['tags']
        assert (tag['namespace'], tag['project_id']) == ('project', 'beta')
        refused = await client.post('/v1/knowledge-tags/detach', json={**link, 'personal_project_id': 'alpha'})
        assert refused.status_code == 404, 'alpha cannot see beta\'s tag'
        ok(await client.post('/v1/knowledge-tags/detach', json={**link, 'personal_project_id': tag['project_id']}))
        assert (await view(client, space_id, item_id))['tags'] == []


@pytest.mark.asyncio
async def test_a_backlog_of_65_unread_receipts_drains_in_bounded_batches():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        for index in range(65):
            token = f'fuli-task-{uuid4()}'
            await begin(client, space_id, token, f'backlog-{index}')
            await complete(client, space_id, token, f'episode-backlog-{index}', f'entity-backlog-{index}')
        drained = []
        for batch in range(5):
            entry = await begin(client, space_id, f'fuli-task-{uuid4()}', f'backlog-entry-{batch}')
            ids = [item['receipt_id'] for item in entry.get('unread_turn_receipts', [])]
            assert len(ids) <= 20
            if ids:
                assert sorted(await claim_unread(client, space_id, entry['token'], ids)) == sorted(ids)
            drained.append(len(ids))
        assert drained == [20, 20, 20, 5, 0], 'each entry takes a bounded batch; the rest wait, none is lost'
