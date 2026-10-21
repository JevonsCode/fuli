"""D-20.7 against an explicitly disposable Neo4j: what a person's edit of a
basis means for the conclusions drawn from it. Synthetic data only; public
HTTP routes drive every write."""

import pytest

from test_knowledge_version_races_neo4j import confirmed_preference
from test_knowledge_versions_neo4j import edit
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import applied, commit, confirm, ok, preference, space_with_projects, view


async def chain(client, space_id):
    """A basis, a preference concluded from it, and one concluded from that."""
    basis = await confirmed_preference(client, space_id, 'docs', 'Docs in Markdown')
    conclusion = (await commit(client, space_id, [preference(
        'readme', 'Every README is Markdown', derived_from=[basis])]))['entity_ids'][0]
    await confirm(client, space_id, conclusion)
    follow = (await commit(client, space_id, [preference(
        'readme-lint', 'Lint every README with markdownlint', derived_from=[conclusion])]))['entity_ids'][0]
    await confirm(client, space_id, follow)
    return basis, conclusion, follow


async def revise(client, space_id, item_id, action, **fields):
    return await client.patch(f'/v1/knowledge/items/{item_id}', json={
        'personal_space_id': space_id, 'item_kind': 'entity', 'action': action, 'reason': 'Synthetic review.',
        'operation_actor': 'human', 'expected_version': (await view(client, space_id, item_id))['version'],
        **fields})


@pytest.mark.asyncio
async def test_an_edit_of_a_basis_changes_its_meaning_by_default_and_the_conclusions_wait_for_a_person():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        basis, conclusion, follow = await chain(client, space_id)
        assert (await view(client, space_id, basis))['dependent_count'] == 1
        assert (await view(client, space_id, follow))['dependent_count'] == 0
        edited = ok(await edit(client, space_id, basis, 'Docs in AsciiDoc',
                               version=(await view(client, space_id, basis))['version']))
        assert edited['dependents_changed'] == 2, 'the change runs down the chain'
        for item_id in (conclusion, follow):
            waiting = await view(client, space_id, item_id)
            # The gate is its own state: the person's confirmation is kept, and still nothing delivers it.
            assert (waiting['basis_review'], waiting['confirmation_status'], waiting['status']) == (
                'changed', 'confirmed', 'current')
            assert item_id not in await applied(client, space_id, 'alpha'), 'not delivered until reviewed'
        assert 'basis_changed' in {revision['action'] for revision in (await view(client, space_id, conclusion))[
            'revisions']}


@pytest.mark.asyncio
async def test_a_wording_only_edit_keeps_conclusions_delivered_with_a_hint_that_a_review_clears():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        basis, conclusion, follow = await chain(client, space_id)
        edited = ok(await revise(client, space_id, basis, 'update', name='Docs are written in Markdown',
                                 summary='Docs are written in Markdown', basis_meaning='wording_only'))
        new_basis = edited['version_item_id']
        hinted = await view(client, space_id, conclusion)
        assert (hinted['basis_review'], hinted['confirmation_status']) == ('reworded', 'confirmed')
        assert conclusion in await applied(client, space_id, 'alpha') and follow in await applied(client, space_id, 'alpha')
        assert (await view(client, space_id, follow))['basis_review'] is None, 'the hint is for direct conclusions'
        reviewed = ok(await revise(client, space_id, conclusion, 'reaffirm'))
        current = await view(client, space_id, reviewed['version_item_id'])
        assert current['basis_review'] is None
        assert [basis_ref['item_id'] for basis_ref in current['bases']] == [new_basis]


@pytest.mark.asyncio
async def test_still_holds_writes_a_new_version_on_the_new_basis_and_clears_what_waited_downstream():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        basis, conclusion, follow = await chain(client, space_id)
        new_basis = ok(await edit(client, space_id, basis, 'Docs in Markdown or AsciiDoc',
                                  version=(await view(client, space_id, basis))['version']))['version_item_id']
        reviewed = ok(await revise(client, space_id, conclusion, 'reaffirm'))
        assert reviewed['dependents_changed'] == 1
        current = await view(client, space_id, reviewed['version_item_id'])
        assert (current['confirmation_status'], current['basis_review']) == ('confirmed', None)
        assert [basis_ref['item_id'] for basis_ref in current['bases']] == [new_basis]
        assert reviewed['version_item_id'] in await applied(client, space_id, 'alpha')
        restored = await view(client, space_id, follow)
        assert (restored['basis_review'], restored['confirmation_status']) == (None, 'confirmed')
        assert follow in await applied(client, space_id, 'alpha')
        assert (await view(client, space_id, conclusion))['status'] == 'superseded', 'history is kept'
        nothing = await revise(client, space_id, reviewed['version_item_id'], 'reaffirm')
        assert nothing.status_code == 409 and nothing.json()['detail']['code'] == 'nothing_to_review'


@pytest.mark.asyncio
async def test_a_person_can_later_mark_from_a_version_record_that_the_meaning_changed():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        basis, conclusion, follow = await chain(client, space_id)
        ok(await revise(client, space_id, basis, 'update', name='Docs in Markdown files',
                        summary='Docs in Markdown files', basis_meaning='wording_only'))
        assert conclusion in await applied(client, space_id, 'alpha')
        # From the old version's record: it did change what the conclusions mean.
        remarked = ok(await revise(client, space_id, basis, 'mark_meaning_changed'))
        assert remarked['dependents_changed'] == 2
        assert (await view(client, space_id, conclusion))['basis_review'] == 'changed'
        assert (await view(client, space_id, follow))['basis_review'] == 'changed'
        assert conclusion not in await applied(client, space_id, 'alpha')


@pytest.mark.asyncio
async def test_an_agent_never_chooses_its_rewrite_waits_and_the_persons_confirmation_decides():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        basis, conclusion, _follow = await chain(client, space_id)
        version = (await view(client, space_id, basis))['version']
        for action, fields in [('update', {'name': 'x', 'summary': 'x', 'basis_meaning': 'wording_only'}),
                               ('reaffirm', {}), ('mark_meaning_changed', {})]:
            refused = await client.patch(f'/v1/knowledge/items/{basis}', json={
                'personal_space_id': space_id, 'item_kind': 'entity', 'action': action, 'reason': 'Agent.',
                'operation_actor': 'agent', 'expected_version': version, **fields})
            assert refused.status_code == 422, action
        rewrite = ok(await edit(client, space_id, basis, 'Docs in reStructuredText', version=version, actor='agent'))
        rewrite_id = rewrite['version_item_id']
        assert rewrite['dependents_changed'] == 0
        assert conclusion in await applied(client, space_id, 'alpha'), 'nothing changes until a person confirms'
        pending = await view(client, space_id, rewrite_id)
        assert pending['confirmation_status'] == 'pending' and pending['dependent_count'] == 1
        await confirm(client, space_id, rewrite_id)
        assert (await view(client, space_id, conclusion))['basis_review'] == 'changed', 'confirming defaults to changed'
        assert conclusion not in await applied(client, space_id, 'alpha')


@pytest.mark.asyncio
async def test_a_meaning_change_and_a_concurrent_derived_capture_share_one_boundary():
    import asyncio

    from test_knowledge_version_races_neo4j import commit_request, paused_at_lock, still_blocked

    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        basis = await confirmed_preference(client, space_id, 'docs', 'Docs in Markdown')
        version = (await view(client, space_id, basis))['version']
        with paused_at_lock() as (taken, release):
            capture = asyncio.create_task(client.post('/v1/knowledge/commits', json=commit_request(
                space_id, [preference('readme', 'Every README is Markdown', derived_from=[basis])])))
            await asyncio.wait_for(taken.wait(), 5)
            editing = asyncio.create_task(edit(client, space_id, basis, 'Docs in AsciiDoc', version=version))
            assert await still_blocked(editing), 'the edit waits for the capture'
            release.set()
            conclusion = ok(await capture)['entity_ids'][0]
            assert ok(await editing)['dependents_changed'] == 1
        assert (await view(client, space_id, conclusion))['basis_review'] == 'changed'
