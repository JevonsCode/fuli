"""When a basis changes its meaning (rec#5 C7, D-20.7).

A person who edits knowledge that conclusions rest on says whether the meaning
changed. It changed (the default): every current conclusion drawn from it, and
those drawn from them, enter `basis_changed`. That is a delivery state, not
history: the conclusion waits for a person's review (it is pending, so no
current answer uses it) until a person says it still holds, which writes a new
version resting on the new basis, or edits it into a new version. Only the
wording changed: the direct conclusions keep being delivered and show a hint
to look again. A person can also mark a meaning change later, from the
basis's version record. An Agent never chooses: its rewrite waits for a
person, who chooses when confirming it. No model classifies the change.

Every step is a revision of the conclusion; nothing earlier is rewritten. The
caller holds the space's knowledge lock in its transaction, so a concurrent
capture cannot add a conclusion between the decision and the walk.
"""
import json

from .knowledge_audit import _item_match
from .knowledge_dependencies import dependents_of
from .knowledge_management import _read_item, _snapshot
from .knowledge_versions import item_revisions, lineage_ids, record_version_revision
from .provider_values import stable_uuid

_REVIEW_ACTIONS = frozenset({'basis_changed', 'basis_reworded', 'basis_review_cleared', 'confirm'})


def basis_review(revisions) -> str | None:
    """'changed' or 'reworded' while a conclusion waits for a person's look,
    from its latest review revision; a new version starts with none."""
    latest = max((revision for revision in revisions if revision.action in _REVIEW_ACTIONS),
                 key=lambda revision: revision.created_at, default=None)
    if latest is None:
        return None
    return {'basis_changed': 'changed', 'basis_reworded': 'reworded'}.get(latest.action)


def _review_basis(revisions) -> str | None:
    latest = max((revision for revision in revisions if revision.action == 'basis_changed'),
                 key=lambda revision: revision.created_at, default=None)
    return ((latest.current.get('basis') or {}).get('itemId')) if latest else None


async def apply_meaning(scoped, actor, space, item_kind, item_id, *, meaning, reason, changed_by,
                        created_at) -> int:
    """After a person's edit or confirmation of `item_id` (or a later re-mark),
    apply the meaning choice to what rests on it; return how many changed."""
    if meaning == 'changed':
        return await _mark_changed_downstream(scoped, actor, space, item_kind, item_id, reason=reason,
                                              changed_by=changed_by, created_at=created_at)
    touched = 0
    for dependent_kind, dependent_id in await dependents_of(scoped, space, item_kind, item_id):
        revisions = (await item_revisions(scoped, space, dependent_kind, [dependent_id])).get(dependent_id, [])
        if basis_review(revisions) == 'changed':
            touched += await clear_downstream_of(scoped, actor, space, item_kind, item_id, reason=reason,
                                                 changed_by=changed_by, created_at=created_at, only=dependent_id)
        if basis_review((await item_revisions(scoped, space, dependent_kind, [dependent_id])).get(
                dependent_id, [])) != 'reworded':
            await _record(scoped, actor, space, dependent_kind, dependent_id, 'basis_reworded', reason,
                          changed_by, created_at, (item_kind, item_id))
            touched += 1
    return touched


async def clear_downstream_of(scoped, actor, space, item_kind, item_id, *, reason, changed_by, created_at,
                              only=None) -> int:
    """A person said this conclusion still holds (or only its wording moved):
    what was marked changed because of it is delivered again, and so on down."""
    cleared = 0
    lineage = set(await lineage_ids(scoped, space, item_kind, item_id))
    for dependent_kind, dependent_id in await dependents_of(scoped, space, item_kind, item_id):
        if only and dependent_id != only:
            continue
        revisions = (await item_revisions(scoped, space, dependent_kind, [dependent_id])).get(dependent_id, [])
        if basis_review(revisions) != 'changed' or _review_basis(revisions) not in lineage:
            continue
        await _restore_confirmation(scoped, actor, space, dependent_kind, dependent_id, revisions, reason,
                                    changed_by, created_at, (item_kind, item_id))
        cleared += 1 + await clear_downstream_of(scoped, actor, space, dependent_kind, dependent_id,
                                                 reason=reason, changed_by=changed_by, created_at=created_at)
    return cleared


async def _mark_changed_downstream(scoped, actor, space, item_kind, item_id, *, reason, changed_by,
                                   created_at) -> int:
    marked, seen, frontier = 0, {(item_kind, item_id)}, [(item_kind, item_id)]
    while frontier:
        next_frontier = []
        for basis in frontier:
            for dependent in await dependents_of(scoped, space, *basis):
                if dependent in seen:
                    continue
                seen.add(dependent)
                dependent_kind, dependent_id = dependent
                revisions = (await item_revisions(scoped, space, dependent_kind, [dependent_id])).get(dependent_id, [])
                if basis_review(revisions) != 'changed':
                    before = _snapshot(await _read_item(scoped, space, dependent_id, dependent_kind), dependent_kind)
                    await _set_pending(scoped, space, dependent_kind, dependent_id)
                    await _record(scoped, actor, space, dependent_kind, dependent_id, 'basis_changed', reason,
                                  changed_by, created_at, basis, previous=before)
                    marked += 1
                next_frontier.append(dependent)
        frontier = next_frontier
    return marked


async def _set_pending(scoped, space, item_kind, item_id) -> None:
    current = await _read_item(scoped, space, item_id, item_kind)
    basis = json.loads(current.get('confirmation_basis_json') or '{}')
    pending = {key: value for key, value in basis.items()
               if key not in ('confirmed_by', 'confirmed_at', 'agent_policy_version')}
    pending.setdefault('existence_reason', 'A basis of this conclusion changed its meaning.')
    pending.setdefault('quadrant_reason', 'A basis of this conclusion changed its meaning.')
    pending.setdefault('proposed_by', {'kind': 'agent'})
    await scoped.runtime.driver.execute_query(
        _item_match(item_kind) + '''
        SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1,
            item.fuli_confirmation_status = 'pending', item.fuli_confirmation_basis_json = $basis,
            item.fuli_epistemic_status = 'observed'
        ''', item_id=item_id, group_id=space['group_id'],
        basis=json.dumps(pending, ensure_ascii=False, sort_keys=True))


async def _restore_confirmation(scoped, actor, space, item_kind, item_id, revisions, reason, changed_by,
                                created_at, basis) -> None:
    marked = max((revision for revision in revisions if revision.action == 'basis_changed'),
                 key=lambda revision: revision.created_at)
    before = marked.previous
    before_clear = _snapshot(await _read_item(scoped, space, item_id, item_kind), item_kind)
    await scoped.runtime.driver.execute_query(
        _item_match(item_kind) + '''
        SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1,
            item.fuli_confirmation_status = $status, item.fuli_confirmation_basis_json = $basis,
            item.fuli_epistemic_status = $epistemic
        ''', item_id=item_id, group_id=space['group_id'], status=before.get('confirmationStatus') or 'pending',
        basis=json.dumps(before.get('confirmationBasis'), ensure_ascii=False, sort_keys=True)
        if before.get('confirmationBasis') else None,
        epistemic=before.get('epistemicStatus') or 'observed')
    await _record(scoped, actor, space, item_kind, item_id, 'basis_review_cleared', reason, changed_by,
                  created_at, basis, previous=before_clear)


async def _record(scoped, actor, space, item_kind, item_id, action, reason, changed_by, created_at,
                  basis, *, previous=None) -> None:
    snapshot = _snapshot(await _read_item(scoped, space, item_id, item_kind), item_kind)
    await record_version_revision(
        scoped, actor, space, item_kind, item_id,
        revision_id=stable_uuid(space['id'], 'knowledge-revision', item_kind, item_id, action, basis[1],
                                created_at.isoformat()),
        action=action, reason=reason, previous=previous or snapshot,
        current={**snapshot, 'basis': {'itemKind': basis[0], 'itemId': basis[1]}},
        changed_by=changed_by, created_at=created_at)
