"""When a basis changes its meaning (rec#5 C7, D-20.7).

A person who edits knowledge that conclusions rest on says whether the meaning
changed. It changed (the default): every current conclusion drawn from it, and
those drawn from them, gets an unresolved reason. While a conclusion holds any
unresolved reason (fuli_unresolved_bases) it is not delivered, searched,
recalled, AI-reviewed or promoted by use, whatever its confirmation: each of
those reads requires the list to be empty. The console still shows it,
waiting for the person. Only the wording changed: the direct conclusions
keep being delivered and show a hint to look again; that never clears an
earlier meaning change. A person can also mark a meaning change later, from
the basis's version record. An Agent never chooses: its rewrite waits for a
person, who chooses when confirming it. No model classifies the change.

A reason is `<basis lineage>@<change>`: the basis a conclusion rests on
directly (the root of its versions) and the change that started the walk. A
conclusion keeps one reason per pair, so several bases, a diamond of
dependencies, or several changes stay separate. A person's review of a
conclusion ("仍然成立") writes a new version without reasons, and clears, in
what rests on it, only the reasons of the changes it reviewed; a conclusion
that still holds a reason for a change keeps that change going further down.

Every step is a revision of the conclusion; nothing earlier is rewritten. The
caller holds the space's knowledge lock in its transaction, so a concurrent
capture cannot add a conclusion between the decision and the walk.
"""
from .knowledge_audit import _item_match
from .knowledge_dependencies import dependents_of
from .knowledge_management import _read_item, _snapshot
from .knowledge_versions import item_revisions, lineage_ids, record_version_revision
from .provider_values import stable_uuid

_HINT_ACTIONS = frozenset({'basis_reworded', 'basis_review_cleared', 'confirm'})


def basis_review(current: dict, revisions) -> str | None:
    """'changed' while any reason is unresolved; 'reworded' while a wording
    hint waits for a look; a new version starts with neither."""
    if current.get('unresolved_bases'):
        return 'changed'
    latest = max((revision for revision in revisions if revision.action in _HINT_ACTIONS),
                 key=lambda revision: revision.created_at, default=None)
    return 'reworded' if latest is not None and latest.action == 'basis_reworded' else None


async def lineage_root(store, space, item_kind, item_id) -> str:
    return (await lineage_ids(store, space, item_kind, item_id))[-1]


async def apply_meaning(scoped, actor, space, item_kind, item_id, *, meaning, reason, changed_by,
                        created_at, change_id=None) -> int:
    """After a person's edit or confirmation of `item_id` (or a later re-mark),
    apply the meaning choice to what rests on it; return how many changed."""
    if meaning == 'changed':
        return await _mark_changed_downstream(scoped, actor, space, item_kind, item_id,
                                              change=change_id or item_id, reason=reason,
                                              changed_by=changed_by, created_at=created_at)
    hinted = 0
    for dependent_kind, dependent_id in await dependents_of(scoped, space, item_kind, item_id):
        revisions = (await item_revisions(scoped, space, dependent_kind, [dependent_id])).get(dependent_id, [])
        current = await _read_item(scoped, space, dependent_id, dependent_kind)
        if basis_review(current, revisions) is None:
            await _record(scoped, actor, space, dependent_kind, dependent_id, 'basis_reworded', reason,
                          changed_by, created_at, (item_kind, item_id), keys=[])
            hinted += 1
    return hinted


async def clear_reviewed(scoped, actor, space, item_kind, item_id, *, changes, reason, changed_by,
                         created_at) -> int:
    """A person said this conclusion still holds after `changes`: in what rests
    on it, clear the reasons for those changes that came through it, and go
    further down for a change no reason of that conclusion still holds."""
    if not changes:
        return 0
    cleared = 0
    root = await lineage_root(scoped, space, item_kind, item_id)
    for dependent_kind, dependent_id in await dependents_of(scoped, space, item_kind, item_id):
        current = await _read_item(scoped, space, dependent_id, dependent_kind)
        held = list(current.get('unresolved_bases') or [])
        keys = [f'{root}@{change}' for change in changes if f'{root}@{change}' in held]
        if not keys:
            continue
        await _remove_reasons(scoped, space, dependent_kind, dependent_id, keys)
        await _record(scoped, actor, space, dependent_kind, dependent_id, 'basis_review_cleared', reason,
                      changed_by, created_at, (item_kind, item_id), keys=keys)
        cleared += 1
        remaining = [key for key in held if key not in keys]
        settled = [change for change in changes
                   if f'{root}@{change}' in keys and not any(key.endswith(f'@{change}') for key in remaining)]
        cleared += await clear_reviewed(scoped, actor, space, dependent_kind, dependent_id, changes=settled,
                                        reason=reason, changed_by=changed_by, created_at=created_at)
    return cleared


def reviewed_changes(current: dict) -> list[str]:
    """The changes a review of this conclusion settles: every one it waits for."""
    return list(dict.fromkeys(key.rsplit('@', 1)[1] for key in current.get('unresolved_bases') or []))


async def _mark_changed_downstream(scoped, actor, space, item_kind, item_id, *, change, reason, changed_by,
                                   created_at) -> int:
    marked, seen, frontier = 0, {(item_kind, item_id)}, [(item_kind, item_id)]
    while frontier:
        next_frontier = []
        for basis in frontier:
            root = await lineage_root(scoped, space, *basis)
            key = f'{root}@{change}'
            for dependent in await dependents_of(scoped, space, *basis):
                dependent_kind, dependent_id = dependent
                current = await _read_item(scoped, space, dependent_id, dependent_kind)
                held = current.get('unresolved_bases') or []
                if key not in held:
                    before = _snapshot(current, dependent_kind)
                    await _add_reason(scoped, space, dependent_kind, dependent_id, key)
                    await _record(scoped, actor, space, dependent_kind, dependent_id, 'basis_changed', reason,
                                  changed_by, created_at, basis, keys=[key], previous=before)
                    marked += 0 if held or dependent in seen else 1
                if dependent not in seen:
                    seen.add(dependent)
                    next_frontier.append(dependent)
        frontier = next_frontier
    return marked


async def _add_reason(scoped, space, item_kind, item_id, key) -> None:
    await scoped.runtime.driver.execute_query(
        _item_match(item_kind) + '''
        SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1,
            item.fuli_unresolved_bases = coalesce(item.fuli_unresolved_bases, []) + $key
        ''', item_id=item_id, group_id=space['group_id'], key=key)


async def _remove_reasons(scoped, space, item_kind, item_id, keys) -> None:
    await scoped.runtime.driver.execute_query(
        _item_match(item_kind) + '''
        WITH item, [key IN coalesce(item.fuli_unresolved_bases, []) WHERE NOT key IN $keys] AS remaining
        SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1,
            item.fuli_unresolved_bases = CASE WHEN size(remaining) = 0 THEN null ELSE remaining END
        ''', item_id=item_id, group_id=space['group_id'], keys=keys)


async def _record(scoped, actor, space, item_kind, item_id, action, reason, changed_by, created_at,
                  basis, *, keys, previous=None) -> None:
    snapshot = _snapshot(await _read_item(scoped, space, item_id, item_kind), item_kind)
    await record_version_revision(
        scoped, actor, space, item_kind, item_id,
        revision_id=stable_uuid(space['id'], 'knowledge-revision', item_kind, item_id, action, basis[1],
                                ','.join(keys), created_at.isoformat()),
        action=action, reason=reason, previous=previous or snapshot,
        current={**snapshot, 'basis': {'itemKind': basis[0], 'itemId': basis[1]}, 'reasons': keys},
        changed_by=changed_by, created_at=created_at)
