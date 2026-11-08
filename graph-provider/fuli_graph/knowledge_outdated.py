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
from .knowledge_duplicates import merge_new_duplicates
from .knowledge_feedback_models import KnowledgeFeedbackCreate
from .knowledge_item_version import lock_version
from .knowledge_management import _read_item, _snapshot
from .knowledge_search import _terms
from .knowledge_versions import (
    end_keyed_values, invalid_property, keyed_value, lock_knowledge, record_version_revision,
)
from .models import KnowledgeRevisionRecord
from .preference_versions import end_older_preferences, forget_ended
from .provider_values import normalized_text, stable_uuid

MARK_OUTDATED_TOOL = 'mark_outdated'
# The write-time staleness check (no model call). An older item of the same
# subject and relation, or of the same type in the same project and FLA, whose
# words the new item mostly repeats may be what it silently replaces.
SIMILAR_TEXT_SHARE = 0.6
MIN_SHARED_TERMS = 3
CANDIDATE_LIMIT = 200
MAX_FLAGGED_PER_ITEM = 5
POSSIBLY_OUTDATED_REASON = 'Newer knowledge may replace this; it stays current until a person decides.'


async def settle_older_knowledge(scoped, actor, space, items, *, created_at) -> dict[str, list[dict]]:
    """What newly written or confirmed knowledge does to older knowledge,
    inside the caller's transaction. A duplicate of a current item merges
    into one current item (knowledge_duplicates). A confirmed value of a keyed relation
    ends the other values of its subject and relation, and a confirmed
    preference the other preferences of its key and scope; any other new item
    queues the older items it may silently replace for a person (flagged, not
    ended). Nothing is deleted."""
    # The same knowledge stored twice becomes one current item first (no person).
    superseded = await merge_new_duplicates(scoped, actor, space, items, created_at=created_at)
    merged = {item['item_id'] for item in superseded}
    flagged = []
    scopes = {}  # each preference scope is read once for all the items
    for item_kind, item_id in items:
        if item_id in merged:
            continue
        # A confirmed preference ends the older one of its key and scope.
        ended = await end_older_preferences(scoped, actor, space, item_kind, item_id, changed_by='user',
                                            created_at=created_at, scopes=scopes)
        if ended:
            superseded += ended
            continue
        keyed = await keyed_value(scoped, space, item_id) if item_kind == 'relationship' else None
        if keyed and keyed['confirmation_status'] == 'confirmed':
            ended = await end_keyed_values(scoped, actor, space, keyed, changed_by='user', created_at=created_at)
            ended = [{'item_kind': 'relationship', 'item_id': ended_id} for ended_id in ended]
            forget_ended(scopes, ended)
            superseded += ended
            continue
        candidates = await _older_candidates(scoped, space, item_kind, item_id, keyed=keyed is not None)
        flagged += await _flag_possibly_outdated(scoped, actor, space, item_kind, item_id, candidates,
                                                 created_at=created_at)
    return {'superseded': superseded, 'possibly_outdated': flagged}


def similar_share(new_text: str, old_text: str) -> float | None:
    """How much of the shorter text the other repeats, when it is enough to
    suspect the newer one replaces the older; identical words are a
    duplicate, not a replacement."""
    new, old = normalized_text(new_text), normalized_text(old_text)
    if not new or not old or new == old:
        return None
    new_terms, old_terms = _terms(new), _terms(old)
    shared = len(new_terms & old_terms)
    if shared < MIN_SHARED_TERMS:
        return None
    share = shared / min(len(new_terms), len(old_terms))
    return round(share, 4) if share >= SIMILAR_TEXT_SHARE else None


async def _older_candidates(scoped, space, item_kind, item_id, *, keyed) -> list[dict]:
    """Older current items the new one may replace, most similar first, each
    with the rule that found it."""
    if item_kind == 'relationship':
        query = '''
        MATCH (source:Entity)-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
        WHERE item.invalid_at IS NULL AND item.fuli_profile_aspect IS NULL
        MATCH (source)-[old:RELATES_TO {group_id: $group_id}]->()
        WHERE old.name = item.name AND old.uuid <> item.uuid AND old.invalid_at IS NULL
          AND old.fuli_profile_aspect IS NULL AND old.created_at < item.created_at
        RETURN DISTINCT item.fact AS text, old.uuid AS old_id, old.fact AS old_text,
               old.created_at AS old_created_at
        '''
    else:
        # Same project and FLA: an episode of each says it in the same place.
        query = '''
        MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(item:Entity {uuid: $item_id, group_id: $group_id})
        WHERE item.fuli_invalid_at IS NULL AND item.fuli_profile_aspect IS NULL
        WITH item, collect(DISTINCT [coalesce(episode.fuli_personal_project_id, ''),
                                     coalesce(episode.fuli_project_agent_id, '')]) AS places
        MATCH (old_episode:Episodic {group_id: $group_id})-[:MENTIONS]->(old:Entity {group_id: $group_id})
        WHERE old.uuid <> item.uuid AND old.fuli_invalid_at IS NULL AND old.fuli_profile_aspect IS NULL
          AND coalesce(old.fuli_type, 'Entity') = coalesce(item.fuli_type, 'Entity')
          AND old.created_at < item.created_at
          AND [coalesce(old_episode.fuli_personal_project_id, ''),
               coalesce(old_episode.fuli_project_agent_id, '')] IN places
        RETURN DISTINCT coalesce(item.summary, item.name) AS text, old.uuid AS old_id,
               coalesce(old.summary, old.name) AS old_text, old.created_at AS old_created_at
        '''
    records, _, _ = await scoped.runtime.driver.execute_query(
        '// write-time supersession: older candidates\n' + query + ' ORDER BY old_created_at DESC LIMIT $limit',
        item_id=item_id, group_id=space['group_id'], limit=CANDIDATE_LIMIT, routing_='r')
    found = []
    for record in records:
        share = None if keyed else similar_share(record['text'] or '', record['old_text'] or '')
        if keyed or share is not None:
            found.append({'item_id': record['old_id'], 'rule': 'keyed_value' if keyed else 'similar_text',
                          'share': share})
    found.sort(key=lambda candidate: -(candidate['share'] or 1.0))
    return found[:MAX_FLAGGED_PER_ITEM]


async def _flag_possibly_outdated(scoped, actor, space, item_kind, item_id, candidates, *, created_at):
    """Queue each candidate for a person: it keeps its validity and its place
    in current answers, raises the attention flag the review lists, and its
    history names the newer item. Flagging the same pair again does nothing."""
    flagged = []
    for candidate in candidates:
        revision_id = stable_uuid(space['id'], 'knowledge-revision', 'possibly-outdated', item_kind,
                                  candidate['item_id'], item_id)
        records, _, _ = await scoped.runtime.driver.execute_query(
            _item_match(item_kind) + f'''
            WHERE item.{invalid_property(item_kind)} IS NULL AND NOT EXISTS {{
              MATCH (:FuliKnowledgeRevision {{id: $revision_id}})
            }}
            SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1,
                item.fuli_requires_attention = true
            RETURN item.uuid AS item_id
            ''', item_id=candidate['item_id'], group_id=space['group_id'], revision_id=revision_id)
        if not records:
            continue
        await record_version_revision(
            scoped, actor, space, item_kind, candidate['item_id'], revision_id=revision_id,
            action='possibly_outdated', reason=POSSIBLY_OUTDATED_REASON, previous={},
            current={'possiblyOutdatedBy': {'itemKind': item_kind, 'itemId': item_id},
                     'rule': candidate['rule'], **({'share': candidate['share']} if candidate['share'] else {})},
            changed_by='agent', created_at=created_at)
        flagged.append({'item_kind': item_kind, 'item_id': candidate['item_id']})
    return flagged


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
