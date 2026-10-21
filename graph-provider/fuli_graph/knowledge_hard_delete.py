"""Hard delete of one knowledge item (rec#5 C9): the one path that really
removes a person's own data, an explicit exception to keeping history.

Only a person reaches it: both routes take the human-review channel, which no
Agent or MCP tool sends. It takes two steps. The preview lists exactly what
goes and what stays: every version of the item, for an entity the
relationships that cannot stand without it, the source episodes no other item
uses (an episode another item still uses stays, without its link to what
goes), and every record about those items (revisions, feedback, usage, change
audits, tag links, assignments, project references, AI review decisions,
conflicts, promotions and the copies a cross-project decision kept). It also
lists the current conclusions drawn from it. The preview ID is a digest of
that plan; the delete recomputes the plan in its own transaction and refuses
anything else, so a stale preview is a 409.

The delete is one transaction under the space's knowledge lock (the lock
captures and new versions take), so it either happens whole or not at all.
Conclusions drawn from what goes are kept and wait for the person, the way a
basis whose meaning changed makes them wait (D-20.7): an unresolved reason
`<basis lineage>@<deletion>` keeps them out of every current answer until a
person reviews them. A content-free trace is left behind (time, actor, kind,
counts and opaque IDs), so an old link or a receipt says 「已彻底删除」, and a
replayed capture of a removed episode does not write it again.
"""
import json

from fastapi import HTTPException

from .knowledge_basis_review import apply_meaning
from .knowledge_dependencies import dependents_of
from .knowledge_hard_delete_models import (
    KnowledgeHardDeleteConfirm,
    KnowledgeHardDeleteOperation,
    KnowledgeHardDeleteCounts,
    KnowledgeHardDeleteDependent,
    KnowledgeHardDeleteEpisode,
    KnowledgeHardDeleteItem,
    KnowledgeHardDeletePreview,
    KnowledgeHardDeleteRecord,
    KnowledgeHardDeleteRef,
    KnowledgeHardDeleteSpace,
    KnowledgeHardDeleteStatus,
    KnowledgeHardDeleteUser,
)
from .knowledge_hard_delete_operations import (
    abort_operation, operation_fingerprint, operation_outcome, record_refusal, settled_operation,
)
from .knowledge_hard_delete_traces import all_hard_deletions, hard_deletion_record, require_not_hard_deleted
from .knowledge_management import _read_item
from .knowledge_versions import item_revisions, lock_knowledge, version_chain, version_status
from .provider_values import native_datetime, now_utc, sha256_text, stable_uuid
from .store_transactions import query_store_transaction

# What the person may type to confirm, besides the item's own title.
CONFIRMATION_WORDS = frozenset({'删除', 'delete'})
# The reason a waiting conclusion's revision names; it holds no deleted words.
DEPENDENT_REASON = 'A basis it rests on was permanently deleted by the person.'
EXCERPT_LIMIT = 280

_ITEM_ROWS = {
    'entity': '''
        UNWIND $item_ids AS id
        MATCH (item:Entity {uuid: id, group_id: $group_id})
        RETURN item.uuid AS item_id, item.name AS title, coalesce(item.summary, item.name) AS content,
               item.fuli_invalid_at AS invalid_at, item.fuli_replaced_by_item_id AS replaced_by_item_id,
               coalesce(item.fuli_ai_review_lock_version, 0) AS lock_version
    ''',
    'relationship': '''
        UNWIND $item_ids AS id
        MATCH (source)-[item:RELATES_TO {uuid: id, group_id: $group_id}]->(target)
        RETURN item.uuid AS item_id, item.name AS title,
               coalesce(source.name, '') + ' → ' + coalesce(item.fact, '') + ' → ' + coalesce(target.name, '')
                 AS content,
               item.invalid_at AS invalid_at, item.fuli_replaced_by_item_id AS replaced_by_item_id,
               coalesce(item.fuli_ai_review_lock_version, 0) AS lock_version
    ''',
}
_LOCK = {
    'entity': '''
        UNWIND $item_ids AS id
        MATCH (item:Entity {uuid: id, group_id: $group_id})
        SET item._hard_delete_lock = true REMOVE item._hard_delete_lock
    ''',
    'relationship': '''
        UNWIND $item_ids AS id
        MATCH ()-[item:RELATES_TO {uuid: id, group_id: $group_id}]->()
        SET item._hard_delete_lock = true REMOVE item._hard_delete_lock
    ''',
}
_ATTACHED_RELATIONSHIPS = '''
MATCH (entity:Entity {group_id: $group_id})-[item:RELATES_TO {group_id: $group_id}]-()
WHERE entity.uuid IN $entity_ids
RETURN DISTINCT item.uuid AS item_id ORDER BY item_id
'''
_EVIDENCE = '''
CALL {
  MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(entity:Entity {group_id: $group_id})
  WHERE entity.uuid IN $entity_ids
  RETURN episode
  UNION
  MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()
  WHERE item.uuid IN $relationship_ids
  UNWIND coalesce(item.episodes, []) AS episode_id
  MATCH (episode:Episodic {uuid: episode_id, group_id: $group_id})
  RETURN episode
  UNION
  MATCH (episode:Episodic {group_id: $group_id})
  WHERE any(edge_id IN coalesce(episode.entity_edges, []) WHERE edge_id IN $relationship_ids)
  RETURN episode
}
WITH DISTINCT episode
OPTIONAL MATCH (episode)-[:MENTIONS]->(other:Entity)
WHERE NOT other.uuid IN $entity_ids
WITH episode, collect(DISTINCT CASE WHEN other IS NULL THEN NULL ELSE
  {item_kind: 'entity', item_id: other.uuid, title: coalesce(other.summary, other.name, other.uuid)} END) AS mentioned
OPTIONAL MATCH ()-[edge:RELATES_TO {group_id: $group_id}]->()
WHERE NOT edge.uuid IN $relationship_ids
  AND (episode.uuid IN coalesce(edge.episodes, []) OR edge.uuid IN coalesce(episode.entity_edges, []))
WITH episode, mentioned, collect(DISTINCT CASE WHEN edge IS NULL THEN NULL ELSE
  {item_kind: 'relationship', item_id: edge.uuid, title: coalesce(edge.fact, edge.name, edge.uuid)} END) AS related
RETURN episode {.uuid, .created_at, .fuli_source_kind, .fuli_source_application, .fuli_session_id,
                .fuli_source_excerpt} AS episode,
       mentioned + related AS others
ORDER BY episode.created_at, episode.uuid
'''
_MENTIONS = '''
MATCH (:Episodic {group_id: $group_id})-[mention:MENTIONS]->(entity:Entity {group_id: $group_id})
WHERE entity.uuid IN $entity_ids
RETURN count(mention) AS mentions
'''
# Every record about the items, by what the preview calls it. Each query
# returns the record IDs; a hard delete's own earlier trace is never one.
_RECORDS = {
    'revisions': '''
        MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REVISION]->(record:FuliKnowledgeRevision)
        WHERE record.item_id IN $item_ids RETURN record.id AS id
    ''',
    'feedback': '''
        MATCH (record:FuliKnowledgeAudit {space_id: $space_id})
        WHERE record.item_id IN $item_ids AND record.action = 'knowledge_feedback' RETURN record.id AS id
    ''',
    'usage': '''
        MATCH (record:FuliKnowledgeAudit {space_id: $space_id})
        WHERE record.item_id IN $item_ids AND record.action = 'knowledge_used' RETURN record.id AS id
    ''',
    'change_audits': '''
        MATCH (record:FuliKnowledgeAudit {space_id: $space_id})
        WHERE record.item_id IN $item_ids
          AND NOT coalesce(record.action, '') IN ['knowledge_feedback', 'knowledge_used', 'hard_delete']
        RETURN record.id AS id
    ''',
    'tags': '''
        MATCH (record:FuliKnowledgeTagLink {space_id: $space_id})
        WHERE record.item_id IN $item_ids RETURN record.id AS id
    ''',
    'assignments': '''
        MATCH (record:FuliKnowledgeAssignment {space_id: $space_id})
        WHERE record.item_id IN $item_ids RETURN record.id AS id
    ''',
    'references': '''
        MATCH (record:FuliKnowledgeProjectReference {space_id: $space_id})
        WHERE record.item_id IN $item_ids RETURN record.id AS id
    ''',
    'review_decisions': '''
        MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REVIEW]->(:FuliKnowledgeReviewRun)
              -[:HAS_REVIEW_DECISION]->(record:FuliKnowledgeReviewDecision)
        WHERE record.candidate_key IN $candidate_keys RETURN DISTINCT record.id AS id
    ''',
    'conflicts': '''
        CALL {
          MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_CONFLICT]->(record:FuliKnowledgeConflict)
          WHERE record.item_id IN $item_ids OR record.target_item_id IN $item_ids
          RETURN record
          UNION
          MATCH (record:FuliPreferenceConflict {personal_space_id: $space_id})
          WHERE record.left_item_id IN $item_ids OR record.right_item_id IN $item_ids
          RETURN record
        }
        RETURN record.id AS id
    ''',
    'promotions': '''
        MATCH (record:FuliCommonKnowledgePromotion {space_id: $space_id})
        WHERE record.canonical_item_id IN $item_ids RETURN record.id AS id
    ''',
    # A cross-project decision keeps a copy of each source it rested on; the
    # copy loses its words, the decision keeps the opaque reference.
    'decision_snapshots': '''
        MATCH (record:FuliPersonalGlobalPreferenceDecisionEvent {space_id: $space_id})
        WHERE any(id IN $item_ids WHERE coalesce(record.source_items_json, '') CONTAINS ('"' + id + '"'))
        RETURN record.id AS id
    ''',
}
# Revisions and audits go by item ID when the delete runs, so the ones this
# transaction wrote (a walk that reached what goes) go too.
_DELETE_BY_ITEM = '''
CALL {
  MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REVISION]->(record:FuliKnowledgeRevision)
  WHERE record.item_id IN $item_ids
  RETURN record
  UNION
  MATCH (record:FuliKnowledgeAudit {space_id: $space_id})
  WHERE record.item_id IN $item_ids AND coalesce(record.action, '') <> 'hard_delete'
  RETURN record
}
DETACH DELETE record
'''
_DELETE_RECORDS = {
    'tags': 'FuliKnowledgeTagLink',
    'assignments': 'FuliKnowledgeAssignment', 'references': 'FuliKnowledgeProjectReference',
    'review_decisions': 'FuliKnowledgeReviewDecision', 'promotions': 'FuliCommonKnowledgePromotion',
}


async def preview_hard_delete(store, actor, item_id, request: KnowledgeHardDeleteRef) -> KnowledgeHardDeletePreview:
    space = await _person_space(store, actor, request.personal_space_id)
    return (await _plan(store, space, request.item_kind, item_id))['preview']


async def apply_hard_delete(store, actor, item_id, request: KnowledgeHardDeleteConfirm) -> KnowledgeHardDeleteRecord:
    """One operation is decided once, under the space's knowledge lock: the
    lock captures, new versions and the outdated mark take, which an abort of
    the operation takes too. Inside it, an operation that already has an
    outcome is answered from it (an exact replay of a commit) or refused
    (409), a refusal is recorded in the same locked transaction that decided
    it, and a delete commits together with its trace. So no refusal or abort
    is ever visible while a delete of the same operation runs, and no outcome
    of an operation ever changes."""
    space = await _person_space(store, actor, request.personal_space_id)
    fingerprint = operation_fingerprint(item_id, request) if request.operation_id else None
    created_at = now_utc()
    refusal = None
    async with query_store_transaction(store) as scoped:
        await lock_knowledge(scoped, space)
        if request.operation_id:
            replay = await settled_operation(scoped, space, request.operation_id, fingerprint)
            if replay is not None:
                return replay
        try:
            plan = await _checked_plan(scoped, space, item_id, request)
        except HTTPException as refused:
            # Nothing was written yet: the refusal is this operation's
            # answer, recorded before the lock is released.
            if not request.operation_id or not 400 <= refused.status_code < 500:
                raise
            refusal = refused
            code = refused.detail.get('code') if isinstance(refused.detail, dict) else None
            await record_refusal(scoped, actor, space, request.operation_id, code or f'http_{refused.status_code}',
                                 fingerprint)
        if refusal is None:
            preview = plan['preview']
            deletion_id = stable_uuid(space['id'], 'knowledge-hard-delete', request.item_kind, item_id,
                                      created_at.isoformat())
            await _hold_dependents(scoped, actor, space, plan, deletion_id, created_at)
            await _remove(scoped, space, plan)
            await _write_trace(scoped, actor, space, plan, deletion_id, created_at, request.operation_id, fingerprint)
    if refusal is not None:
        raise refusal
    return KnowledgeHardDeleteRecord(
        deletion_id=deletion_id, item_kind=request.item_kind, item_id=item_id, deleted_at=created_at,
        counts=preview.counts, deleted_item_ids=[item.item_id for item in preview.items])


async def _checked_plan(scoped, space, item_id, request) -> dict:
    """The plan, if this request may run it; refusals are raised before any write."""
    plan = await _plan(scoped, space, request.item_kind, item_id, lock=True)
    preview = plan['preview']
    if preview.preview_id != request.preview_id:
        raise HTTPException(status_code=409, detail={
            'code': 'hard_delete_preview_stale',
            'message': 'what this delete removes changed since the preview; read the preview again'})
    if request.confirmation.strip() not in CONFIRMATION_WORDS | {preview.title.strip()}:
        raise HTTPException(status_code=422, detail={
            'code': 'hard_delete_unconfirmed',
            'message': 'type 删除 or the item title to confirm the delete'})
    return plan


async def hard_delete_status(store, actor, item_id, request: KnowledgeHardDeleteRef) -> KnowledgeHardDeleteStatus:
    """For a console whose delete answer was lost: the trace if the item was
    deleted, otherwise whether it is still there. It only reads, so a console
    asks this instead of sending an irreversible delete again."""
    space = await _person_space(store, actor, request.personal_space_id)
    deletion = await hard_deletion_record(store, space, item_id)
    if deletion is not None:
        return KnowledgeHardDeleteStatus(state='deleted', deletion=deletion)
    present = await _read_item(store, space, item_id, request.item_kind) is not None
    return KnowledgeHardDeleteStatus(state='present' if present else 'missing')


async def read_hard_delete_operation(store, actor, operation_id,
                                     request: KnowledgeHardDeleteSpace) -> KnowledgeHardDeleteOperation:
    """What the graph knows about one console operation; it only reads."""
    space = await _person_space(store, actor, request.personal_space_id)
    return await operation_outcome(store, space, operation_id)


async def abort_hard_delete(store, actor, operation_id,
                            request: KnowledgeHardDeleteSpace) -> KnowledgeHardDeleteOperation:
    """Ends an operation whose outcome its console cannot learn: committed if
    its delete committed (waiting for one that runs), else aborted for good."""
    space = await _person_space(store, actor, request.personal_space_id)
    return await abort_operation(store, actor, space, operation_id)


async def hard_deletions(store, actor, request: KnowledgeHardDeleteSpace) -> list[KnowledgeHardDeleteRecord]:
    space = await _person_space(store, actor, request.personal_space_id)
    return await all_hard_deletions(store, space)


async def _person_space(store, actor, space_id):
    store._require_personal()
    space = await store.authorize(actor, space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='hard delete is personal-only')
    return space


async def _plan(store, space, item_kind, item_id, *, lock=False) -> dict:
    await require_not_hard_deleted(store, space, item_id)
    if await _read_item(store, space, item_id, item_kind) is None:
        raise HTTPException(status_code=404, detail='knowledge item not found')
    versions = [version['item_id'] for version in await version_chain(store, space, item_kind, item_id)]
    targets = {'entity': [], 'relationship': []}
    targets[item_kind] = sorted(set(versions) | {item_id})
    if item_kind == 'entity':
        records, _, _ = await store.runtime.driver.execute_query(
            _ATTACHED_RELATIONSHIPS, group_id=space['group_id'], entity_ids=targets['entity'], routing_='r')
        targets['relationship'] = [record['item_id'] for record in records]
    if lock:
        for kind, ids in targets.items():
            if ids:
                await store.runtime.driver.execute_query(_LOCK[kind], item_ids=ids, group_id=space['group_id'])
    items, locks = await _item_rows(store, space, item_kind, item_id, targets)
    all_ids = [item.item_id for item in items]
    evidence, _, _ = await store.runtime.driver.execute_query(
        _EVIDENCE, group_id=space['group_id'], entity_ids=targets['entity'],
        relationship_ids=targets['relationship'], routing_='r')
    episodes = [_episode(record['episode'], record['others']) for record in evidence]
    removed = [episode for episode in episodes if not episode.other_items]
    kept = [episode for episode in episodes if episode.other_items]
    mentions, _, _ = await store.runtime.driver.execute_query(
        _MENTIONS, group_id=space['group_id'], entity_ids=targets['entity'], routing_='r')
    record_ids = await _record_ids(store, space, items)
    dependents = await _dependents(store, space, items)
    counts = KnowledgeHardDeleteCounts(
        items=len(items), versions=sum(item.role != 'relationship' for item in items),
        relationships=sum(item.role == 'relationship' for item in items), episodes=len(removed),
        mentions=int(mentions[0]['mentions']) if mentions else 0, kept_episodes=len(kept),
        dependents=len(dependents), **{category: len(ids) for category, ids in record_ids.items()})
    digest = sha256_text(json.dumps({
        'space': space['id'], 'item': [item_kind, item_id], 'locks': locks,
        'removed': [episode.episode_id for episode in removed], 'kept': [episode.episode_id for episode in kept],
        'records': record_ids, 'dependents': [[d.item_kind, d.item_id] for d in dependents],
        'counts': counts.model_dump(),
    }, sort_keys=True, separators=(',', ':'), ensure_ascii=False))
    title = next(item.title for item in items if item.role == 'item')
    preview = KnowledgeHardDeletePreview(
        preview_id=digest, item_kind=item_kind, item_id=item_id, title=title, items=items,
        removed_episodes=removed, kept_episodes=kept, dependents=dependents, counts=counts)
    return {'preview': preview, 'targets': targets, 'all_ids': all_ids, 'records': record_ids}


async def _item_rows(store, space, item_kind, item_id, targets):
    items, locks = [], []
    for kind in ('entity', 'relationship'):
        ids = targets[kind]
        if not ids:
            continue
        records, _, _ = await store.runtime.driver.execute_query(
            _ITEM_ROWS[kind], item_ids=ids, group_id=space['group_id'], routing_='r')
        revisions = await item_revisions(store, space, kind, ids)
        for record in sorted(records, key=lambda row: row['item_id']):
            role = 'item' if (kind, record['item_id']) == (item_kind, item_id) else (
                'version' if kind == item_kind else 'relationship')
            items.append(KnowledgeHardDeleteItem(
                item_kind=kind, item_id=record['item_id'], role=role,
                title=record['title'] or record['item_id'], content=(record['content'] or '')[:EXCERPT_LIMIT],
                status=version_status(record['invalid_at'], record['replaced_by_item_id'],
                                      revisions.get(record['item_id'], []))))
            locks.append([kind, record['item_id'], int(record['lock_version'])])
    order = {'item': 0, 'version': 1, 'relationship': 2}
    return sorted(items, key=lambda item: order[item.role]), locks


def _episode(row, others) -> KnowledgeHardDeleteEpisode:
    users = sorted((dict(other) for other in others), key=lambda other: (other['item_kind'], other['item_id']))
    return KnowledgeHardDeleteEpisode(
        episode_id=row['uuid'], source_kind=row.get('fuli_source_kind'),
        source_application=row.get('fuli_source_application'), session_id=row.get('fuli_session_id'),
        excerpt=(row.get('fuli_source_excerpt') or '')[:EXCERPT_LIMIT] or None,
        created_at=native_datetime(row.get('created_at')), other_items=len(users),
        used_by=[KnowledgeHardDeleteUser(item_kind=user['item_kind'], item_id=user['item_id'],
                                         title=(user['title'] or '')[:EXCERPT_LIMIT]) for user in users])


async def _record_ids(store, space, items) -> dict[str, list[str]]:
    item_ids = [item.item_id for item in items]
    candidate_keys = [f'{item.item_kind}:{item.item_id}' for item in items]
    found = {}
    for category, query in _RECORDS.items():
        records, _, _ = await store.runtime.driver.execute_query(
            query, space_id=space['id'], item_ids=item_ids, candidate_keys=candidate_keys, routing_='r')
        found[category] = sorted({record['id'] for record in records if record['id']})
    return found


async def _dependents(store, space, items) -> list[KnowledgeHardDeleteDependent]:
    """Every current conclusion drawn from what goes, down the whole chain
    (a walk that passes through what goes as well); what goes itself is not one."""
    going = {(item.item_kind, item.item_id) for item in items}
    seen, found = set(going), []
    frontier = [(item.item_kind, item.item_id) for item in items]
    direct = True
    while frontier:
        next_frontier = []
        for basis in frontier:
            for dependent in await dependents_of(store, space, *basis):
                if dependent in seen:
                    continue
                seen.add(dependent)
                found.append((dependent, direct))
                next_frontier.append(dependent)
        frontier, direct = next_frontier, False
    rows = []
    for (kind, dependent_id), is_direct in found:
        current = await _read_item(store, space, dependent_id, kind) or {}
        title = current.get('name') if kind == 'entity' else current.get('type')
        content = (current.get('summary') or current.get('name')) if kind == 'entity' else current.get('fact')
        rows.append(KnowledgeHardDeleteDependent(
            item_kind=kind, item_id=dependent_id, title=title or dependent_id,
            content=(content or '')[:EXCERPT_LIMIT], direct=is_direct))
    return sorted(rows, key=lambda row: (not row.direct, row.item_kind, row.item_id))


async def _hold_dependents(scoped, actor, space, plan, deletion_id, created_at) -> None:
    """Each conclusion drawn from what goes waits for the person (D-20.7): the
    same unresolved reason a meaning change writes, keyed to this deletion."""
    if not plan['preview'].dependents:
        return
    for item in plan['preview'].items:
        await apply_meaning(scoped, actor, space, item.item_kind, item.item_id, meaning='changed',
                            reason=DEPENDENT_REASON, changed_by='user', created_at=created_at,
                            change_id=deletion_id)


async def _remove(scoped, space, plan) -> None:
    targets, preview = plan['targets'], plan['preview']
    params = {'group_id': space['group_id'], 'space_id': space['id']}
    kept = [episode.episode_id for episode in preview.kept_episodes]
    removed = [episode.episode_id for episode in preview.removed_episodes]
    # A shared episode stays for the items that still use it; it no longer
    # names a relationship that goes (its mentions go with the entities).
    if kept and targets['relationship']:
        await scoped.runtime.driver.execute_query(
            '''
            UNWIND $episode_ids AS id
            MATCH (episode:Episodic {uuid: id, group_id: $group_id})
            SET episode.entity_edges = [edge_id IN coalesce(episode.entity_edges, [])
                                        WHERE NOT edge_id IN $relationship_ids]
            ''', episode_ids=kept, relationship_ids=targets['relationship'], **params)
    if targets['relationship']:
        await scoped.runtime.driver.execute_query(
            '''
            MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()
            WHERE item.uuid IN $item_ids
            DELETE item
            ''', item_ids=targets['relationship'], **params)
    if removed:
        await scoped.runtime.driver.execute_query(
            '''
            UNWIND $episode_ids AS id
            MATCH (episode:Episodic {uuid: id, group_id: $group_id})
            DETACH DELETE episode
            ''', episode_ids=removed, **params)
    if targets['entity']:
        await scoped.runtime.driver.execute_query(
            '''
            UNWIND $item_ids AS id
            MATCH (item:Entity {uuid: id, group_id: $group_id})
            DETACH DELETE item
            ''', item_ids=targets['entity'], **params)
    await scoped.runtime.driver.execute_query(_DELETE_BY_ITEM, item_ids=plan['all_ids'], **params)
    for category, label in _DELETE_RECORDS.items():
        ids = plan['records'][category]
        if ids:
            await scoped.runtime.driver.execute_query(
                f'UNWIND $ids AS id MATCH (record:{label} {{id: id}}) DETACH DELETE record', ids=ids)
    if plan['records']['conflicts']:
        await scoped.runtime.driver.execute_query(
            '''
            UNWIND $ids AS id
            MATCH (record {id: id})
            WHERE record:FuliKnowledgeConflict OR record:FuliPreferenceConflict
            DETACH DELETE record
            ''', ids=plan['records']['conflicts'])
    await _redact_decision_snapshots(scoped, space, plan['records']['decision_snapshots'], plan['all_ids'])


async def _redact_decision_snapshots(scoped, space, event_ids, item_ids) -> None:
    if not event_ids:
        return
    records, _, _ = await scoped.runtime.driver.execute_query(
        '''
        UNWIND $ids AS id
        MATCH (event:FuliPersonalGlobalPreferenceDecisionEvent {id: id, space_id: $space_id})
        RETURN event.id AS id, event.source_snapshots_json AS snapshots
        ''', ids=event_ids, space_id=space['id'])
    going = set(item_ids)
    for record in records:
        snapshots = json.loads(record['snapshots'] or '[]')
        redacted = [{key: snapshot.get(key) for key in ('item_id', 'item_kind', 'project_id')} | {'hard_deleted': True}
                    if isinstance(snapshot, dict) and snapshot.get('item_id') in going else snapshot
                    for snapshot in snapshots]
        await scoped.runtime.driver.execute_query(
            '''
            MATCH (event:FuliPersonalGlobalPreferenceDecisionEvent {id: $id, space_id: $space_id})
            SET event.source_snapshots_json = $snapshots
            ''', id=record['id'], space_id=space['id'],
            snapshots=json.dumps(redacted, ensure_ascii=False, sort_keys=True))


async def _write_trace(scoped, actor, space, plan, deletion_id, created_at, operation_id, fingerprint) -> None:
    """The content-free trace: IDs, time, the person, the kind and counts,
    and the console's operation ID, so it is that operation's commit."""
    preview = plan['preview']
    await scoped.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        CREATE (trace:FuliKnowledgeAudit {
          id: $deletion_id, space_id: $space_id, item_id: $item_id, item_kind: $item_kind,
          action: 'hard_delete', operation: 'knowledge_hard_delete', operation_actor: 'human',
          outcome: 'deleted', created_by: $created_by, created_at: $created_at,
          deleted_item_keys: $deleted_item_keys, evidence_ids: $evidence_ids,
          removed_episode_ids: $removed_episode_ids, deletion_counts_json: $counts,
          operation_id: $operation_id, operation_fingerprint: $fingerprint
        })
        MERGE (space)-[:HAS_KNOWLEDGE_AUDIT]->(trace)
        ''', space_id=space['id'], deletion_id=deletion_id, item_id=preview.item_id, item_kind=preview.item_kind,
        created_by=actor['id'], created_at=created_at,
        deleted_item_keys=[f'{item.item_kind}:{item.item_id}' for item in preview.items],
        evidence_ids=[episode.episode_id for episode in [*preview.removed_episodes, *preview.kept_episodes]],
        removed_episode_ids=[episode.episode_id for episode in preview.removed_episodes],
        counts=json.dumps(preview.counts.model_dump(), sort_keys=True), operation_id=operation_id,
        fingerprint=fingerprint)
