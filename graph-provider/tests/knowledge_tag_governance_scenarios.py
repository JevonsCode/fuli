"""The person's tag governance (rec#5 G4-5, rec#11 D-07 part 2), driven only
through the Provider routes. The same scenarios run on the in-memory port and
on a disposable Neo4j. Synthetic data only.
"""
import asyncio
import random
import string

from knowledge_tag_scenarios import REVIEW, TAGS, alias, create, post, resolve

GOVERNED = ('status', 'merged_into_id', 'aliases', 'alias_keys', 'alias_statuses', 'proposed_aliases',
            'proposed_alias_keys', 'parent_ids', 'related_ids')
LINKED = ('tag_id', 'status', 'attached_at', 'attached_by_kind', 'detached_at', 'detached_by_kind',
          'moved_to_tag_id', 'moved_from_tag_id')
REASON = 'Synthetic: the person decided in the console.'


async def preview(world, change, tag_id, project=None, all_projects=True, status=200, **fields):
    return await post(world, 'governance/preview', {
        'personal_project_id': project, 'change': change, 'tag_id': tag_id,
        'include_all_projects': all_projects, **fields}, status)


async def govern(world, change, tag_id, project=None, status=200, headers=REVIEW, **fields):
    """What the console does: preview, then apply naming that preview's digest."""
    shown = await preview(world, change, tag_id, project, **fields)
    return await post(world, 'governance/apply', {
        'personal_project_id': project, 'change': change, 'tag_id': tag_id, 'include_all_projects': True,
        'reason': REASON, 'preview_digest': shown['digest'], **fields}, status, headers=headers)


async def vocabulary(world, project=None, all_projects=True, **filters):
    return await post(world, 'vocabulary', {'personal_project_id': project,
                                            'include_all_projects': all_projects, **filters})


async def detail(world, tag_id, project=None, all_projects=True, status=200):
    return await post(world, 'detail', {'personal_project_id': project, 'tag_id': tag_id,
                                        'include_all_projects': all_projects}, status)


async def attach(world, tag_id, item, project, status=200):
    return await post(world, 'attach', {'personal_project_id': project, 'tag_id': tag_id, **item}, status)


async def mine(world, name, project=None, **options):
    """The person's own tag, active at once."""
    body = {'namespace': 'personal'} if project is None else {}
    return (await create(world, name, project, operation_actor='human', reason='mine', **body, **options))['tag']


async def fresh(world, name):
    """The person's new personal tag, judged different from any similar one."""
    seen = []
    while True:
        created = await create(world, name, operation_actor='human', reason='mine', namespace='personal',
                               distinct_from=seen)
        if created['tag'] is not None:
            return created['tag']
        seen += [candidate['id'] for candidate in created['candidates']]


def governed(tags):
    return {tag_id: {field: tag.get(field) or ([] if field.endswith(('s', '_ids', '_keys')) else None)
                     for field in GOVERNED} for tag_id, tag in tags.items()}


def linked(links):
    return {link_id: {field: link.get(field) for field in LINKED} for link_id, link in links.items()}


async def merge_redirects_and_never_resolves_again(world):
    """Merging A into B leaves A merged with a redirect: its ID and words lead to B, links move without
    duplicates, and A never resolves, merges or is created as a live tag again."""
    await world.project('class')
    source = (await create(world, '户外学习', 'class', description='户外开展的学习活动'))['tag']
    assert (await alias(world, source['id'], '野外课', 'class'))['outcome'] == 'added'
    target = await mine(world, '自然观察')
    walk, rubbing = await world.item('class', 'Bird walk'), await world.item('class', 'Leaf rubbing')
    for tag, item in ((source, walk), (source, rubbing), (target, rubbing)):
        await attach(world, tag['id'], item, 'class')

    shown = await preview(world, 'merge', source['id'], into_tag_id=target['id'])
    assert (shown['blocked'], shown['status_after'], shown['other']['id'], shown['links_moved'],
            shown['links_already_on_target']) == (None, 'merged', target['id'], 1, 1)
    merged = await govern(world, 'merge', source['id'], into_tag_id=target['id'])
    assert {tag['id']: tag['status'] for tag in merged['tags']} == {source['id']: 'merged', target['id']: 'active'}

    for word in ('户外学习', ' 野外课 '):
        found = await resolve(world, word, 'class')
        keyed = [(item['id'], item['redirected_from']) for item in found if item['match'] != 'similar']
        assert keyed == [(target['id'], source['id'])], found
        assert source['id'] not in [item['id'] for item in found]
    again = await create(world, '户外学习', 'class')
    assert (again['outcome'], again['tag']['id']) == ('existing', target['id'])
    refused = await create(world, '户外学习', 'class', distinct_from=[target['id']], status=409)
    assert refused['detail']['code'] == 'tag_merged'
    assert refused['detail']['tag']['id'] == target['id']

    pond = await world.item('class', 'Pond dip')
    redirected = await attach(world, source['id'], pond, 'class')
    assert (redirected['outcome'], redirected['redirected_to']['id']) == ('attached', target['id'])
    assert [tag['id'] for tag in redirected['tags']] == [target['id']]
    for item in (walk, rubbing, pond):
        assert await world.attached(item) == [target['id']], 'one link per item, on the merged-into tag'

    for change, fields in (('merge', {'into_tag_id': target['id']}), ('approve', {}), ('retire', {})):
        blocked = (await preview(world, change, source['id'], **fields))['blocked']
        assert blocked and blocked['code'] in {'not_live', 'not_provisional'}
    await govern(world, 'merge', source['id'], status=409, into_tag_id=target['id'])
    info = await detail(world, source['id'])
    assert (info['tag']['status'], info['tag']['merged_into']['id']) == ('merged', target['id'])
    assert [tag['id'] for tag in (await detail(world, target['id']))['merged_from']] == [source['id']]
    other = (await create(world, '观鸟', 'class'))['tag']
    assert (await alias(world, other['id'], '野外课', 'class'))['outcome'] == 'conflict'


async def merge_then_undo_restores_exactly(world):
    """Undo restores every tag field and link record the merge wrote, from its revision."""
    await world.project('class')
    parent = await mine(world, '教学方法')
    source = (await create(world, '户外学习', 'class'))['tag']
    child = (await create(world, '湿地观察', 'class'))['tag']
    related = (await create(world, '自然笔记', 'class'))['tag']
    target = await mine(world, '自然教育')
    await alias(world, source['id'], '野外课', 'class')
    await alias(world, target['id'], 'nature education', 'class')
    for tag_id, relation, other in ((source['id'], 'parent', parent['id']), (child['id'], 'parent', source['id']),
                                    (source['id'], 'related', related['id'])):
        await govern(world, 'relate', tag_id, relation=relation, target_tag_id=other)
    walk, rubbing = await world.item('class', 'Bird walk'), await world.item('class', 'Leaf rubbing')
    for tag, item in ((source, walk), (source, rubbing), (target, rubbing)):
        await attach(world, tag['id'], item, 'class')
    before_tags, before_links = await world.stored()

    await govern(world, 'merge', source['id'], into_tag_id=target['id'])
    carried = (await detail(world, target['id']))
    assert [tag['id'] for tag in carried['tag']['parents']] == [parent['id']]
    assert [tag['id'] for tag in carried['tag']['related']] == [related['id']]
    assert [tag['id'] for tag in carried['children']] == [child['id']]

    history = (await detail(world, target['id']))['history']
    merge_in = next(entry for entry in history if entry['action'] == 'merge_in')
    assert merge_in['undoable'] and not merge_in['undone']
    shown = await preview(world, 'undo', target['id'], operation_id=merge_in['operation_id'])
    assert (shown['undo']['action'], shown['blocked']) == ('merge', None)
    assert {tag['id'] for tag in shown['undo']['restores']} == {source['id'], target['id'], child['id'],
                                                                 related['id']}
    await govern(world, 'undo', target['id'], operation_id=merge_in['operation_id'])

    after_tags, after_links = await world.stored()
    assert governed(after_tags) == governed(before_tags)
    assert {link_id: value for link_id, value in linked(after_links).items() if link_id in before_links} == \
        linked(before_links)
    assert {link['status'] for link_id, link in after_links.items() if link_id not in before_links} == {'detached'}
    assert all(after_tags[tag_id]['version'] > before_tags[tag_id]['version']
               for tag_id in (source['id'], target['id'])), 'history grows; nothing is rewound'
    found = await resolve(world, '户外学习', 'class')
    assert [(item['id'], item['match'], item['redirected_from']) for item in found if item['match'] == 'exact'] == [
        (source['id'], 'exact', None)]
    for item in (walk, rubbing):
        assert await world.attached(item) == sorted(
            [source['id']] + ([target['id']] if item == rubbing else []))

    entries = {entry['operation_id']: entry for entry in (await detail(world, source['id']))['history']
               if entry['action'] == 'merge'}
    assert [(entry['undone'], entry['undoable']) for entry in entries.values()] == [(True, False)]
    blocked = await preview(world, 'undo', source['id'], operation_id=merge_in['operation_id'])
    assert blocked['blocked']['code'] == 'already_undone'
    assert (await govern(world, 'undo', target['id'], status=409,
                         operation_id=merge_in['operation_id']))['detail']['code'] == 'already_undone'


async def split_moves_the_chosen_aliases_and_links(world):
    """Split moves chosen aliases and links to a new tag; the rest stays; undo retires the new tag."""
    await world.project('class')
    source = await mine(world, '户外学习', 'class')
    for word in ('field class', '野外课'):
        await alias(world, source['id'], word, 'class', operation_actor='human', reason='mine')
    items = [await world.item('class', name) for name in ('Bird walk', 'Leaf rubbing', 'Pond dip')]
    for item in items:
        await attach(world, source['id'], item, 'class')
    split = {'name': '野外教学', 'description': '野外的教学安排', 'aliases': ['野外课'],
             'links': items[:2]}
    shown = await preview(world, 'split', source['id'], split=split)
    assert (shown['blocked'], shown['new_tag_name'], shown['revives'], shown['links_moved'],
            shown['aliases']) == (None, '野外教学', False, 2, ['野外课'])
    result = await govern(world, 'split', source['id'], split=split)
    created = next(tag for tag in result['tags'] if tag['id'] != source['id'])
    assert (created['name'], created['status'], created['namespace']) == ('野外教学', 'active', 'project')
    assert [await world.attached(item) for item in items] == [[created['id']], [created['id']], [source['id']]]
    tags = (await vocabulary(world))['tags']
    shapes = {tag['id']: (tag['aliases'], tag['linked_items']) for tag in tags
              if tag['id'] in (created['id'], source['id'])}
    assert shapes == {created['id']: (['野外课'], 2), source['id']: (['field class'], 1)}
    found = await resolve(world, '野外课', 'class')
    assert [(item['id'], item['match']) for item in found if item['match'] == 'alias'] == [(created['id'], 'alias')]
    moved = (await detail(world, created['id']))['links']
    assert {link['moved_from']['id'] for link in moved} == {source['id']}

    for refused in ({**split, 'name': '户外学习'}, {**split, 'aliases': ['not here']},
                    {**split, 'name': '另一个', 'links': [{'item_kind': 'entity', 'item_id': 'missing'}]},
                    {'name': '空的拆分'}):
        assert (await preview(world, 'split', source['id'], split=refused))['blocked'] is not None

    await govern(world, 'undo', source['id'])
    assert [await world.attached(item) for item in items] == [[source['id']]] * 3
    restored = (await vocabulary(world, query='野外', status='retired'))['tags']
    assert [(tag['id'], tag['status']) for tag in restored] == [(created['id'], 'retired')]
    found = await resolve(world, '野外课', 'class')
    assert [item['id'] for item in found if item['match'] == 'alias'] == [source['id']]


async def a_mistaken_merge_is_split_back(world):
    """G4-5: when undo is blocked by a later change, splitting the merged tag's name back revives the
    merged tag with its own ID and moves the original references back to it."""
    await world.project('copy')
    concise = (await create(world, '表达简洁', 'copy', description='用词简洁'))['tag']
    no_explanation = await mine(world, '不提供解释', 'copy')
    items = [await world.item('copy', name) for name in ('Headline', 'Summary')]
    await attach(world, concise['id'], items[0], 'copy')
    await attach(world, no_explanation['id'], items[1], 'copy')
    await govern(world, 'merge', concise['id'], into_tag_id=no_explanation['id'])
    await alias(world, no_explanation['id'], '只给结论', 'copy', operation_actor='human', reason='later change')
    blocked = await preview(world, 'undo', concise['id'])
    assert blocked['blocked']['code'] == 'changed_since'

    moved_here = [link for link in (await detail(world, no_explanation['id']))['links']
                  if (link['moved_from'] or {}).get('id') == concise['id']]
    split = {'name': '表达简洁', 'links': [{'item_kind': link['item_kind'], 'item_id': link['item_id']}
                                       for link in moved_here]}
    shown = await preview(world, 'split', no_explanation['id'], split=split)
    assert (shown['revives'], shown['other']['id'], shown['links_moved']) == (True, concise['id'], 1)
    await govern(world, 'split', no_explanation['id'], split=split)
    assert [await world.attached(item) for item in items] == [[concise['id']], [no_explanation['id']]]
    found = await resolve(world, '表达简洁', 'copy')
    assert [(item['id'], item['redirected_from']) for item in found if item['match'] == 'exact'] == [
        (concise['id'], None)]
    assert (await detail(world, concise['id']))['tag']['status'] == 'active'


async def parent_cycles_and_cross_scope_relations_are_refused(world):
    """Parents never form a cycle; scopes stay compatible; a merge drops a relation it cannot carry."""
    for project in ('alpha', 'beta'):
        await world.project(project)
    root, middle, leaf = [await mine(world, name) for name in ('写作', '小说', '短篇')]
    await govern(world, 'relate', middle['id'], relation='parent', target_tag_id=root['id'])
    await govern(world, 'relate', leaf['id'], relation='parent', target_tag_id=middle['id'])
    for tag_id, target_id, code in ((root['id'], leaf['id'], 'parent_cycle'), (root['id'], root['id'], 'self'),
                                    (leaf['id'], middle['id'], 'unchanged')):
        shown = await preview(world, 'relate', tag_id, relation='parent', target_tag_id=target_id)
        assert shown['blocked']['code'] == code, shown
        refused = await govern(world, 'relate', tag_id, status=409, relation='parent', target_tag_id=target_id)
        assert refused['detail']['code'] == code
    alpha = (await create(world, 'alpha 文案', 'alpha'))['tag']
    beta = (await create(world, 'beta 文案', 'beta'))['tag']
    assert (await preview(world, 'relate', root['id'], relation='parent', target_tag_id=alpha['id'])
            )['blocked']['code'] == 'scope'
    assert (await preview(world, 'relate', alpha['id'], relation='related', target_tag_id=beta['id'])
            )['blocked']['code'] == 'scope'
    assert (await preview(world, 'merge', alpha['id'], into_tag_id=beta['id']))['blocked']['code'] == 'scope'
    related = await govern(world, 'relate', alpha['id'], relation='related', target_tag_id=root['id'])
    assert {tag['id'] for tag in related['tags']} == {alpha['id'], root['id']}
    assert [tag['id'] for tag in (await detail(world, root['id']))['tag']['related']] == [alpha['id']]

    # leaf's parent is middle, middle's is root: merging root into leaf would make
    # middle a child of leaf and leaf a child of middle, so that relation is dropped.
    shown = await preview(world, 'merge', root['id'], into_tag_id=leaf['id'])
    assert [(drop['tag']['id'], drop['target']['id'], drop['reason']) for drop in shown['relations_dropped']] == [
        (middle['id'], leaf['id'], 'cycle')]
    await govern(world, 'merge', root['id'], into_tag_id=leaf['id'])
    assert (await detail(world, middle['id']))['tag']['parents'] == []
    assert [tag['id'] for tag in (await detail(world, leaf['id']))['tag']['parents']] == [middle['id']]
    unrelated = await govern(world, 'unrelate', leaf['id'], relation='parent', target_tag_id=middle['id'])
    assert unrelated['preview']['change'] == 'unrelate'
    assert (await detail(world, leaf['id']))['tag']['parents'] == []


async def a_merge_racing_an_attach_lands_once_on_the_target(world):
    """Concurrent merge and attach: whichever wins the lock, the item ends with one link, on B."""
    for attempt in range(4):
        project = f'race-{attempt}'
        await world.project(project)
        source = (await create(world, f'户外学习{attempt}', project))['tag']
        target = await mine(world, f'自然教育{attempt}', project)
        item = await world.item(project, f'Synthetic walk {attempt}')
        shown = await preview(world, 'merge', source['id'], into_tag_id=target['id'])
        applied, attached = await asyncio.gather(
            world.client.post(f'{TAGS}/governance/apply', headers=REVIEW, json={
                'personal_space_id': world.space, 'change': 'merge', 'tag_id': source['id'],
                'into_tag_id': target['id'], 'include_all_projects': True, 'reason': REASON,
                'preview_digest': shown['digest']}),
            world.client.post(f'{TAGS}/attach', json={
                'personal_space_id': world.space, 'personal_project_id': project, 'tag_id': source['id'], **item}))
        assert attached.status_code == 200, attached.text
        if applied.status_code == 409:
            # The attach came first and changed what the merge moves: the person checks again.
            assert applied.json()['detail']['code'] == 'preview_stale'
            assert applied.json()['detail']['preview']['links_moved'] == 1
            await govern(world, 'merge', source['id'], into_tag_id=target['id'])
        else:
            assert applied.status_code == 200, applied.text
        assert await world.attached(item) == [target['id']]
        assert (await detail(world, source['id']))['tag']['status'] == 'merged'


async def an_agent_can_preview_but_never_govern(world):
    """Without the human-review proof: approve, merge, split, undo and retire are refused, and so is
    any write claimed as the person's own; nothing changes."""
    await world.project('class')
    draft = (await create(world, '户外学习', 'class'))['tag']
    target = await mine(world, '自然教育')
    item = await world.item('class', 'Bird walk')
    await attach(world, draft['id'], item, 'class')
    await govern(world, 'relate', draft['id'], relation='parent', target_tag_id=target['id'])
    before = await world.stored()
    changes = [('approve', {}), ('merge', {'into_tag_id': target['id']}), ('retire', {}), ('undo', {}),
               ('split', {'split': {'name': '野外教学', 'links': [item]}})]
    for change, fields in changes:
        shown = await preview(world, change, draft['id'], 'class', all_projects=False, **fields)
        assert shown['blocked'] is None and len(shown['digest']) == 64, (change, shown)
        for headers in ({}, {'x-fuli-human-review-token': 'synthetic-wrong-review-token-000000000000'}):
            refused = await post(world, 'governance/apply', {
                'personal_project_id': 'class', 'change': change, 'tag_id': draft['id'], 'reason': REASON,
                'preview_digest': shown['digest'], **fields}, 403, headers=headers)
            assert refused['detail'] == 'independent human review proof required'
    for operation, body in (('create', {'name': '我的标签', 'namespace': 'personal', 'reason': 'claim'}),
                            ('aliases', {'tag_id': draft['id'], 'alias': '野外课', 'reason': 'claim'}),
                            ('attach', {'tag_id': target['id'], **item}),
                            ('detach', {'tag_id': draft['id'], **item})):
        await post(world, operation, {'personal_project_id': 'class', 'operation_actor': 'human', **body}, 403,
                   headers={})
    assert await world.stored() == before
    assert (await detail(world, draft['id']))['tag']['status'] == 'provisional'


async def scoped_reads_never_show_another_project(world):
    """From project B nothing of project A shows: not its tags, names, links, counts or relations,
    in the vocabulary, a detail, or any preview."""
    for project in ('client-a', 'nature'):
        await world.project(project)
    personal = await mine(world, '标题风格')
    spare = await mine(world, '写作风格')
    secret = (await create(world, '客户A私密', 'client-a'))['tag']
    ours = (await create(world, '自然标题', 'nature'))['tag']
    await govern(world, 'relate', secret['id'], relation='parent', target_tag_id=personal['id'])
    await govern(world, 'relate', ours['id'], relation='parent', target_tag_id=personal['id'])
    secret_item = await world.item('client-a', 'Client headline rule')
    await attach(world, personal['id'], secret_item, 'client-a')
    await attach(world, personal['id'], await world.item('nature', 'Bird headline'), 'nature')

    listed = await vocabulary(world, 'nature', all_projects=False)
    assert {tag['id'] for tag in listed['tags']} == {personal['id'], spare['id'], ours['id']}
    assert all(tag['linked_items'] is None for tag in listed['tags'])
    seen = await detail(world, personal['id'], 'nature', all_projects=False)
    assert ([tag['id'] for tag in seen['children']], seen['links']) == ([ours['id']], None)
    text = str(seen)
    assert secret['id'] not in text and '客户' not in text
    await detail(world, secret['id'], 'nature', all_projects=False, status=404)
    await preview(world, 'merge', secret['id'], 'nature', all_projects=False, status=404,
                  into_tag_id=personal['id'])
    await preview(world, 'merge', personal['id'], 'nature', all_projects=False, status=404,
                  into_tag_id=secret['id'])
    shown = await preview(world, 'merge', personal['id'], 'nature', all_projects=False, into_tag_id=spare['id'])
    assert (shown['links_moved'], shown['links_already_on_target'], shown['relations_moved']) == (None, None, 1)
    assert secret['id'] not in str(shown) and '客户' not in str(shown)
    await govern(world, 'merge', personal['id'], into_tag_id=spare['id'])
    undo = await preview(world, 'undo', spare['id'], 'nature', all_projects=False)
    assert secret['id'] not in {tag['id'] for tag in undo['undo']['restores']}
    assert secret['id'] not in str(await detail(world, spare['id'], 'nature', all_projects=False))
    # The owner's console sees every project.
    assert secret['id'] in {tag['id'] for tag in (await detail(world, spare['id']))['children']}


async def the_review_queue_waits_for_the_person(world):
    """Agents' provisional tags and alias proposals wait in the review queue; only the person
    approves a tag, accepts or removes an alias."""
    await world.project('class')
    draft = (await create(world, '户外学习', 'class'))['tag']
    personal = await mine(world, '短句')
    assert (await alias(world, personal['id'], '简短句子', 'class'))['outcome'] == 'proposed'
    assert (await alias(world, draft['id'], '野外课', 'class'))['outcome'] == 'added'
    queue = await vocabulary(world, status='review')
    assert (queue['review_count'], {tag['id'] for tag in queue['tags']}) == (2, {draft['id'], personal['id']})
    assert next(tag for tag in queue['tags'] if tag['id'] == draft['id'])['provisional_aliases'] == ['野外课']

    approved = await govern(world, 'approve', draft['id'])
    assert [tag['status'] for tag in approved['tags']] == ['active']
    again = await preview(world, 'approve', draft['id'])
    assert again['blocked']['code'] == 'not_provisional'
    await alias(world, draft['id'], '野外课', 'class', operation_actor='human', reason='accept')
    await govern(world, 'remove_alias', personal['id'], alias='简短句子')
    queue = await vocabulary(world, status='review')
    assert (queue['review_count'], queue['tags']) == (0, [])
    assert (await detail(world, personal['id']))['tag']['proposed_aliases'] == []
    await govern(world, 'undo', personal['id'])
    assert (await detail(world, personal['id']))['tag']['proposed_aliases'] == ['简短句子']


async def undo_goes_back_one_change_at_a_time(world):
    """Undoing the latest change leaves the one before it undoable, back to where the person started."""
    tag, first, second = [await mine(world, name) for name in ('短篇', '小说', '散文')]
    start, _ = await world.stored()
    await govern(world, 'relate', tag['id'], relation='parent', target_tag_id=first['id'])
    await govern(world, 'relate', tag['id'], relation='related', target_tag_id=second['id'])
    assert (await preview(world, 'undo', tag['id']))['undo']['action'] == 'relate'
    await govern(world, 'undo', tag['id'])
    assert [parent['id'] for parent in (await detail(world, tag['id']))['tag']['parents']] == [first['id']]
    assert (await detail(world, tag['id']))['tag']['related'] == []
    await govern(world, 'undo', tag['id'])
    after, _ = await world.stored()
    assert governed(after) == governed(start)
    assert (await preview(world, 'undo', tag['id']))['blocked']['code'] == 'nothing_to_undo'


async def an_undo_never_takes_a_link_a_later_merge_relies_on(world):
    """D-23.8: A and C both merge into B and share an item. C's merge found the
    item already on B (A's merge put it there) and moved C's own link away, so
    undoing A's merge first would leave the item without C's meaning. It is
    refused; undoing C's merge and then A's restores everything exactly."""
    await world.project('class')
    first = (await create(world, '户外学习', 'class'))['tag']
    second = (await create(world, '野外教学', 'class'))['tag']
    target = await mine(world, '自然教育')
    item = await world.item('class', 'Bird walk')
    for tag in (first, second):
        await attach(world, tag['id'], item, 'class')
    start_tags, start_links = await world.stored()
    await govern(world, 'merge', first['id'], into_tag_id=target['id'])
    second_merge = await preview(world, 'merge', second['id'], into_tag_id=target['id'])
    assert (second_merge['links_moved'], second_merge['links_already_on_target']) == (0, 1)
    await govern(world, 'merge', second['id'], into_tag_id=target['id'])
    assert await world.attached(item) == [target['id']]

    refused = await preview(world, 'undo', first['id'])
    assert (refused['undo']['action'], refused['blocked']['code']) == ('merge', 'changed_since')
    assert (await govern(world, 'undo', first['id'], status=409))['detail']['code'] == 'changed_since'
    assert await world.attached(item) == [target['id']], 'the refused undo changed nothing'

    await govern(world, 'undo', second['id'])
    assert await world.attached(item) == sorted([target['id'], second['id']])
    await govern(world, 'undo', first['id'])
    after_tags, after_links = await world.stored()
    assert governed(after_tags) == governed(start_tags)
    assert {link_id: value for link_id, value in linked(after_links).items() if link_id in start_links} == \
        linked(start_links)
    assert {link['status'] for link_id, link in after_links.items() if link_id not in start_links} == {'detached'}
    assert sorted(await world.attached(item)) == sorted([first['id'], second['id']])


async def an_undo_never_gives_two_tags_one_word(world):
    """Dot P1: an undo that would put an alias back after another tag took the
    word is refused; once that tag gives the word up, the undo goes through."""
    first, second = await mine(world, '户外学习'), await mine(world, '自然教育')
    await alias(world, first['id'], '野外课', operation_actor='human', reason='mine')
    await govern(world, 'remove_alias', first['id'], alias='野外课')
    assert (await alias(world, second['id'], '野外课', operation_actor='human', reason='mine'))['outcome'] == 'added'
    before = await world.stored()
    refused = await preview(world, 'undo', first['id'])
    assert (refused['undo']['action'], refused['blocked']['code']) == ('remove_alias', 'restore_conflict')
    assert (await govern(world, 'undo', first['id'], status=409))['detail']['code'] == 'restore_conflict'
    assert await world.stored() == before
    await govern(world, 'remove_alias', second['id'], alias='野外课')
    await govern(world, 'undo', first['id'])
    found = [(item['id'], item['match']) for item in await resolve(world, '野外课') if item['match'] != 'similar']
    assert found == [(first['id'], 'alias')]


async def an_undo_or_revival_never_closes_a_parent_cycle(world):
    """Dot P1: A under B, C under A; A retired; B put under C (A no longer counts).
    Undoing the retire would close A→B→C→A, so it is refused until B's change is
    undone. A revival by the person keeps only the relations that still fit."""
    top, middle, low = [await mine(world, name) for name in ('写作', '小说', '短篇')]
    await govern(world, 'relate', middle['id'], relation='parent', target_tag_id=top['id'])
    await govern(world, 'relate', low['id'], relation='parent', target_tag_id=middle['id'])
    await govern(world, 'retire', middle['id'])
    await govern(world, 'relate', top['id'], relation='parent', target_tag_id=low['id'])
    refused = await preview(world, 'undo', middle['id'])
    assert (refused['undo']['action'], refused['blocked']['code']) == ('retire', 'restore_conflict')
    await govern(world, 'undo', middle['id'], status=409)
    # Reverse order: B's change first, then the retire.
    await govern(world, 'undo', top['id'])
    await govern(world, 'undo', middle['id'])
    assert [tag['id'] for tag in (await detail(world, middle['id']))['tag']['parents']] == [top['id']]
    assert [tag['id'] for tag in (await detail(world, low['id']))['tag']['parents']] == [middle['id']]

    # The person's create of a retired word: the cycle-closing parent is dropped, the rest kept.
    await govern(world, 'retire', middle['id'])
    await govern(world, 'relate', top['id'], relation='parent', target_tag_id=low['id'])
    # Dot P2-3: a revival that would drop something changes nothing and returns its preview.
    before = await world.stored()
    asked = await create(world, '小说', operation_actor='human', namespace='personal', reason='I use it again')
    assert (asked['outcome'], asked['tag']) == ('needs_person', None)
    revival = asked['revival']
    assert (revival['change'], revival['tag']['id'], len(revival['digest'])) == ('revive', middle['id'], 64)
    assert [(drop['tag']['id'], drop['target']['id'], drop['reason']) for drop in revival['relations_dropped']] == [
        (middle['id'], top['id'], 'cycle')]
    assert await world.stored() == before, 'nothing changed before the person confirms'
    # The person confirms that preview through the governance apply.
    applied = await post(world, 'governance/apply', {
        'personal_project_id': None, 'change': 'revive', 'tag_id': middle['id'], 'include_all_projects': True,
        'reason': REASON, 'preview_digest': revival['digest']}, headers=REVIEW)
    assert [(tag['id'], tag['status']) for tag in applied['tags'] if tag['id'] == middle['id']] == [
        (middle['id'], 'active')]
    after = await detail(world, middle['id'])
    assert after['tag']['parents'] == []
    assert [tag['id'] for tag in after['children']] == [low['id']]
    assert [entry['action'] for entry in after['history']][0] == 'revive'


async def a_merge_never_overflows_relations(world):
    """Dot P2-1: merging a tag with 32 related tags into one that already has 32
    drops the extra pairs on both sides, listed with reason limit; a full parent
    list drops with reason limit too, not as a cycle."""
    # Unrelated synthetic words, so no creation stops for a similar candidate.
    rng = random.Random(2301)
    word = lambda: ''.join(rng.choice(string.ascii_lowercase) for _ in range(12))  # noqa: E731
    source, target = await fresh(world, word()), await fresh(world, word())
    for _ in range(32):
        for owner in (source, target):
            other = await fresh(world, word())
            await govern(world, 'relate', owner['id'], relation='related', target_tag_id=other['id'])
    parent = await fresh(world, word())
    await govern(world, 'relate', source['id'], relation='parent', target_tag_id=parent['id'])
    for _ in range(8):
        other = await fresh(world, word())
        await govern(world, 'relate', target['id'], relation='parent', target_tag_id=other['id'])
    shown = await preview(world, 'merge', source['id'], into_tag_id=target['id'])
    reasons = [(drop['relation'], drop['reason']) for drop in shown['relations_dropped']]
    assert reasons.count(('related', 'limit')) == 32 and reasons.count(('parent', 'limit')) == 1, reasons
    assert ('parent', 'cycle') not in reasons
    await govern(world, 'merge', source['id'], into_tag_id=target['id'])
    merged = await detail(world, target['id'])
    assert len(merged['tag']['related']) == 32 and len(merged['tag']['parents']) == 8
    stranded = [drop['tag']['id'] for drop in shown['relations_dropped'] if drop['relation'] == 'related']
    for tag_id in stranded:
        assert (await detail(world, tag_id))['tag']['related'] == [], 'no one-sided pair is left'


async def a_large_mistaken_merge_is_split_back_whole(world):
    """Dot P2-3: the one-click restore moves back every item the merge took, read
    from the merge's record, even past the 200 links a detail page lists."""
    await world.project('class')
    source = (await create(world, '户外学习', 'class'))['tag']
    target = await mine(world, '自然教育', 'class')
    items = [await world.item('class', f'Synthetic walk {index}') for index in range(201)]
    for item in items:
        await attach(world, source['id'], item, 'class')
    await attach(world, target['id'], items[0], 'class')
    await govern(world, 'merge', source['id'], into_tag_id=target['id'])
    await alias(world, target['id'], '自然课', 'class', operation_actor='human', reason='later change')
    assert (await preview(world, 'undo', source['id']))['blocked']['code'] == 'changed_since'
    page = await detail(world, target['id'])
    assert (len(page['links']), page['links_truncated']) == (200, True)
    split = {'restore_tag_id': source['id']}
    shown = await preview(world, 'split', target['id'], split=split)
    assert (shown['revives'], shown['other']['id'], shown['links_moved'], shown['links_remaining']) == (
        True, source['id'], 201, 0)
    await govern(world, 'split', target['id'], split=split)
    assert await world.attached(items[0]) == sorted([source['id'], target['id']])
    for item in items[1:]:
        assert await world.attached(item) == [source['id']]
    assert (await preview(world, 'split', target['id'], split=split))['blocked']['code'] == 'nothing_to_split'


async def a_split_back_keeps_a_landing_another_merge_relies_on(world):
    """Dot round 3 P1: A→B put the item on B (link L); C→B found L and moved C's
    own link away. Splitting A back must leave L on B for C and give A its own link."""
    await world.project('class')
    first = (await create(world, '户外学习', 'class'))['tag']
    second = (await create(world, '野外教学', 'class'))['tag']
    target = await mine(world, '自然教育', 'class')
    item = await world.item('class', 'Bird walk')
    for tag in (first, second):
        await attach(world, tag['id'], item, 'class')
    await govern(world, 'merge', first['id'], into_tag_id=target['id'])
    await govern(world, 'merge', second['id'], into_tag_id=target['id'])
    await alias(world, target['id'], '自然课', 'class', operation_actor='human', reason='later change')
    split = {'restore_tag_id': first['id']}
    shown = await preview(world, 'split', target['id'], split=split)
    assert (shown['blocked'], shown['revives'], shown['links_moved']) == (None, True, 1)
    await govern(world, 'split', target['id'], split=split)
    assert await world.attached(item) == sorted([first['id'], target['id']]), 'B keeps the link C relies on'
    assert (await detail(world, second['id']))['tag']['merged_into']['id'] == target['id']
    _, links = await world.stored()
    held = [link for link in links.values() if link['item_id'] == item['item_id']]
    assert {(link['tag_id'], link['status'], link.get('moved_to_tag_id')) for link in held} == {
        (first['id'], 'attached', None), (target['id'], 'attached', None), (second['id'], 'moved', target['id'])}


async def a_revival_never_overflows_a_peer(world):
    """Dot round 3 P2-1: B has 32 related including A; A is retired and B takes C.
    Bringing A back would give B 33, so the pair is dropped on both sides (limit)."""
    rng = random.Random(2302)
    word = lambda: ''.join(rng.choice(string.ascii_lowercase) for _ in range(12))  # noqa: E731
    peer, revived = await fresh(world, word()), await fresh(world, word())
    await govern(world, 'relate', peer['id'], relation='related', target_tag_id=revived['id'])
    for _ in range(31):
        other = await fresh(world, word())
        await govern(world, 'relate', peer['id'], relation='related', target_tag_id=other['id'])
    await govern(world, 'retire', revived['id'])
    late = await fresh(world, word())
    await govern(world, 'relate', peer['id'], relation='related', target_tag_id=late['id'])
    asked = await create(world, revived['name'], operation_actor='human', namespace='personal', reason='back again')
    assert asked['outcome'] == 'needs_person'
    assert [(drop['target']['id'], drop['reason']) for drop in asked['revival']['relations_dropped']] == [
        (peer['id'], 'limit')]
    await post(world, 'governance/apply', {'personal_project_id': None, 'change': 'revive', 'tag_id': revived['id'],
                                           'include_all_projects': True, 'reason': REASON,
                                           'preview_digest': asked['revival']['digest']}, headers=REVIEW)
    assert len((await detail(world, peer['id']))['tag']['related']) == 32
    assert (await detail(world, revived['id']))['tag']['related'] == []
    stored, _ = await world.stored()
    assert revived['id'] not in (stored[peer['id']].get('related_ids') or []), 'dropped on both sides'


async def a_retired_tag_is_gone_until_the_person_brings_it_back(world):
    await world.project('class')
    tag = (await create(world, '户外学习', 'class'))['tag']
    item = await world.item('class', 'Bird walk')
    await attach(world, tag['id'], item, 'class')
    await govern(world, 'retire', tag['id'])
    assert [found for found in await resolve(world, '户外学习', 'class') if found['match'] == 'exact'] == []
    assert (await attach(world, tag['id'], await world.item('class', 'Pond'), 'class', status=409)
            )['detail']['code'] == 'tag_retired'
    assert (await create(world, '户外学习', 'class', status=409))['detail']['code'] == 'tag_retired'
    revived = await create(world, '户外学习', 'class', operation_actor='human', reason='I use it again')
    assert (revived['outcome'], revived['tag']['id'], revived['tag']['status']) == ('created', tag['id'], 'active')
    assert await world.attached(item) == [tag['id']], 'retiring kept the link record'


GOVERNANCE_SCENARIOS = [
    merge_redirects_and_never_resolves_again, merge_then_undo_restores_exactly,
    split_moves_the_chosen_aliases_and_links, a_mistaken_merge_is_split_back,
    parent_cycles_and_cross_scope_relations_are_refused, a_merge_racing_an_attach_lands_once_on_the_target,
    an_agent_can_preview_but_never_govern, scoped_reads_never_show_another_project,
    the_review_queue_waits_for_the_person, undo_goes_back_one_change_at_a_time,
    an_undo_never_takes_a_link_a_later_merge_relies_on, an_undo_never_gives_two_tags_one_word,
    an_undo_or_revival_never_closes_a_parent_cycle, a_merge_never_overflows_relations,
    a_large_mistaken_merge_is_split_back_whole, a_split_back_keeps_a_landing_another_merge_relies_on,
    a_revival_never_overflows_a_peer,
    a_retired_tag_is_gone_until_the_person_brings_it_back,
]
