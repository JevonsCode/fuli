"""Versions of one knowledge item (rec#5 C7, C8-3).

An edit never overwrites what an item said. It writes a new version that
supersedes the old one: the old keeps its words, sources, source label and
confirmation, its validity ends where the new one starts, and
fuli_replaced_by_item_id points at the new version (the link a capture's
`supersedes` already writes). Current answers only read items whose validity
has not ended, so every reader, cached or not, gets the newest version on its
next read; an old link opens history.

The new version is found exactly where the old one was: its scope, key, tags,
project assignment and project references are carried over, and its evidence
is one edit episode for each project and FLA the old sources were in. No
session claims words it never said, and usage starts again. Re-asserting an
item that went out of date writes a new version the same way and keeps the
interval in which it was not valid.
"""
import json

from fastapi import HTTPException

from .graph_field_contract import carried_fields, stored_fields
from .knowledge_audit import _item_match
from .knowledge_item_version import lock_version
from .knowledge_item_view_models import KnowledgeVersionStatus as VersionStatus
from .knowledge_management import _read_assignment, _update_item, write_project_assignment
from .knowledge_records import revision_record
from .knowledge_tags import tag_link_id
from .provider_values import native_datetime, stable_uuid

# The revision that ended an item's validity names why it is history.
# `invalidate` is a plain deactivation unless it named a replacement.
_END_OF_VALIDITY = {'supersede': 'superseded', 'mark_outdated': 'outdated',
                    'basis_outdated': 'basis_outdated', 'invalidate': None}
EXCERPT_LIMIT = 2048
# Copied from the old version would describe a review or a person's change of
# the old words, not of the new ones; the new version earns its own.
_NOT_CARRIED = frozenset({
    'fuli_ai_reviewed_at', 'fuli_ai_review_scope', 'fuli_ai_review_project_id', 'fuli_ai_review_id',
    'fuli_ai_review_evidence_token', 'fuli_ai_review_decision_id', 'fuli_ai_assessment_json',
    'fuli_human_edited', 'fuli_human_change_version', 'fuli_human_change_status',
    'fuli_last_human_changed_at', 'fuli_last_agent_viewed_at', 'fuli_last_agent_reviewed_at',
    'fuli_replaced_by_item_id', 'fuli_replaced_by_item_kind', 'expired_at',
})


async def lock_knowledge(scoped, space) -> None:
    """Take the space's knowledge write lock inside the caller's transaction.
    New versions, captures (with the version heads they land on and the bases
    they name) and the outdated mark all take it first, so each decides on
    what is stored now and none interleaves another (rec#5 C7/C8). Neo4j holds
    the lock until the transaction ends, across Provider processes."""
    await scoped.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id})
        SET space._knowledge_lock = true REMOVE space._knowledge_lock
        ''', space_id=space['id'])


def invalid_property(item_kind: str) -> str:
    return 'fuli_invalid_at' if item_kind == 'entity' else 'invalid_at'


def version_status(invalid_at, replaced_by_item_id, revisions) -> VersionStatus:
    """Why an item is history, from the revision that ended its validity.
    A capture's supersede writes no revision; its replacement link says it."""
    if not invalid_at:
        return 'current'
    ended = ending_action(revisions)
    if ended and _END_OF_VALIDITY[ended]:
        return _END_OF_VALIDITY[ended]
    return 'superseded' if replaced_by_item_id else 'inactive'


# Once a version was replaced or went out of date it stays history: neither
# a later deactivation nor a restore can give it back its validity.
TERMINAL_ACTIONS = frozenset({'supersede', 'mark_outdated', 'basis_outdated', 'reassert'})


def terminal(current: dict, revisions) -> bool:
    """From durable facts, not the latest action: a successor link (a newer
    version, a capture's supersedes, a re-assertion) or any recorded end."""
    return bool(current.get('replaced_by_item_id')) or any(
        revision.action in TERMINAL_ACTIONS for revision in revisions)


def ending_action(revisions) -> str | None:
    """The revision action that ended the item's validity, if one did."""
    ended = max((revision for revision in revisions if revision.action in _END_OF_VALIDITY),
                key=lambda revision: revision.created_at, default=None)
    return ended.action if ended else None


def version_value(previous: dict, next_value: dict, *, explicit_confirmation: bool, changed_by: str,
                  reason: str, created_at) -> dict:
    """The new version's stored state. Its usage starts again. A person's edit
    is the person's own statement, confirmed by them (C7-3); an Agent's
    rewrite waits for a person and keeps any negative-feedback block, which
    only a person lifts. A caller that named a confirmation keeps it."""
    value = {**next_value, 'invalidAt': None, 'replacedByItemId': None, 'replacedByItemKind': None,
             'usageGeneration': 1, 'utilityScore': 0.0, 'qualifiedUseCount': 0, 'distinctTaskCount': 0,
             'lastUsedAt': None, 'negativeEvidenceCount': int(previous.get('negativeEvidenceCount') or 0),
             'requiresAttention': previous.get('requiresAttention') is True}
    if changed_by == 'user':
        # The person's revision answers the attention flag; the negative
        # evidence that raised it stays as history.
        value['requiresAttention'] = False
    if explicit_confirmation:
        return value
    quadrant_reason = (previous.get('confirmationBasis') or {}).get('quadrant_reason') or reason
    if changed_by == 'user':
        value.update({
            'confirmationStatus': 'confirmed', 'confirmationStateExplicit': True, 'epistemicStatus': 'confirmed',
            'confidenceScore': 1.0, 'negativeFeedbackBlock': None,
            'confirmationBasis': {'existence_reason': reason, 'quadrant_reason': quadrant_reason,
                                  'proposed_by': {'kind': 'user'}, 'confirmed_by': {'kind': 'user'},
                                  'confirmed_at': created_at.isoformat()},
        })
        return value
    value.update({
        'confirmationStatus': 'pending', 'confirmationStateExplicit': True, 'confidenceScore': 0.5,
        'epistemicStatus': 'exploratory' if value.get('originQuadrant') == 'unknown_unknown' else 'observed',
        'negativeFeedbackBlock': previous.get('negativeFeedbackBlock'),
        'confirmationBasis': {'existence_reason': reason, 'quadrant_reason': quadrant_reason,
                              'proposed_by': {'kind': 'agent'}},
    })
    return value


# Versions that went out of date; asserting one again writes a new version.
REASSERTABLE = frozenset({'outdated', 'basis_outdated'})


def creates_version(current: dict, status: VersionStatus, content_changed: bool) -> bool:
    """A content edit of the current version or of a deactivated one, or any
    re-assertion of a version that went out of date, writes a new version when
    no newer one exists; nothing rewrites history in place (D-20.5). A plain
    deactivation still keeps its own restore."""
    if current.get('replaced_by_item_id') and status != 'current':
        return False
    if status in ('current', 'inactive'):
        return content_changed
    return status in REASSERTABLE


async def write_version(scoped, actor, space, item_kind, item_id, current, value, *, embedding,
                        reason, changed_by, created_at, revision_id, previous_snapshot) -> str:
    """Write `value` as the new version of `item_id` inside the caller's
    transaction and return its ID. `current` is the old version as read."""
    new_id = stable_uuid(space['id'], 'knowledge-version', item_kind, item_id, revision_id)
    params = {'item_id': item_id, 'group_id': space['group_id']}
    await lock_knowledge(scoped, space)
    records, _, _ = await scoped.runtime.driver.execute_query(
        _item_match(item_kind) + '''
        SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1
        WITH item WHERE item.fuli_ai_review_lock_version = $expected + 1
        RETURN properties(item) AS properties
        ''', expected=lock_version(current), **params)
    if not records:
        raise HTTPException(status_code=409, detail='knowledge changed while it was being revised; read it again')
    reasserted = bool(current.get('invalid_at'))
    stored = dict(records[0]['properties'])
    # A new version rests only on knowledge that is current now, like a
    # capture's derived_from (422 derived_from_not_current): an edited basis is
    # followed to its current version, one that went out of date is dropped.
    named = list(stored.get('fuli_derived_from_item_ids') or [])
    kept = await current_bases(scoped, space, named)
    released = [basis for basis in named if basis not in kept
                and await current_version_id(scoped, space, await _item_kind(scoped, space, basis) or item_kind,
                                             basis) is None]
    carried, overrides = _carried_properties(stored, item_kind, new_id, changed_by, created_at)
    properties, legacy_keys = carried_fields('Entity' if item_kind == 'entity' else 'RELATES_TO', carried,
                                             {**overrides, 'fuli_derived_from_item_ids': kept or None})
    await _create_item(scoped, space, item_kind, item_id, new_id, properties)
    await _update_item(scoped, space, new_id, item_kind,
                       {**value, 'invalidAt': None, 'replacedByItemId': None, 'replacedByItemKind': None},
                       embedding, expected_lock_version=0)
    invalid = invalid_property(item_kind)
    # The old version ends where the new one starts; one that already went out
    # of date keeps the end it had, so the interval without it stays visible.
    await scoped.runtime.driver.execute_query(
        _item_match(item_kind) + f'''
        SET item.fuli_replaced_by_item_id = $new_id, item.fuli_replaced_by_item_kind = $item_kind,
            item.{invalid} = coalesce(item.{invalid}, $created_at),
            item.expired_at = coalesce(item.expired_at, $created_at)
        ''', new_id=new_id, item_kind=item_kind, created_at=created_at, **params)
    await _write_edit_episodes(scoped, space, item_kind, item_id, new_id, value, reason=reason,
                               changed_by=changed_by, created_at=created_at, revision_id=revision_id)
    assignment = await _read_assignment(scoped, space['id'], item_id, item_kind)
    if assignment:
        await write_project_assignment(scoped, space, new_id, item_kind, assignment.project_id,
                                       previous_project_id=None, existing=None, reason=reason,
                                       changed_by=actor['id'])
    await _carry_tags(scoped, space, item_kind, item_id, new_id, created_at)
    await _carry_references(scoped, space, item_kind, item_id, new_id, created_at)
    await record_version_revision(
        scoped, actor, space, item_kind, item_id, revision_id=revision_id,
        action='reassert' if reasserted else 'supersede', reason=reason,
        previous=previous_snapshot,
        current={**previous_snapshot, 'invalidAt': previous_snapshot.get('invalidAt') or created_at.isoformat(),
                 'replacedByItemId': new_id, 'replacedByItemKind': item_kind,
                 **({'releasedBases': released} if released else {}),
                 # Names only: properties an older FULI stored that the new version kept.
                 **({'carriedLegacyKeys': legacy_keys} if legacy_keys else {})},
        changed_by=changed_by, created_at=created_at)
    return new_id


async def reasserted_entities(store, space, entity_ids, episode_id) -> dict[str, dict]:
    """Where a capture's mention of an entity lands once that entity has
    versions (C8-3, D-20.6). A capture always lands on the head of the version
    chain, never on a replaced version, which no later write changes. Returns
    captured ID -> {item_id[, head_id]} for each one that does not land on
    itself:
    - the head is current (an edit, a re-assertion): the mention lands there
      as ordinary evidence;
    - the head went out of date: the capture asserts it again and writes a new
      version (item_id) after head_id, with its episode as the new evidence; a
      replay of the same episode finds the same version."""
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        UNWIND $item_ids AS id
        MATCH (item:Entity {uuid: id, group_id: $group_id})
        WHERE item.fuli_invalid_at IS NOT NULL OR item.fuli_replaced_by_item_id IS NOT NULL
        RETURN item.uuid AS item_id
        ''', item_ids=list(dict.fromkeys(entity_ids)), group_id=space['group_id'], routing_='r')
    found = {}
    for entity_id in (record['item_id'] for record in records):
        landing = await _reassertion_landing(store, space, entity_id, episode_id)
        if landing and landing['item_id'] != entity_id:
            found[entity_id] = landing
    return found


async def _reassertion_landing(store, space, entity_id, episode_id) -> dict | None:
    item_id, seen = entity_id, set()
    while item_id not in seen:
        seen.add(item_id)
        records = await _version_records(store, space, 'entity', [item_id])
        if not records:
            return None
        record = records[0]
        version_id = stable_uuid(space['id'], 'knowledge-version', 'entity', item_id, episode_id)
        if record['replaced_by_item_id'] == version_id:
            return {'item_id': version_id, 'head_id': item_id}
        if not record['replaced_by_item_id']:
            out_of_date = bool(record['invalid_at']) and await _went_out_of_date(store, space, item_id)
            return {'item_id': version_id, 'head_id': item_id} if out_of_date else {'item_id': item_id}
        if record['replaced_by_item_kind'] not in (None, 'entity'):
            return {'item_id': item_id}
        item_id = record['replaced_by_item_id']
    return None


async def link_reasserted(store, space, reasserted: dict, *, episode_id, actor_id, created_at) -> None:
    """Point each out-of-date version at the version its re-assertion wrote."""
    for row in reasserted.values():
        if 'head_id' not in row:
            continue
        records, _, _ = await store.runtime.driver.execute_query(
            '''
            MATCH (item:Entity {uuid: $head_id, group_id: $group_id})
            WHERE item.fuli_replaced_by_item_id IS NULL
            SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1,
                item.fuli_replaced_by_item_id = $version_id, item.fuli_replaced_by_item_kind = 'entity'
            RETURN item.uuid AS item_id
            ''', head_id=row['head_id'], version_id=row['item_id'], group_id=space['group_id'])
        if not records:
            # Raising rolls back the new version and its episode with it.
            raise HTTPException(status_code=409, detail={
                'code': 'versions_changed',
                'message': 'another version replaced it meanwhile; retry the capture'})
        await record_version_revision(
                store, {'id': actor_id}, space, 'entity', row['head_id'],
                revision_id=stable_uuid(space['id'], 'knowledge-revision', 'entity', row['head_id'],
                                        'reassert', episode_id),
                action='reassert', reason='A later capture asserted it again with new evidence.',
                previous={}, current={'replacedByItemId': row['item_id'], 'replacedByItemKind': 'entity',
                                      'episodeId': episode_id},
                changed_by='agent', created_at=created_at)


async def _went_out_of_date(store, space, item_id) -> bool:
    revisions = (await item_revisions(store, space, 'entity', [item_id])).get(item_id, [])
    return _END_OF_VALIDITY.get(ending_action(revisions)) in REASSERTABLE


async def record_version_revision(store, actor, space, item_kind, item_id, *, revision_id, action, reason,
                                  previous, current, changed_by, created_at) -> None:
    await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        CREATE (revision:FuliKnowledgeRevision {
          id: $revision_id, space_id: $space_id, item_id: $item_id, item_kind: $item_kind,
          action: $action, reason: $reason, previous_json: $previous_json, current_json: $current_json,
          created_by: $created_by, created_at: $created_at
        })
        MERGE (space)-[:HAS_KNOWLEDGE_REVISION]->(revision)
        ''', space_id=space['id'], revision_id=revision_id, item_id=item_id, item_kind=item_kind,
        action=action, reason=reason, previous_json=_json(previous),
        current_json=_json({**current, 'changedBy': changed_by}), created_by=actor['id'],
        created_at=created_at)


async def version_chain(store, space, item_kind, item_id) -> list[dict]:
    """Every version of the item, newest first: the ones it replaced and the
    ones that replaced it, each with why it is history and who wrote it."""
    ids = await lineage_ids(store, space, item_kind, item_id)
    newer = item_id
    while True:
        records = await _version_records(store, space, item_kind, [newer])
        newer = records[0]['replaced_by_item_id'] if records else None
        if not newer or newer in ids or records[0]['replaced_by_item_kind'] not in (None, item_kind):
            break
        ids.append(newer)
    records = await _version_records(store, space, item_kind, ids)
    revisions = await item_revisions(store, space, item_kind, ids)
    created_by = {revision.current.get('replacedByItemId'): revision
                  for revisions_of_item in revisions.values() for revision in revisions_of_item
                  if revision.action in ('supersede', 'reassert')}
    versions = []
    for record in records:
        made = created_by.get(record['item_id'])
        versions.append({
            'item_kind': item_kind, 'item_id': record['item_id'],
            'content': record['content'] or record['title'] or record['item_id'],
            'status': version_status(record['invalid_at'], record['replaced_by_item_id'],
                                     revisions.get(record['item_id'], [])),
            'confirmation_status': record['confirmation_status'] or 'pending',
            'content_source': record['content_source'],
            'changed_by': made.changed_by if made else _first_author(record['content_source']),
            'reason': made.reason if made else None,
            'released_bases': list(made.current.get('releasedBases') or []) if made else [],
            'created_at': native_datetime(record['created_at']),
            'invalid_at': native_datetime(record['invalid_at']),
        })
    return sorted(versions, key=lambda version: version['created_at'].timestamp() if version['created_at'] else 0,
                  reverse=True)


async def current_version_id(store, space, item_kind, item_id) -> str | None:
    """The version current answers use in this item's chain, if any."""
    for version in await version_chain(store, space, item_kind, item_id):
        if version['status'] == 'current':
            return version['item_id']
    return None


async def current_bases(store, space, item_ids) -> list[str]:
    """Each basis followed to its current version; out-of-date ones dropped."""
    found = []
    for item_id in item_ids:
        kind = await _item_kind(store, space, item_id)
        head = await current_version_id(store, space, kind, item_id) if kind else None
        if head and head not in found:
            found.append(head)
    return found


async def _item_kind(store, space, item_id) -> str | None:
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        OPTIONAL MATCH (entity:Entity {uuid: $item_id, group_id: $group_id})
        OPTIONAL MATCH ()-[edge:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
        RETURN entity IS NOT NULL AS entity, edge IS NOT NULL AS relationship
        ''', item_id=item_id, group_id=space['group_id'], routing_='r')
    if not records:
        return None
    return 'entity' if records[0]['entity'] else 'relationship' if records[0]['relationship'] else None


async def lineage_ids(store, space, item_kind, item_id) -> list[str]:
    """The item and every earlier version of it: what a conclusion drawn from
    any of them names."""
    ids, frontier = [item_id], [item_id]
    while frontier:
        frontier = [found for found in await _predecessors(store, space, item_kind, frontier) if found not in ids]
        ids.extend(frontier)
    return ids


async def item_revisions(store, space, item_kind, item_ids) -> dict:
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_KNOWLEDGE_REVISION]->
              (revision:FuliKnowledgeRevision {item_kind: $item_kind})
        WHERE revision.item_id IN $item_ids
        RETURN revision ORDER BY revision.created_at DESC
        ''', space_id=space['id'], item_kind=item_kind, item_ids=list(item_ids), routing_='r')
    found = {}
    for record in records:
        revision = revision_record(dict(record['revision']))
        found.setdefault(revision.item_id, []).append(revision)
    return found


async def _predecessors(store, space, item_kind, item_ids) -> list[str]:
    match = ('MATCH (item:Entity {group_id: $group_id})' if item_kind == 'entity'
             else 'MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()')
    records, _, _ = await store.runtime.driver.execute_query(
        match + '''
        WHERE item.fuli_replaced_by_item_id IN $item_ids
          AND coalesce(item.fuli_replaced_by_item_kind, $item_kind) = $item_kind
        RETURN item.uuid AS item_id ORDER BY item.created_at
        ''', group_id=space['group_id'], item_ids=list(item_ids), item_kind=item_kind, routing_='r')
    return [record['item_id'] for record in records]


async def _version_records(store, space, item_kind, item_ids) -> list[dict]:
    if item_kind == 'entity':
        query = '''
        UNWIND $item_ids AS id
        MATCH (item:Entity {uuid: id, group_id: $group_id})
        RETURN item.uuid AS item_id, item.name AS title, coalesce(item.summary, item.name) AS content,
               item.fuli_invalid_at AS invalid_at,
        '''
    else:
        query = '''
        UNWIND $item_ids AS id
        MATCH ()-[item:RELATES_TO {uuid: id, group_id: $group_id}]->()
        RETURN item.uuid AS item_id, item.name AS title, item.fact AS content,
               item.invalid_at AS invalid_at,
        '''
    records, _, _ = await store.runtime.driver.execute_query(
        query + '''
               item.fuli_replaced_by_item_id AS replaced_by_item_id,
               item.fuli_replaced_by_item_kind AS replaced_by_item_kind,
               item.fuli_confirmation_status AS confirmation_status,
               item.fuli_content_source AS content_source, item.created_at AS created_at
        ''', item_ids=list(item_ids), group_id=space['group_id'], routing_='r')
    return [dict(record) for record in records]


def _first_author(content_source):
    return {'user_explicit': 'user', 'agent_inferred': 'agent'}.get(content_source)


def _carried_properties(stored, item_kind, new_id, changed_by, created_at) -> tuple[dict, dict]:
    """The old version's properties the new one keeps, and the ones it sets."""
    dropped = _NOT_CARRIED | {invalid_property(item_kind), 'fuli_derived_from_item_ids'}
    if changed_by == 'user':
        # A person's own version is their review: it waits for no basis. An
        # Agent's rewrite keeps waiting where the old one did.
        dropped |= {'fuli_unresolved_bases'}
    carried = {key: item for key, item in stored.items() if key not in dropped and item is not None}
    overrides = {
        'uuid': new_id, 'created_at': created_at, 'fuli_ai_review_lock_version': 0,
        'fuli_content_source': 'user_explicit' if changed_by == 'user' else 'agent_inferred',
    }
    if item_kind == 'relationship':
        overrides.update({'valid_at': created_at, 'reference_time': created_at, 'episodes': []})
    return carried, overrides


async def _create_item(scoped, space, item_kind, item_id, new_id, properties) -> None:
    if item_kind == 'entity':
        query = 'CREATE (item:Entity) SET item = $properties RETURN item.uuid AS item_id'
    else:
        query = '''
        MATCH (source)-[old:RELATES_TO {uuid: $item_id, group_id: $group_id}]->(target)
        CREATE (source)-[item:RELATES_TO]->(target)
        SET item = $properties
        RETURN item.uuid AS item_id
        '''
    records, _, _ = await scoped.runtime.driver.execute_query(
        query, properties=properties, item_id=item_id, group_id=space['group_id'])
    if not records or records[0]['item_id'] != new_id:
        raise HTTPException(status_code=409, detail='knowledge changed while its new version was written')


async def _write_edit_episodes(scoped, space, item_kind, item_id, new_id, value, *, reason, changed_by,
                               created_at, revision_id) -> None:
    """One edit episode for each project and FLA the old version's sources were
    in, so the new version is visible exactly where the old one was."""
    if item_kind == 'entity':
        source = '''
        MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(:Entity {uuid: $item_id, group_id: $group_id})
        '''
    else:
        source = '''
        MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
        UNWIND coalesce(item.episodes, []) AS episode_id
        MATCH (episode:Episodic {uuid: episode_id, group_id: $group_id})
        '''
    records, _, _ = await scoped.runtime.driver.execute_query(
        source + '''
        RETURN DISTINCT episode.fuli_personal_project_id AS project_id,
               episode.fuli_project_agent_id AS agent_id
        ORDER BY project_id, agent_id
        ''', item_id=item_id, group_id=space['group_id'])
    if not records:
        return
    content = (value.get('summary') or value.get('name')) if item_kind == 'entity' else value.get('fact')
    episodes = [{'uuid': stable_uuid(space['id'], 'knowledge-edit-episode', revision_id, str(index)),
                 'project_id': record['project_id'], 'agent_id': record['agent_id']}
                for index, record in enumerate(records)]
    await scoped.runtime.driver.execute_query(
        '''
        UNWIND $episodes AS row
        CREATE (episode:Episodic {
          uuid: row.uuid, group_id: $group_id, name: 'Knowledge edit', source: 'json',
          source_description: $reason, content: '', valid_at: $created_at, created_at: $created_at,
          entity_edges: $entity_edges, fuli_source_kind: $source_kind, fuli_source_excerpt: $excerpt,
          fuli_summary: $reason, fuli_sensitivity: 'private', fuli_personal_project_id: row.project_id,
          fuli_project_agent_id: row.agent_id, fuli_idempotency_key: row.uuid
        })
        ''', episodes=episodes, group_id=space['group_id'], reason=reason, created_at=created_at,
        entity_edges=[new_id] if item_kind == 'relationship' else [],
        source_kind='human_knowledge_edit' if changed_by == 'user' else 'agent_knowledge_edit',
        excerpt=(content or '')[:EXCERPT_LIMIT] or None)
    if item_kind == 'entity':
        await scoped.runtime.driver.execute_query(
            '''
            UNWIND $episodes AS row
            MATCH (episode:Episodic {uuid: row.uuid, group_id: $group_id})
            MATCH (item:Entity {uuid: $new_id, group_id: $group_id})
            MERGE (episode)-[mention:MENTIONS {uuid: row.uuid + ':mention'}]->(item)
            SET mention.group_id = $group_id, mention.created_at = $created_at
            ''', episodes=episodes, group_id=space['group_id'], new_id=new_id, created_at=created_at)
    else:
        await scoped.runtime.driver.execute_query(
            '''
            MATCH ()-[item:RELATES_TO {uuid: $new_id, group_id: $group_id}]->()
            SET item.episodes = $episode_ids
            ''', new_id=new_id, group_id=space['group_id'],
            episode_ids=[episode['uuid'] for episode in episodes])


async def _carry_tags(scoped, space, item_kind, item_id, new_id, created_at) -> None:
    """The new version carries the tags attached now; the old one keeps its own."""
    records, _, _ = await scoped.runtime.driver.execute_query(
        '''
        MATCH (tag:FuliKnowledgeTag {space_id: $space_id})-[:TAGS]->
              (link:FuliKnowledgeTagLink {space_id: $space_id, item_kind: $item_kind,
                                          item_id: $item_id, status: 'attached'})
        RETURN tag.id AS tag_id, link.attached_by_kind AS attached_by_kind
        ''', space_id=space['id'], item_kind=item_kind, item_id=item_id)
    if not records:
        return
    # The same link shape the tag vocabulary attaches (knowledge_tags.attach_tag).
    links = [stored_fields('FuliKnowledgeTagLink', {
        'id': tag_link_id(space['id'], record['tag_id'], item_kind, new_id), 'space_id': space['id'],
        'tag_id': record['tag_id'], 'item_kind': item_kind, 'item_id': new_id, 'status': 'attached',
        'attached_at': created_at, 'attached_by_kind': record['attached_by_kind'], 'detached_at': None,
        'version': 1}) for record in records]
    await scoped.runtime.driver.execute_query(
        '''
        UNWIND $links AS row
        MATCH (tag:FuliKnowledgeTag {id: row.tag_id, space_id: $space_id})
        MERGE (link:FuliKnowledgeTagLink {id: row.id})
        SET link += row
        MERGE (tag)-[:TAGS]->(link)
        ''', space_id=space['id'], links=links)


async def _carry_references(scoped, space, item_kind, item_id, new_id, created_at) -> None:
    records, _, _ = await scoped.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_KNOWLEDGE_REFERENCE]->
              (reference:FuliKnowledgeProjectReference {item_kind: $item_kind, item_id: $item_id,
                                                        status: 'active'})
        RETURN reference.project_id AS project_id
        ''', space_id=space['id'], item_kind=item_kind, item_id=item_id)
    if not records:
        return
    await scoped.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_KNOWLEDGE_REFERENCE]->
              (old:FuliKnowledgeProjectReference {item_kind: $item_kind, item_id: $item_id, status: 'active'})
              -[:REFERENCES_IN]->(target)
        WITH space, old, target, head([row IN $references WHERE row.project_id = old.project_id]) AS row
        // One map, so the copy never holds the old reference's unique id.
        CREATE (reference:FuliKnowledgeProjectReference)
        SET reference = old {.*, id: row.id, item_id: $new_id, created_at: $created_at, updated_at: $created_at}
        MERGE (space)-[:HAS_KNOWLEDGE_REFERENCE]->(reference)
        MERGE (reference)-[:REFERENCES_IN]->(target)
        ''', space_id=space['id'], item_kind=item_kind, item_id=item_id, new_id=new_id,
        created_at=created_at,
        references=[{'project_id': record['project_id'],
                     'id': stable_uuid(space['id'], 'knowledge-reference-version', item_kind, new_id,
                                       record['project_id'])} for record in records])


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
