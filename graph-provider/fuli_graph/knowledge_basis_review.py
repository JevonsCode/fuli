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
仍然成立, a person's edit into a new version and a person's confirmation
(one item or a batch; of an Agent's rewrite or of a conclusion that waits) are
all a person reviewing the item, and all settle through settle_review: its own
reasons present at review time, the same changes below it, then the meaning
of the new change (an edit or a confirmed rewrite only).

A conclusion captured from a basis that waits for a review waits too, from
birth: it takes the basis's changes keyed by that basis's lineage, exactly as
the walk would have written them, so the basis's review settles them in it.

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
    # A review that settles and then hints in one step writes both at one
    # time: the hint is the later step.
    latest = max((revision for revision in revisions if revision.action in _HINT_ACTIONS),
                 key=lambda revision: (revision.created_at, revision.action == 'basis_reworded'), default=None)
    return 'reworded' if latest is not None and latest.action == 'basis_reworded' else None


async def lineage_root(store, space, item_kind, item_id) -> str:
    return (await lineage_ids(store, space, item_kind, item_id))[-1]


async def hold_deleted_sources(scoped, actor, space, item_kind, item_id, episode_ids,
                               deletion_id, created_at) -> None:
    """Keep a selected conclusion, but hold it while its erased evidence is unreviewed.

    The caller holds the knowledge lock. Source identities stay separate from
    public knowledge kinds; the existing reason settlement clears them after a
    person's review exactly like a changed knowledge basis.
    """
    current = await _read_item(scoped, space, item_id, item_kind)
    held = set(current.get('unresolved_bases') or [])
    for episode_id in sorted(set(episode_ids)):
        key = f'{episode_id}@{deletion_id}'
        if key in held:
            continue
        before = _snapshot(current, item_kind)
        await _add_reason(scoped, space, item_kind, item_id, key)
        await _record(scoped, actor, space, item_kind, item_id, 'basis_changed',
                      'Source evidence was permanently deleted by the person.', 'user', created_at,
                      ('episode', episode_id), keys=[key], previous=before)
        held.add(key)
        current = await _read_item(scoped, space, item_id, item_kind)


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


async def settle_review(scoped, actor, space, item_kind, item_id, *, held, meaning, reason,
                        created_at) -> int:
    """A person reviewed `item_id` while it held `held`: clear those reasons
    on it (a new version starts without them), settle the same changes in what
    rests on it, then apply `meaning` (None: the words did not change). Returns
    how many conclusions the meaning choice reached, or, without one, how many
    the settlement released."""
    current = await _read_item(scoped, space, item_id, item_kind)
    own = [key for key in held if key in ((current or {}).get('unresolved_bases') or [])]
    if own:
        await _remove_reasons(scoped, space, item_kind, item_id, own)
        await _record(scoped, actor, space, item_kind, item_id, 'basis_review_cleared', reason, 'user',
                      created_at, (item_kind, item_id), keys=own)
    released = await clear_reviewed(scoped, actor, space, item_kind, item_id, changes=_changes(held),
                                    reason=reason, changed_by='user', created_at=created_at)
    if meaning is None:
        return released
    return await apply_meaning(scoped, actor, space, item_kind, item_id, meaning=meaning, reason=reason,
                               changed_by='user', created_at=created_at)


async def confirmation_review(store, space, item_kind, item_id, current, *, meaning) -> dict | None:
    """What a person's confirmation of this item reviews, as settle_review's
    options; None when it reviews nothing. Confirming an Agent's rewrite (a
    version that replaced another) also says what its words mean below it."""
    held = list(current.get('unresolved_bases') or [])
    rewrite = len(await lineage_ids(store, space, item_kind, item_id)) > 1
    if not held and not rewrite:
        return None
    return {'held': held, 'meaning': (meaning or 'changed') if rewrite else None}


async def inherited_reasons(scoped, space, bases) -> dict[str, list[str]]:
    """For each named basis that waits for a review, the reasons a conclusion
    drawn from it holds."""
    reasons = {}
    for basis in bases:
        changes = _changes(basis.get('unresolved_bases') or [])
        if changes:
            root = await lineage_root(scoped, space, basis['item_kind'], basis['item_id'])
            reasons[basis['item_id']] = [f'{root}@{change}' for change in changes]
    return reasons


async def record_inherited(scoped, actor, space, born, bases, *, reason, created_at) -> None:
    """One `basis_changed` revision per waiting basis on each conclusion this
    capture created (`born`: item kind, item ID, derived_from)."""
    kinds = {basis['item_id']: basis['item_kind'] for basis in bases}
    for item_kind, item_id, derived_from in born:
        records, _, _ = await scoped.runtime.driver.execute_query(
            _item_match(item_kind) + ' RETURN item.created_at = $created_at AS born',
            item_id=item_id, group_id=space['group_id'], created_at=created_at)
        if not records or not records[0]['born']:
            continue  # the mention landed on knowledge that already existed
        for basis_id, keys in derived_from.items():
            await _record(scoped, actor, space, item_kind, item_id, 'basis_changed', reason, 'agent',
                          created_at, (kinds[basis_id], basis_id), keys=keys)


def _changes(held) -> list[str]:
    return list(dict.fromkeys(key.rsplit('@', 1)[1] for key in held))


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
