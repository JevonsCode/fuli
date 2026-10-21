"""dot #268 round 4 against an explicitly disposable Neo4j: a conclusion captured
from a basis that waits for a review waits from birth (P1), and every way a
person reviews an item settles it the same way (P2). Synthetic data only;
public HTTP routes drive every write."""

import asyncio
from uuid import uuid4

import pytest

from test_knowledge_unresolved_bases_neo4j import changed, conclusion, found, revise
from test_knowledge_version_races_neo4j import confirmed_preference, paused_at_embedding
from test_knowledge_versions_neo4j import edit
from test_negative_feedback_block_neo4j import query, use
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import applied, commit, confirm, ok, preference, space_with_projects, view


async def waiting_basis(client, space_id):
    """A → B with A's meaning changed since, so B waits for a review."""
    a = await confirmed_preference(client, space_id, 'a', 'Docs in Markdown')
    b = (await commit(client, space_id, [preference('b', 'Every README is Markdown', derived_from=[a])]))['entity_ids'][0]
    await confirm(client, space_id, b)
    await changed(client, space_id, a, 'Docs in AsciiDoc')
    assert (await view(client, space_id, b))['basis_review'] == 'changed'
    return b


async def reasons(settings, item_id):
    rows = await query(settings, '''CALL { MATCH (item:Entity {uuid: $id}) RETURN item.fuli_unresolved_bases AS held
        UNION MATCH ()-[item:RELATES_TO {uuid: $id}]->() RETURN item.fuli_unresolved_bases AS held }
        RETURN held''', id=item_id)
    return rows[0]['held'] or []


async def assert_quarantined(client, space_id, item_id, text, kind):
    state = await view(client, space_id, item_id, kind)
    assert state['basis_review'] == 'changed', 'it waits from birth'
    assert 'basis_changed' in {revision['action'] for revision in state['revisions']}
    for index in range(4):
        await use(client, space_id, f'synthetic-task-{index % 3}', item_id, 'applied', kind)
    promoted = ok(await client.post('/v1/knowledge/usage', json={
        'personal_space_id': space_id, 'task_id': 'synthetic-task-new',
        'items': [{'item_id': item_id, 'item_kind': kind, 'use_kind': 'applied'}]}))
    assert promoted['promoted_count'] == 0
    assert (await view(client, space_id, item_id, kind))['confirmation_status'] == 'pending'
    assert item_id not in await found(client, space_id, text, include_pending=True)
    assert item_id not in await found(client, space_id, text, include_pending=False)


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['entity', 'relationship'])
async def test_p1_a_conclusion_captured_late_from_a_waiting_basis_waits_until_the_basis_is_reviewed(kind):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        b = await waiting_basis(client, space_id)
        text = f'Synthetic late {kind} {uuid4().hex[:8]}'
        c = await conclusion(client, space_id, 'late', text, [b], kind=kind)
        assert len(await reasons(settings, c)) == 1
        await assert_quarantined(client, space_id, c, text, kind)
        ok(await revise(client, space_id, b, 'reaffirm'))
        released = await view(client, space_id, c, kind)
        assert released['basis_review'] is None and await reasons(settings, c) == []
        assert c in await found(client, space_id, text, include_pending=True)


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['entity', 'relationship'])
async def test_p1_a_basis_that_starts_waiting_while_the_capture_embeds_is_inherited_under_the_lock(kind):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        a = await confirmed_preference(client, space_id, 'a', 'Docs in Markdown')
        b = (await commit(client, space_id, [preference('b', 'Every README is Markdown',
                                                        derived_from=[a])]))['entity_ids'][0]
        await confirm(client, space_id, b)
        text = f'Synthetic paused {kind} {uuid4().hex[:8]}'
        with paused_at_embedding(text) as (reached, release):
            capture = asyncio.create_task(conclusion(client, space_id, 'paused', text, [b], kind=kind))
            await asyncio.wait_for(reached.wait(), 5)
            await changed(client, space_id, a, 'Docs in AsciiDoc')
            release.set()
            c = await capture
        await assert_quarantined(client, space_id, c, text, kind)
        ok(await revise(client, space_id, b, 'reaffirm'))
        assert (await view(client, space_id, c, kind))['basis_review'] is None
        assert c in await found(client, space_id, text, include_pending=True)


async def confirm_rewrite(client, space_id, item_id, meaning):
    current = await view(client, space_id, item_id)
    return ok(await client.patch(f'/v1/knowledge/items/{item_id}', json={
        'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'confirm', 'reason': 'Synthetic review.',
        'confirmation_status': 'confirmed', 'operation_actor': 'human', 'expected_version': current['version'],
        'basis_meaning': meaning,
        'confirmation_basis': {'existence_reason': 'Synthetic.', 'quadrant_reason': 'Synthetic.',
                               'proposed_by': {'kind': 'agent', 'label': 'Codex'},
                               'confirmed_by': {'kind': 'user', 'label': 'Synthetic user'},
                               'confirmed_at': '2026-10-21T00:00:00Z'}}))


async def review_setup(client, space_id, own):
    """A → B → D, all confirmed; when `own`, A's meaning changed since, so B
    and D wait for that change."""
    a = await confirmed_preference(client, space_id, 'a', 'Docs in Markdown')
    b = (await commit(client, space_id, [preference('b', 'Every README is Markdown', derived_from=[a])]))['entity_ids'][0]
    await confirm(client, space_id, b)
    d = (await commit(client, space_id, [preference('d', 'README headings use #',
                                                    derived_from=[b])]))['entity_ids'][0]
    await confirm(client, space_id, d)
    if own:
        await changed(client, space_id, a, 'Docs in AsciiDoc')
    return b, d


@pytest.mark.asyncio
@pytest.mark.parametrize('meaning', ['wording_only', 'changed'])
@pytest.mark.parametrize('own', [True, False])
@pytest.mark.parametrize('path', ['edit', 'confirm_rewrite'])
async def test_p2_an_edit_or_a_confirmed_rewrite_is_a_review_that_settles_then_applies_its_meaning(path, own, meaning):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        b, d = await review_setup(client, space_id, own)
        assert len(await reasons(settings, d)) == (1 if own else 0), 'D waits for the same change as B'
        version = (await view(client, space_id, b))['version']
        if path == 'edit':
            reviewed = ok(await revise(client, space_id, b, 'update', name='Every README is plain Markdown',
                                       summary='Every README is plain Markdown',
                                       basis_meaning=meaning))['version_item_id']
        else:
            rewrite = ok(await edit(client, space_id, b, 'Every README is plain Markdown', version=version,
                                    actor='agent'))['version_item_id']
            assert len(await reasons(settings, rewrite)) == (1 if own else 0), "an Agent's rewrite keeps waiting"
            assert len(await reasons(settings, d)) == (1 if own else 0), 'and changes nothing below it'
            confirm_rewrite_result = await confirm_rewrite(client, space_id, rewrite, meaning)
            assert confirm_rewrite_result['action'] == 'confirm'
            reviewed = rewrite
        after = await view(client, space_id, reviewed)
        assert after['basis_review'] is None and await reasons(settings, reviewed) == [], 'its own reasons settled'
        assert reviewed in await applied(client, space_id, 'alpha')
        below = await view(client, space_id, d)
        held = await reasons(settings, d)
        if meaning == 'wording_only':
            assert held == [] and below['basis_review'] == 'reworded'
            assert d in await applied(client, space_id, 'alpha')
        else:
            assert len(held) == 1 and held[0].endswith(f'@{reviewed}'), 'only the new change waits'
            assert below['basis_review'] == 'changed' and d not in await applied(client, space_id, 'alpha')


@pytest.mark.asyncio
@pytest.mark.parametrize('own', [True, False])
async def test_p2_still_holds_settles_the_same_way_and_needs_something_to_review(own):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        b, d = await review_setup(client, space_id, own)
        response = await revise(client, space_id, b, 'reaffirm')
        if not own:
            assert response.status_code == 409 and response.json()['detail']['code'] == 'nothing_to_review'
            return
        reviewed = ok(response)['version_item_id']
        assert await reasons(settings, reviewed) == [] and await reasons(settings, d) == []
        assert (await view(client, space_id, d))['basis_review'] is None, 'no new change, so no hint'
        assert {reviewed, d} <= await applied(client, space_id, 'alpha')


@pytest.mark.asyncio
async def test_p2_a_persons_confirmation_of_a_waiting_conclusion_is_its_review_and_settles_below_it():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        b = await waiting_basis(client, space_id)
        c = (await commit(client, space_id, [preference('c', 'README badges at the top',
                                                        derived_from=[b])]))['entity_ids'][0]
        e = (await commit(client, space_id, [preference('e', 'One badge per CI job',
                                                        derived_from=[c])]))['entity_ids'][0]
        assert len(await reasons(settings, c)) == 1 and len(await reasons(settings, e)) == 1
        graph = ok(await client.get(f'/v1/spaces/{space_id}/graph', params={'limit': 500}))
        assert {node['id']: node['waits_for_review'] for node in graph['nodes']}[c] is True
        await confirm(client, space_id, c)
        assert await reasons(settings, c) == [] and await reasons(settings, e) == []
        assert (await view(client, space_id, c))['basis_review'] is None
        assert c in await applied(client, space_id, 'alpha')
        assert (await view(client, space_id, b))['basis_review'] == 'changed', 'B still waits for its own review'


@pytest.mark.asyncio
async def test_p2_confirming_in_a_batch_is_the_same_review():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        b = await waiting_basis(client, space_id)
        key = f'batch-{uuid4()}'
        saved = await commit(client, space_id, [preference('c1', 'README badges at the top', derived_from=[b]),
                                                preference('c2', 'README links at the end', derived_from=[b])],
                             key=key)
        ids, episode = saved['entity_ids'], saved['episode_id']
        assert all([await reasons(settings, item_id) for item_id in ids])
        ok(await client.post('/v1/knowledge/batch-confirmations', json={
            'personal_space_id': space_id, 'group_kind': 'source', 'group_value': episode,
            'reason': 'Synthetic batch review.', 'operation_actor': 'human',
            'confirmer': {'kind': 'user', 'label': 'Synthetic user'},
            'items': [{'item_id': item_id, 'item_kind': 'entity', 'existence_reason': 'Synthetic.',
                       'quadrant_reason': 'Synthetic.', 'proposed_by': {'kind': 'agent', 'label': 'Codex'}}
                      for item_id in ids]}))
        for item_id in ids:
            assert await reasons(settings, item_id) == []
            assert (await view(client, space_id, item_id))['basis_review'] is None
        assert set(ids) <= await applied(client, space_id, 'alpha')
