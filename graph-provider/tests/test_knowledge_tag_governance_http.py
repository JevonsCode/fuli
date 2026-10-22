"""The person's tag governance through the Provider routes on the in-memory port
(knowledge_tag_memory.py); test_knowledge_tags_neo4j.py runs the same scenarios
on a disposable Neo4j."""
import asyncio

import pytest

from fuli_graph.knowledge_tag_governance_models import MAX_SPLIT_LINKS
from knowledge_tag_governance_scenarios import GOVERNANCE_SCENARIOS, attach, detail, govern, mine, preview
from knowledge_tag_memory import memory_world
from knowledge_tag_scenarios import TAGS, alias, create


@pytest.mark.asyncio
@pytest.mark.parametrize('scenario', GOVERNANCE_SCENARIOS, ids=lambda scenario: scenario.__name__)
async def test_tag_governance_scenario(scenario):
    async with memory_world() as world:
        await scenario(world)


@pytest.mark.asyncio
async def test_a_restore_past_the_per_split_limit_goes_in_labelled_batches():
    """Dot P2-3: a merge that took more links than one split moves comes back in
    batches; each preview says how many remain, and the second batch continues
    on the tag the first one brought back."""
    async with memory_world() as world:
        await world.project('class')
        source = (await create(world, '户外学习', 'class'))['tag']
        target = await mine(world, '自然教育', 'class')
        items = [await world.item('class', f'Synthetic walk {index}') for index in range(MAX_SPLIT_LINKS + 1)]
        for item in items:
            await attach(world, source['id'], item, 'class')
        await govern(world, 'merge', source['id'], into_tag_id=target['id'])
        await alias(world, target['id'], '自然课', 'class', operation_actor='human', reason='later change')
        split = {'restore_tag_id': source['id']}
        first = await preview(world, 'split', target['id'], split=split)
        assert (first['revives'], first['links_moved'], first['links_remaining']) == (True, MAX_SPLIT_LINKS, 1)
        await govern(world, 'split', target['id'], split=split)
        # Dot round 3 P2-2: A is back, so it is no longer "merged in"; the detail says what is unfinished.
        page = await detail(world, target['id'])
        assert page['merged_from'] == []
        assert [(entry['tag']['id'], entry['remaining']) for entry in page['unfinished_restores']] == [
            (source['id'], 1)]
        second = await preview(world, 'split', target['id'], split=split)
        assert (second['revives'], second['links_moved'], second['links_remaining']) == (False, 1, 0)
        await govern(world, 'split', target['id'], split=split)
        assert all([await world.attached(item) == [source['id']] for item in items])
        assert (await detail(world, target['id']))['unfinished_restores'] == []


@pytest.mark.asyncio
async def test_an_attach_waiting_for_the_lock_rereads_the_item_and_never_tags_a_deleted_one():
    """The tag/assignment follow-up: the item is read under the space lock, so an
    attach queued behind a hard delete finds no item instead of leaving an orphan link."""
    async with memory_world() as world:
        await world.project('class')
        tag = (await create(world, '户外学习', 'class'))['tag']
        item = await world.item('class', 'Bird walk')
        async with world.vocabulary.lock:
            pending = asyncio.create_task(world.client.post(f'{TAGS}/attach', json={
                'personal_space_id': world.space, 'personal_project_id': 'class', 'tag_id': tag['id'], **item}))
            await asyncio.sleep(0.05)
            assert not pending.done(), 'the attach waits for the lock'
            # The hard delete commits while holding the lock.
            del world.vocabulary.items[(item['item_kind'], item['item_id'])]
        refused = await pending
        assert refused.status_code == 404, refused.text
        assert world.vocabulary.links == {}
