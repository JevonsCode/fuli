"""dot #268 round 3 against an explicitly disposable Neo4j: the unresolved-basis
gate (P1-1), unresolved reasons per basis and change (P1-2), and successors
that keep a version history (P1-3). Synthetic data only; public HTTP routes
drive every write."""

import json
from uuid import uuid4

import pytest

from test_knowledge_version_races_neo4j import confirmed_preference
from test_knowledge_versions_neo4j import edit
from test_negative_feedback_block_neo4j import use
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import applied, commit, confirm, ok, preference, space_with_projects, view


async def revise(client, space_id, item_id, action, kind='entity', **fields):
    return await client.patch(f'/v1/knowledge/items/{item_id}', json={
        'personal_space_id': space_id, 'item_kind': kind, 'action': action, 'reason': 'Synthetic review.',
        'operation_actor': 'human', 'expected_version': (await view(client, space_id, item_id, kind))['version'],
        **fields})


async def reworded(client, space_id, item_id, text):
    return ok(await revise(client, space_id, item_id, 'update', name=text, summary=text,
                           basis_meaning='wording_only'))['version_item_id']


async def changed(client, space_id, item_id, text):
    return ok(await revise(client, space_id, item_id, 'update', name=text, summary=text))['version_item_id']


async def found(client, space_id, text, *, include_pending):
    response = ok(await client.post('/v1/search', json={
        'space_ids': [space_id], 'query': text, 'limit': 20, 'personal_project_ids': ['alpha'],
        'active_personal_project_id': 'alpha', 'include_pending': include_pending}))
    return json.dumps(response, ensure_ascii=False)


async def conclusion(client, space_id, key, text, bases, *, kind='entity'):
    if kind == 'entity':
        return (await commit(client, space_id, [{'key': key, 'name': text, 'type': 'ProjectFact', 'summary': text,
                                                 'derived_from': bases}], project='alpha'))['entity_ids'][0]
    saved = await commit(client, space_id, [{'key': f'{key}-a', 'name': f'{key} source', 'type': 'Thing'},
                                            {'key': f'{key}-b', 'name': f'{key} target', 'type': 'Thing'}],
                         project='alpha', relationships=[{'key': key, 'source': f'{key}-a', 'target': f'{key}-b',
                                                          'type': 'USES', 'fact': text, 'derived_from': bases}])
    return saved['relationship_ids'][0]


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['entity', 'relationship'])
async def test_p1_1_a_conclusion_waiting_for_review_is_neither_found_recalled_nor_promoted_by_use(kind):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        basis = await confirmed_preference(client, space_id, 'docs', 'Docs in Markdown')
        text = f'Synthetic {kind} conclusion {uuid4().hex[:8]}'
        item_id = await conclusion(client, space_id, 'readme', text, [basis], kind=kind)
        for index in range(4):  # one use short of the Agent usage policy
            await use(client, space_id, f'synthetic-task-{index % 3}', item_id, 'applied', kind)
        assert item_id in await found(client, space_id, text, include_pending=True)
        await changed(client, space_id, basis, 'Docs in AsciiDoc')
        waiting = await view(client, space_id, item_id, kind)
        assert waiting['basis_review'] == 'changed'
        promoted = ok(await client.post('/v1/knowledge/usage', json={
            'personal_space_id': space_id, 'task_id': 'synthetic-task-new',
            'items': [{'item_id': item_id, 'item_kind': kind, 'use_kind': 'applied'}]}))
        assert promoted['promoted_count'] == 0, 'earlier uses and one new use do not promote it'
        assert (await view(client, space_id, item_id, kind))['confirmation_status'] == 'pending'
        # Automatic recall searches with pending candidates included and falls
        # back to them: neither path delivers it.
        assert item_id not in await found(client, space_id, text, include_pending=True)
        assert item_id not in await found(client, space_id, text, include_pending=False)
        graph = ok(await client.get(f'/v1/spaces/{space_id}/graph', params={'limit': 500}))
        assert item_id in json.dumps(graph), 'the console still shows it'


@pytest.mark.asyncio
async def test_p1_1_a_confirmed_preference_waiting_for_review_is_not_delivered_until_reviewed():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        basis = await confirmed_preference(client, space_id, 'docs', 'Docs in Markdown')
        derived = (await commit(client, space_id, [preference('readme', 'Every README is Markdown',
                                                              derived_from=[basis])]))['entity_ids'][0]
        await confirm(client, space_id, derived)
        await changed(client, space_id, basis, 'Docs in AsciiDoc')
        state = await view(client, space_id, derived)
        assert (state['confirmation_status'], state['basis_review']) == ('confirmed', 'changed')
        assert derived not in await applied(client, space_id, 'alpha')
        reviewed = ok(await revise(client, space_id, derived, 'reaffirm'))['version_item_id']
        assert reviewed in await applied(client, space_id, 'alpha')


@pytest.mark.asyncio
async def test_p1_2_two_roots_keep_both_reasons_and_a_later_wording_edit_clears_neither():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        a = await confirmed_preference(client, space_id, 'a', 'Basis A')
        b = await confirmed_preference(client, space_id, 'b', 'Basis B')
        c = (await commit(client, space_id, [preference('c', 'Conclusion C', derived_from=[a, b])]))['entity_ids'][0]
        await confirm(client, space_id, c)
        a2 = await changed(client, space_id, a, 'Basis A, second meaning')
        await changed(client, space_id, b, 'Basis B, second meaning')
        await reworded(client, space_id, a2, 'Basis A, second meaning, reworded')
        waiting = await view(client, space_id, c)
        assert waiting['basis_review'] == 'changed', 'a wording edit never erases a meaning change'
        assert c not in await applied(client, space_id, 'alpha')
        assert sum(revision['action'] == 'basis_changed' for revision in waiting['revisions']) == 2


@pytest.mark.asyncio
async def test_p1_2_a_diamond_settles_only_when_every_path_for_the_change_was_reviewed():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        x = await confirmed_preference(client, space_id, 'x', 'Basis X')
        items = {}
        for key, bases in [('b', ['x']), ('c', ['x']), ('d', ['b', 'c']), ('e', ['d'])]:
            names = [x if base == 'x' else items[base] for base in bases]
            items[key] = (await commit(client, space_id, [preference(key, f'Conclusion {key}',
                                                                     derived_from=names)]))['entity_ids'][0]
            await confirm(client, space_id, items[key])
        assert ok(await revise(client, space_id, x, 'update', name='Basis X changed',
                               summary='Basis X changed'))['dependents_changed'] == 4
        ok(await revise(client, space_id, items['b'], 'reaffirm'))
        for key in ('d', 'e'):
            still = await view(client, space_id, items[key])
            assert still['basis_review'] == 'changed', f'{key} waits for the path through c'
            assert items[key] not in await applied(client, space_id, 'alpha')
        ok(await revise(client, space_id, items['c'], 'reaffirm'))
        for key in ('d', 'e'):
            settled = await view(client, space_id, items[key])
            assert settled['basis_review'] is None, key
            assert items[key] in await applied(client, space_id, 'alpha')


@pytest.mark.asyncio
async def test_p1_2_a_review_settles_only_the_changes_it_reviewed():
    """D rests on C (which rests on A) and on E. C's review settles A's change
    below C; E's change still holds D."""
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        a = await confirmed_preference(client, space_id, 'a', 'Basis A')
        e = await confirmed_preference(client, space_id, 'e', 'Basis E')
        c = (await commit(client, space_id, [preference('c', 'Conclusion C', derived_from=[a])]))['entity_ids'][0]
        await confirm(client, space_id, c)
        d = (await commit(client, space_id, [preference('d', 'Conclusion D', derived_from=[c, e])]))['entity_ids'][0]
        await confirm(client, space_id, d)
        await changed(client, space_id, a, 'Basis A changed')
        await changed(client, space_id, e, 'Basis E changed')
        ok(await revise(client, space_id, c, 'reaffirm'))
        still = await view(client, space_id, d)
        assert still['basis_review'] == 'changed', "E's change still waits after C's review"
        assert sum(revision['action'] == 'basis_review_cleared' for revision in still['revisions']) == 1
        assert d not in await applied(client, space_id, 'alpha')
        reviewed = ok(await revise(client, space_id, d, 'reaffirm'))['version_item_id']
        assert reviewed in await applied(client, space_id, 'alpha')


@pytest.mark.asyncio
async def test_p1_3_a_relationship_a_capture_superseded_stays_history():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        endpoints = [{'key': 'svc', 'name': 'Service', 'type': 'System'}, {'key': 'port', 'name': 'Port', 'type': 'Setting'}]
        relation = {'key': 'listens', 'source': 'svc', 'target': 'port', 'type': 'LISTENS_ON'}
        old = (await commit(client, space_id, endpoints, project='alpha',
                            relationships=[{**relation, 'fact': 'Service listens on 8080'}]))['relationship_ids'][0]
        await commit(client, space_id, endpoints, project='alpha', relationships=[{
            **relation, 'key': 'listens-v2', 'fact': 'Service listens on 9090', 'supersedes': ['listens'],
            'valid_at': '2026-10-22T00:00:00Z'}])
        history = await view(client, space_id, old, 'relationship')
        assert history['status'] == 'superseded'
        assert 'supersede' in {revision['action'] for revision in history['revisions']}
        for action, code in [('restore', 'reassert_as_new_version'), ('invalidate', 'lifecycle_final'),
                             ('restore', 'reassert_as_new_version')]:
            response = await revise(client, space_id, old, action, 'relationship')
            assert response.status_code == 409 and response.json()['detail']['code'] == code, action
        assert (await view(client, space_id, old, 'relationship'))['status'] == 'superseded'


@pytest.mark.asyncio
async def test_p1_3_a_deactivated_item_edited_into_a_new_version_cannot_be_restored_beside_it():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        item_id = await confirmed_preference(client, space_id, 'tone', 'Keep a calm tone')
        ok(await revise(client, space_id, item_id, 'invalidate'))
        new_id = ok(await edit(client, space_id, item_id, 'Keep a calm, direct tone',
                               version=(await view(client, space_id, item_id))['version']))['version_item_id']
        for action, code in [('restore', 'reassert_as_new_version'), ('invalidate', 'lifecycle_final'),
                             ('restore', 'reassert_as_new_version')]:
            response = await revise(client, space_id, item_id, action)
            assert response.status_code == 409 and response.json()['detail']['code'] == code, action
        assert await applied(client, space_id, 'alpha') >= {new_id}
        assert item_id not in await applied(client, space_id, 'alpha'), 'one current version'
