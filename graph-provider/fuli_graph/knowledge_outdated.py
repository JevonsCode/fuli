"""Marking knowledge outdated (rec#5 C8): a soft end that keeps history.

It is the person's negative feedback, recorded the way any trusted rejection
is (#225: usage stops counting toward confirmation, and a block outlives later
use), and the end of the item's validity, in one transaction. The item leaves
every current answer and stays readable as history ("我以前是这样"). Nothing
revives it: usage of historical knowledge is refused whatever its event ID, a
restore is refused because it would erase the time it was not valid, and
re-asserting it writes a new version from new evidence. Conclusions drawn from
it stop being current facts as well.
"""
from fastapi import HTTPException

from .knowledge_audit import _item_match, _record_one_knowledge_feedback, record_human_change
from .knowledge_dependencies import end_dependents
from .knowledge_feedback_models import KnowledgeFeedbackCreate
from .knowledge_item_version import lock_version
from .knowledge_management import _read_item, _snapshot
from .knowledge_versions import invalid_property, lock_knowledge, record_version_revision
from .models import KnowledgeRevisionRecord

MARK_OUTDATED_TOOL = 'mark_outdated'


async def mark_item_outdated(scoped, actor, space, item_id, request, current, previous, *,
                             created_at, revision_id, changed_by) -> KnowledgeRevisionRecord:
    # The same lock captures take: no conclusion naming this item can be
    # written between the end of its validity and the dependents scan.
    await lock_knowledge(scoped, space)
    await _record_outdated_feedback(scoped, actor, space, item_id, request, revision_id,
                                    'user' if changed_by == 'user' else 'agent')
    invalid = invalid_property(request.item_kind)
    # The feedback write bumped the lock once; anything else since is a conflict.
    records, _, _ = await scoped.runtime.driver.execute_query(
        _item_match(request.item_kind) + f'''
        SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1
        WITH item WHERE item.fuli_ai_review_lock_version = $expected + 2 AND item.{invalid} IS NULL
        SET item.{invalid} = $created_at, item.expired_at = $created_at
        RETURN item.uuid AS item_id
        ''', item_id=item_id, group_id=space['group_id'], expected=lock_version(current),
        created_at=created_at)
    if not records:
        raise HTTPException(status_code=409, detail='knowledge changed while it was being marked outdated; read it again')
    outdated = _snapshot(await _read_item(scoped, space, item_id, request.item_kind), request.item_kind)
    await record_version_revision(
        scoped, actor, space, request.item_kind, item_id, revision_id=revision_id, action='mark_outdated',
        reason=request.reason, previous=previous, current=outdated, changed_by=changed_by,
        created_at=created_at)
    if changed_by == 'user':
        await record_human_change(scoped, actor, space, item_id, request.item_kind,
                                  reason=request.reason, operation='knowledge_mark_outdated')
    ended = await end_dependents(scoped, actor, space, request.item_kind, item_id,
                                 reason=request.reason, changed_by=changed_by, created_at=created_at)
    return KnowledgeRevisionRecord(
        id=revision_id, item_id=item_id, item_kind=request.item_kind, action='mark_outdated',
        reason=request.reason, previous=previous, current=outdated, created_at=created_at,
        changed_by=changed_by, dependents_outdated=len(ended))


async def report_outdated_to_person(scoped, actor, space, item_id, request, previous, *,
                                    created_at, revision_id) -> KnowledgeRevisionRecord:
    """An Agent's outdated report on what a person confirmed (D-20.10): only
    negative feedback is recorded. The item stays valid, nothing that rests on
    it changes, no revision is written, and the person decides in the console."""
    await _record_outdated_feedback(scoped, actor, space, item_id, request, revision_id, 'agent')
    return KnowledgeRevisionRecord(
        id=revision_id, item_id=item_id, item_kind=request.item_kind, action='mark_outdated',
        reason=request.reason, previous=previous, current=previous, created_at=created_at,
        changed_by='agent', outcome='pending_person')


async def _record_outdated_feedback(scoped, actor, space, item_id, request, revision_id, reporter):
    feedback = KnowledgeFeedbackCreate(
        personal_space_id=space['id'], task_id=f'{MARK_OUTDATED_TOOL}:{revision_id}',
        tool_name=MARK_OUTDATED_TOOL,
        items=[{'item_id': item_id, 'item_kind': request.item_kind, 'feedback_kind': 'outdated',
                'reason': request.reason, 'evidence_summary': request.reason,
                'reported_by_kind': reporter}],
    )
    await _record_one_knowledge_feedback(scoped, actor, space, feedback, feedback.items[0])
