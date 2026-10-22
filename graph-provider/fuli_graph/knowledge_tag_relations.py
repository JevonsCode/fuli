"""Relations between tags (rec#11 D-07 part 2): broader (parent) and related.

A tag has at most a few parents and some related tags, kept as IDs on the tag;
children are the tags that name it as parent. Parents never form a cycle, and
a parent is personal or of the child's own namespace, so it is visible
wherever the child is. Related tags are symmetric and never join two different
projects. Relations are the person's governance (knowledge_tag_governance):
these planners only decide what a change writes, on the plan it builds under
the space's lock, and say why they refuse. A merge carries the merged tag's
relations over to the tag it went into, dropping only what would break these rules.
"""
from .knowledge_tags import PERSONAL_NAMESPACE, visible_tag

MAX_PARENTS = 8
MAX_RELATED = 32


async def other_tag(plan, reader, tag_id: str) -> dict:
    """The change's other tag (a merge target or a relation's other end), if the caller sees it."""
    other = await visible_tag(reader, plan.namespaces, tag_id)
    plan.other_id = other['id']
    return plan.read(other['id'])


async def relate(plan, reader, request, reason):
    target = await other_tag(plan, reader, request.target_tag_id)
    plan.summary['relation'] = request.relation
    blocked = _relation_blocked(plan, plan.subject_id, target['id'], request.relation)
    if blocked:
        return blocked
    subject = plan.current(plan.subject_id)
    if request.relation == 'parent':
        plan.update(plan.subject_id, parent_ids=[*(subject.get('parent_ids') or []), target['id']])
    else:
        plan.update(plan.subject_id, related_ids=[*(subject.get('related_ids') or []), target['id']])
        plan.update(target['id'], related_ids=[*(target.get('related_ids') or []), plan.subject_id])
    plan.summary['relations_moved'] = 1


def _relation_blocked(plan, tag_id: str, target_id: str, relation: str) -> str | None:
    tag, target = plan.current(tag_id), plan.current(target_id)
    if not plan.live(tag_id) or not plan.live(target_id):
        return 'not_live'
    if tag_id == target_id:
        return 'self'
    if not _compatible(tag, target, relation):
        return 'scope'
    held = tag.get('parent_ids' if relation == 'parent' else 'related_ids') or []
    if target_id in held:
        return 'unchanged'
    limit = MAX_PARENTS if relation == 'parent' else MAX_RELATED
    if len([other for other in held if plan.live(other)]) >= limit:
        return 'too_many'
    if relation == 'related' and len([other for other in target.get('related_ids') or []
                                      if plan.live(other)]) >= MAX_RELATED:
        return 'too_many'
    if relation == 'parent' and plan.creates_cycle(tag_id, target_id):
        return 'parent_cycle'
    return None


def _compatible(tag: dict, target: dict, relation: str) -> bool:
    """A parent is personal or of the child's namespace, so it is visible
    wherever the child is; related tags never join two different projects."""
    if relation == 'parent':
        return target['namespace_key'] in (PERSONAL_NAMESPACE, tag['namespace_key'])
    return PERSONAL_NAMESPACE in (tag['namespace_key'], target['namespace_key']) \
        or tag['namespace_key'] == target['namespace_key']


async def unrelate(plan, reader, request, reason):
    target = await other_tag(plan, reader, request.target_tag_id)
    plan.summary['relation'] = request.relation
    subject = plan.current(plan.subject_id)
    if request.relation == 'parent':
        if target['id'] not in (subject.get('parent_ids') or []):
            return 'unchanged'
        plan.update(plan.subject_id, parent_ids=[tag_id for tag_id in subject['parent_ids'] if tag_id != target['id']])
    else:
        if target['id'] not in (subject.get('related_ids') or []) \
                and plan.subject_id not in (target.get('related_ids') or []):
            return 'unchanged'
        plan.update(plan.subject_id, related_ids=[tag_id for tag_id in subject.get('related_ids') or []
                                                  if tag_id != target['id']])
        plan.update(target['id'], related_ids=[tag_id for tag_id in target.get('related_ids') or []
                                               if tag_id != plan.subject_id])
    plan.summary['relations_moved'] = 1


def carry_relations(plan, source: str, target: str) -> None:
    """A's children, parents and related tags carry over to B where they still
    make sense; what cannot (a cycle, B itself, another scope, a full list) is
    dropped on both sides and listed in the preview."""
    moved, dropped = 0, plan.summary.setdefault('dropped', [])

    def drop(tag_id, relation, other, why):
        dropped.append((tag_id, relation, other, why))

    for child in sorted(tag_id for tag_id in plan.tags if plan.live(tag_id)
                        and source in (plan.current(tag_id).get('parent_ids') or [])):
        parents = [parent for parent in plan.current(child)['parent_ids'] if parent != source]
        if child == target:
            drop(child, 'parent', source, 'self')
        elif target not in parents:
            if plan.creates_cycle(child, target):
                drop(child, 'parent', target, 'cycle')
            else:
                parents.append(target)
                moved += plan.visible(child)
        plan.update(child, parent_ids=parents)
    for parent in [tag_id for tag_id in plan.tags[source].get('parent_ids') or [] if plan.live(tag_id)]:
        current = plan.current(target).get('parent_ids') or []
        if parent == target:
            drop(target, 'parent', parent, 'self')
        elif parent in current:
            continue
        elif not _compatible(plan.current(target), plan.current(parent), 'parent'):
            drop(target, 'parent', parent, 'scope')
        elif plan.creates_cycle(target, parent):
            drop(target, 'parent', parent, 'cycle')
        elif live_count(plan, current) >= MAX_PARENTS:
            drop(target, 'parent', parent, 'limit')
        else:
            plan.update(target, parent_ids=[*current, parent])
            moved += plan.visible(parent)
    related = {tag_id for tag_id in plan.tags[source].get('related_ids') or []} | {
        tag_id for tag_id in plan.tags if source in (plan.tags[tag_id].get('related_ids') or [])}
    for other in sorted(related - {source}):
        if not plan.live(other):
            continue
        others = [tag_id for tag_id in plan.current(other).get('related_ids') or [] if tag_id != source]
        mine = plan.current(target).get('related_ids') or []
        if other == target:
            plan.update(target, related_ids=others)
            continue
        if target in others:
            plan.update(other, related_ids=others)
            continue
        if live_count(plan, mine) >= MAX_RELATED:
            # B is full: the pair would be one-sided, so neither side keeps it.
            plan.update(other, related_ids=others)
            drop(other, 'related', target, 'limit')
            continue
        plan.update(other, related_ids=[*others, target])
        plan.update(target, related_ids=[*mine, other])
        moved += plan.visible(other)
    plan.summary['relations_moved'] = moved


def live_count(plan, tag_ids) -> int:
    return len([tag_id for tag_id in tag_ids or [] if plan.live(tag_id)])


def relation_violation(plan, tag_ids) -> str | None:
    """Whether the planned state breaks a relation rule around these tags:
    a parent cycle, a full list, or a parent in another scope. An undo restores
    an earlier state exactly; it is refused when that state no longer fits
    what changed since (a retired tag's parent now its descendant)."""
    around = set(tag_ids) | {tag_id for tag_id in plan.all_ids() if plan.live(tag_id) and (
        set(plan.current(tag_id).get('parent_ids') or []) | set(plan.current(tag_id).get('related_ids') or [])
    ) & set(tag_ids)}
    for tag_id in sorted(around):
        if not plan.live(tag_id):
            continue
        tag = plan.current(tag_id)
        parents = [parent for parent in tag.get('parent_ids') or [] if plan.live(parent)]
        if len(parents) > MAX_PARENTS or live_count(plan, tag.get('related_ids')) > MAX_RELATED:
            return 'too_many'
        if any(plan.ancestors(parent) & {tag_id} or parent == tag_id for parent in parents):
            return 'parent_cycle'
        if any(not _compatible(tag, plan.current(parent), 'parent') for parent in parents):
            return 'scope'
    return None


def settle_revived(plan, tag_id: str) -> None:
    """A tag that comes back (a split names it, or the person creates its word
    again) keeps each relation that is still valid and one-to-one, and drops
    the rest, listed in the preview: a parent that is gone, in another scope,
    would make a cycle or overflow the list; a related tag that no longer lists
    it back or is full."""
    dropped = plan.summary.setdefault('dropped', [])
    tag = plan.current(tag_id)
    kept_parents = []
    for parent in tag.get('parent_ids') or []:
        if parent not in plan.tags or not plan.live(parent):
            dropped.append((tag_id, 'parent', parent, 'gone'))
        elif not _compatible(tag, plan.current(parent), 'parent'):
            dropped.append((tag_id, 'parent', parent, 'scope'))
        elif parent == tag_id or tag_id in plan.ancestors(parent):
            dropped.append((tag_id, 'parent', parent, 'cycle'))
        elif len(kept_parents) >= MAX_PARENTS:
            dropped.append((tag_id, 'parent', parent, 'limit'))
        else:
            kept_parents.append(parent)
    kept_related = []
    for other in tag.get('related_ids') or []:
        if other not in plan.tags or not plan.live(other) or tag_id not in (plan.current(other).get('related_ids') or []):
            dropped.append((tag_id, 'related', other, 'gone'))
        elif len(kept_related) >= MAX_RELATED:
            dropped.append((tag_id, 'related', other, 'limit'))
        else:
            kept_related.append(other)
    plan.update(tag_id, parent_ids=kept_parents, related_ids=kept_related)
    # Children that name it again must not now make a cycle or overflow.
    for child in sorted(other for other in plan.all_ids() if other != tag_id and plan.live(other)
                        and tag_id in (plan.current(other).get('parent_ids') or [])):
        parents = plan.current(child)['parent_ids']
        if child in plan.ancestors(tag_id) or live_count(plan, parents) > MAX_PARENTS:
            plan.update(child, parent_ids=[parent for parent in parents if parent != tag_id])
            dropped.append((child, 'parent', tag_id, 'cycle' if child in plan.ancestors(tag_id) else 'limit'))
