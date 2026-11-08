"""Automatic merging of duplicate knowledge (rec#88, after #839).

The same fact or experience stored twice splits a recall: both copies take a
slot and push a third item out. When an item is written or confirmed, and in
a periodic pass, a current item of the same kind, type and scope that
knowledge_duplicate_rules calls the same is merged into one current item:
- the stronger confirmed copy stays (for a longer list, the newer one), so
  two confirmed items, or a pending one into a confirmed one, need no person,
  and two pending items stay pending;
- the other copy ends the way a version ends: its validity stops, it points
  at the kept item and a 'supersede' revision with duplicateMerge says why.
  Nothing is deleted, and current answers only read the kept item;
- the kept item gains the other copy's sources (episodes), recorded in that
  revision so a split takes back exactly those.
A person's restore of the merged copy splits it back out; an item a person
split out is never merged automatically again. Preferences (their own
conflict review), items a person rejected and conclusions waiting for a
review are never merged.
"""
from fastapi import HTTPException

from .knowledge_audit import record_human_change
from .knowledge_audit_models import KnowledgeRevisionRecord
from .knowledge_duplicate_models import DuplicateMergeRequest, DuplicateMergeResult
from .knowledge_duplicate_rules import duplicate_merge, shape
from .knowledge_semantic import item_text
from .knowledge_versions import _END_OF_VALIDITY, invalid_property, item_revisions, lock_knowledge, \
    record_version_revision
from .provider_values import native_datetime, normalized_text, now_utc, stable_uuid
from .store_transactions import query_store_transaction

MERGE_REASON = 'The same knowledge was stored twice; this copy was merged into the item that stays current.'
CANDIDATE_LIMIT = 200
SCAN_LIMIT = 50

_ITEM_FIELDS = '''{
  item_id: {item}.uuid, name: {item}.name, summary: {item}.summary, fact: {item}.fact,
  created_at: {item}.created_at,
  confirmation_status: coalesce({item}.fuli_confirmation_status, 'pending'),
  blocked: {item}.fuli_negative_feedback_block_json IS NOT NULL
           OR size(coalesce({item}.fuli_unresolved_bases, [])) > 0,
  scope: [coalesce({item}.fuli_inheritance_mode, ''), coalesce({item}.fuli_inherited_project_ids, []),
          coalesce({item}.fuli_workflow_condition_json, ''), coalesce({item}.fuli_workflow_session_authority, '')]
}'''
_MEANING_FIELDS = '''{
  retrieval_terms: {item}.fuli_retrieval_terms, retrieval_context: {item}.fuli_retrieval_context,
  semantic_vector: {item}.fuli_semantic_vector, semantic_model: {item}.fuli_semantic_model,
  semantic_hash: {item}.fuli_semantic_hash
}'''


def _fields(name: str, template: str = _ITEM_FIELDS) -> str:
    return template.replace('{item}', name)


# Same type, current, not a preference; an entity's place is the [project,
# FLA] of the episodes that said it, as for the staleness check.
_ENTITY_CANDIDATES = f'''
MATCH (episode:Episodic {{group_id: $group_id}})-[:MENTIONS]->(item:Entity {{uuid: $item_id, group_id: $group_id}})
WHERE item.fuli_invalid_at IS NULL AND item.fuli_profile_aspect IS NULL
WITH item, collect(DISTINCT [coalesce(episode.fuli_personal_project_id, ''),
                             coalesce(episode.fuli_project_agent_id, '')]) AS places
MATCH (old_episode:Episodic {{group_id: $group_id}})-[:MENTIONS]->(old:Entity {{group_id: $group_id}})
WHERE old.uuid <> item.uuid AND old.fuli_invalid_at IS NULL AND old.fuli_profile_aspect IS NULL
  AND coalesce(old.fuli_type, 'Entity') = coalesce(item.fuli_type, 'Entity')
  AND [coalesce(old_episode.fuli_personal_project_id, ''), coalesce(old_episode.fuli_project_agent_id, '')] IN places
WITH DISTINCT item, old
RETURN item {_fields('item')} AS item, item {_fields('item', _MEANING_FIELDS)} AS item_meaning,
       old {_fields('old')} AS old, old {_fields('old', _MEANING_FIELDS)} AS old_meaning
ORDER BY old.created_at LIMIT $limit
'''
# A relationship's place is its two entities, whose IDs carry project and FLA.
_RELATIONSHIP_CANDIDATES = f'''
MATCH (source:Entity)-[item:RELATES_TO {{uuid: $item_id, group_id: $group_id}}]->(target:Entity)
WHERE item.invalid_at IS NULL AND item.fuli_profile_aspect IS NULL
MATCH (source)-[old:RELATES_TO {{group_id: $group_id}}]->(target)
WHERE old.uuid <> item.uuid AND old.name = item.name AND old.invalid_at IS NULL AND old.fuli_profile_aspect IS NULL
RETURN item {_fields('item')} AS item, null AS item_meaning, old {_fields('old')} AS old, null AS old_meaning
ORDER BY old.created_at LIMIT $limit
'''
_ENTITY_SCAN = f'''
MATCH (episode:Episodic {{group_id: $group_id}})-[:MENTIONS]->(item:Entity {{group_id: $group_id}})
WHERE item.fuli_invalid_at IS NULL AND item.fuli_profile_aspect IS NULL
WITH item, collect(DISTINCT [coalesce(episode.fuli_personal_project_id, ''),
                             coalesce(episode.fuli_project_agent_id, '')]) AS places
RETURN item {_fields('item')} AS item, coalesce(item.fuli_type, 'Entity') AS kind_key, places
'''
_RELATIONSHIP_SCAN = f'''
MATCH (source:Entity {{group_id: $group_id}})-[item:RELATES_TO {{group_id: $group_id}}]->(target:Entity)
WHERE item.invalid_at IS NULL AND item.fuli_profile_aspect IS NULL
RETURN item {_fields('item')} AS item, item.name AS kind_key, [[source.uuid, target.uuid]] AS places
'''
_MEANING = {
    'entity': f'''
        MATCH (item:Entity {{group_id: $group_id}}) WHERE item.uuid IN $item_ids
        RETURN item.uuid AS item_id, item {_fields('item', _MEANING_FIELDS)} AS meaning''',
}
_MERGE = {
    'entity': '''
        MATCH (drop:Entity {uuid: $drop_id, group_id: $group_id}) WHERE drop.fuli_invalid_at IS NULL
        MATCH (keep:Entity {uuid: $keep_id, group_id: $group_id}) WHERE keep.fuli_invalid_at IS NULL
        SET drop.fuli_ai_review_lock_version = coalesce(drop.fuli_ai_review_lock_version, 0) + 1,
            drop.fuli_invalid_at = $created_at, drop.expired_at = coalesce(drop.expired_at, $created_at),
            drop.fuli_replaced_by_item_id = keep.uuid, drop.fuli_replaced_by_item_kind = 'entity',
            keep.fuli_ai_review_lock_version = coalesce(keep.fuli_ai_review_lock_version, 0) + 1
        WITH drop, keep
        OPTIONAL MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(drop)
        WHERE NOT (episode)-[:MENTIONS]->(keep)
        WITH drop, keep, collect(DISTINCT episode) AS episodes
        FOREACH (episode IN episodes |
          CREATE (episode)-[:MENTIONS {uuid: randomUUID(), group_id: $group_id, created_at: $created_at}]->(keep))
        RETURN drop.name AS name, drop.summary AS summary, [episode IN episodes | episode.uuid] AS added''',
    'relationship': '''
        MATCH ()-[drop:RELATES_TO {uuid: $drop_id, group_id: $group_id}]->() WHERE drop.invalid_at IS NULL
        MATCH ()-[keep:RELATES_TO {uuid: $keep_id, group_id: $group_id}]->() WHERE keep.invalid_at IS NULL
        WITH drop, keep, [episode IN coalesce(drop.episodes, [])
                          WHERE NOT episode IN coalesce(keep.episodes, [])] AS added
        SET drop.fuli_ai_review_lock_version = coalesce(drop.fuli_ai_review_lock_version, 0) + 1,
            drop.invalid_at = $created_at, drop.expired_at = coalesce(drop.expired_at, $created_at),
            drop.fuli_replaced_by_item_id = keep.uuid, drop.fuli_replaced_by_item_kind = 'relationship',
            keep.fuli_ai_review_lock_version = coalesce(keep.fuli_ai_review_lock_version, 0) + 1,
            keep.episodes = coalesce(keep.episodes, []) + added
        RETURN drop.fact AS fact, added''',
}
_SPLIT_SOURCES = {
    'entity': '''
        MATCH (episode:Episodic {group_id: $group_id})-[mention:MENTIONS]->(:Entity {uuid: $keep_id, group_id: $group_id})
        WHERE episode.uuid IN $added
          AND (episode)-[:MENTIONS]->(:Entity {uuid: $item_id, group_id: $group_id})
        DELETE mention''',
    'relationship': '''
        MATCH ()-[keep:RELATES_TO {uuid: $keep_id, group_id: $group_id}]->()
        SET keep.episodes = [episode IN coalesce(keep.episodes, []) WHERE NOT episode IN $added]''',
}


async def merge_new_duplicates(scoped, actor, space, items, *, created_at) -> list[dict]:
    """Merge each newly written or confirmed item with the current copies it
    duplicates, inside the caller's transaction. Returns the items that
    stopped being current, as {'item_kind', 'item_id'}."""
    ended = []
    for item_kind, item_id in items:
        if any(gone['item_id'] == item_id for gone in ended):
            continue
        records, _, _ = await scoped.runtime.driver.execute_query(
            '// write-time supersession: duplicate merge candidates\n' + (
                _ENTITY_CANDIDATES if item_kind == 'entity' else _RELATIONSHIP_CANDIDATES),
            item_id=item_id, group_id=space['group_id'], limit=CANDIDATE_LIMIT)
        if not records:
            continue
        item = _record(item_kind, records[0]['item'], records[0]['item_meaning'])
        candidates = [_record(item_kind, record['old'], record['old_meaning']) for record in records]
        candidates = [candidate for candidate in candidates if candidate['scope'] == item['scope']]
        apart = await _kept_apart(scoped, space, item_kind, [item, *candidates])
        if item['item_id'] in apart:
            continue
        for candidate in candidates:
            if candidate['item_id'] in apart:
                continue
            merge = duplicate_merge(item, candidate)
            if not merge or not await _merge(scoped, actor, space, item_kind, merge, created_at=created_at):
                continue
            ended.append({'item_kind': item_kind, 'item_id': merge.drop['item_id']})
            if merge.drop is item:
                break
    return ended


async def merge_duplicates(store, actor, request: DuplicateMergeRequest) -> DuplicateMergeResult:
    """The periodic pass over every current item of the person's space: what
    the write-time merge missed (items written before it existed, or whose
    meaning vectors arrived later). At most request.limit merges a pass."""
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='duplicate merging is personal-only')
    created_at = now_utc()
    merged = []
    async with query_store_transaction(store) as scoped:
        await lock_knowledge(scoped, space)
        for item_kind in ('entity', 'relationship'):
            records, _, _ = await scoped.runtime.driver.execute_query(
                '// duplicate merge: scan\n' + (_ENTITY_SCAN if item_kind == 'entity' else _RELATIONSHIP_SCAN),
                group_id=space['group_id'], routing_='r')
            items = {record['item']['item_id']: {**_record(item_kind, record['item']), 'kind_key': record['kind_key'],
                                                 'places': [tuple(place) for place in record['places']]}
                     for record in records}
            apart = await _kept_apart(scoped, space, item_kind, items.values())
            groups = _groups([item for item in items.values() if item['item_id'] not in apart])
            await _with_meaning(scoped, space, item_kind, groups)
            for group in groups:
                for merge in _group_merges(group):
                    if len(merged) >= request.limit:
                        return DuplicateMergeResult(merged=merged)
                    if await _merge(scoped, actor, space, item_kind, merge, created_at=created_at):
                        merged.append({'item_kind': item_kind, 'item_id': merge.drop['item_id'],
                                       'kept_item_id': merge.keep['item_id'], 'rule': merge.rule})
    return DuplicateMergeResult(merged=merged)


def _groups(items) -> list[list[dict]]:
    """Items that may be one: same type (or relation), a shared place and the
    same scope settings, then the same sentence or the same name."""
    places = {}
    for item in items:
        for place in item['places']:
            places.setdefault((item['kind_key'], place, repr(item['scope'])), []).append(item)
    groups, seen = [], set()
    for members in places.values():
        by_words = {}
        for item in members:
            by_words.setdefault(('template', shape(item['text']).template), []).append(item)
            name = normalized_text(item.get('name'))
            if name:
                by_words.setdefault(('name', name), []).append(item)
        for group in by_words.values():
            ids = tuple(sorted(item['item_id'] for item in group))
            if len(group) > 1 and ids not in seen:
                seen.add(ids)
                groups.append(group)
    return groups


def _group_merges(group):
    """Each merge in one group, oldest pairs first; an item that ended or was
    replaced by a longer list takes no further part."""
    alive = sorted(group, key=lambda item: (native_datetime(item['created_at']) is None,
                                            native_datetime(item['created_at']) or 0, item['item_id']))
    gone = set()
    for index, first in enumerate(alive):
        for second in alive[index + 1:]:
            if first['item_id'] in gone or second['item_id'] in gone or first.get('ended') or second.get('ended'):
                continue
            merge = duplicate_merge(first, second)
            if merge:
                gone.add(merge.drop['item_id'])
                merge.drop['ended'] = True
                yield merge


async def _with_meaning(scoped, space, item_kind, groups) -> None:
    """Stored meaning vectors only for the entities that share a name with
    another: nothing else can be the same in meaning."""
    if item_kind != 'entity':
        return
    named = {item['item_id']: item for group in groups for item in group if item.get('name')}
    if not named:
        return
    records, _, _ = await scoped.runtime.driver.execute_query(
        _MEANING['entity'], item_ids=list(named), group_id=space['group_id'], routing_='r')
    for record in records:
        named[record['item_id']].update(record['meaning'] or {})


async def _merge(scoped, actor, space, item_kind, merge, *, created_at) -> bool:
    """End merge.drop into merge.keep with its sources; False when either
    stopped being current meanwhile."""
    records, _, _ = await scoped.runtime.driver.execute_query(
        '// duplicate merge\n' + _MERGE[item_kind], drop_id=merge.drop['item_id'], keep_id=merge.keep['item_id'],
        group_id=space['group_id'], created_at=created_at)
    if not records:
        return False
    record = records[0]
    words = {'name': record['name'], 'summary': record['summary']} if item_kind == 'entity' else {'fact': record['fact']}
    await record_version_revision(
        scoped, actor, space, item_kind, merge.drop['item_id'],
        revision_id=stable_uuid(space['id'], 'knowledge-revision', 'duplicate-merge', item_kind,
                                merge.drop['item_id'], merge.keep['item_id'], created_at.isoformat()),
        action='supersede', reason=MERGE_REASON, previous={**words, 'invalidAt': None},
        current={**words, 'invalidAt': created_at.isoformat(), 'replacedByItemId': merge.keep['item_id'],
                 'replacedByItemKind': item_kind,
                 'duplicateMerge': {'rule': merge.rule, 'addedSources': list(record['added'] or [])}},
        changed_by='agent', created_at=created_at)
    return True


async def _kept_apart(scoped, space, item_kind, items) -> set[str]:
    """Items a person split out of a merge: they stay apart from now on."""
    ids = [item['item_id'] for item in items]
    revisions = await item_revisions(scoped, space, item_kind, ids)
    return {item_id for item_id, found in revisions.items()
            if any(revision.action == 'restore' and revision.current.get('duplicateSplit') for revision in found)}


def _record(item_kind, values, meaning=None) -> dict:
    values = dict(values or {})
    if item_kind == 'relationship':
        values.pop('name', None)  # the relation type, already the same for every candidate
    return {**values, **(meaning or {}), 'text': item_text(item_kind, values),
            'scope': repr(values.get('scope'))}


def merged_duplicate(current: dict, revisions) -> dict | None:
    """The duplicate merge that ended this item, while its link still points
    where that merge put it: what a person's restore splits back out."""
    ended = max((revision for revision in revisions if revision.action in _END_OF_VALIDITY),
                key=lambda revision: revision.created_at, default=None)
    if not ended or ended.action != 'supersede' or not ended.current.get('duplicateMerge'):
        return None
    if current.get('replaced_by_item_id') != ended.current.get('replacedByItemId'):
        return None
    if any(revision.action == 'restore' and revision.created_at > ended.created_at for revision in revisions):
        return None
    return ended.current


async def split_duplicate(store, actor, space, item_kind, item_id, merge, previous, *, reason, created_at,
                          revision_id) -> KnowledgeRevisionRecord:
    """A person's restore of a merged copy: it is current again on its own,
    the kept item gives back the sources the merge added, and the two are
    never merged automatically again."""
    keep_id = merge['replacedByItemId']
    invalid = invalid_property(item_kind)
    match = ('MATCH (item:Entity {uuid: $item_id, group_id: $group_id})' if item_kind == 'entity'
             else 'MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()')
    async with query_store_transaction(store) as scoped:
        await lock_knowledge(scoped, space)
        records, _, _ = await scoped.runtime.driver.execute_query(
            match + f'''
            WHERE item.{invalid} IS NOT NULL AND item.fuli_replaced_by_item_id = $keep_id
            SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1,
                item.{invalid} = NULL, item.expired_at = NULL,
                item.fuli_replaced_by_item_id = NULL, item.fuli_replaced_by_item_kind = NULL
            RETURN item.uuid AS item_id
            ''', item_id=item_id, keep_id=keep_id, group_id=space['group_id'])
        if not records:
            raise HTTPException(status_code=409, detail='knowledge changed while it was being split; read it again')
        await scoped.runtime.driver.execute_query(
            _SPLIT_SOURCES[item_kind], item_id=item_id, keep_id=keep_id,
            added=list((merge.get('duplicateMerge') or {}).get('addedSources') or []), group_id=space['group_id'])
        restored = {**previous, 'invalidAt': None, 'replacedByItemId': None, 'replacedByItemKind': None,
                    'duplicateSplit': {'fromItemId': keep_id}}
        await record_version_revision(scoped, actor, space, item_kind, item_id, revision_id=revision_id,
                                      action='restore', reason=reason, previous=previous, current=restored,
                                      changed_by='user', created_at=created_at)
        await record_human_change(scoped, actor, space, item_id, item_kind, reason=reason,
                                  operation='knowledge_restore')
    return KnowledgeRevisionRecord(id=revision_id, item_id=item_id, item_kind=item_kind, action='restore',
                                   reason=reason, previous=previous, current=restored, created_at=created_at,
                                   changed_by='user')


def register_knowledge_duplicate_routes(application, store, Actor) -> None:
    @application.post('/v1/knowledge/duplicates/merge', response_model=DuplicateMergeResult)
    async def knowledge_duplicates_merge(request: DuplicateMergeRequest, actor: Actor):
        return await merge_duplicates(store, actor, request)
