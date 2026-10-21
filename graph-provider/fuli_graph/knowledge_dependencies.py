"""What a conclusion rests on (rec#5 C8-4, G3-3).

An item may name the knowledge it was concluded from (a capture's
`derived_from`, stored as fuli_derived_from_item_ids), and a personal-global
preference rests on the project preferences its approved decision named. When
any of those goes out of date, the conclusion is no longer a current fact: its
validity ends with a `basis_outdated` revision that names what went out of
date, and it moves to history like its basis. Conclusions drawn from it
follow, however deep the chain: a walk is never cut short and taken as
complete. A basis edited into a new version still holds, so an edit changes
nothing here (the conclusion's page asks a person to look again), and a
conclusion that names an earlier version of its basis, or a decision that
names an earlier version of its assertion, is found through those versions.
"""
import json
from datetime import datetime

from fastapi import HTTPException

from .knowledge_audit import _item_match
from .knowledge_management import _read_item, _snapshot
from .knowledge_versions import (
    current_version_id, invalid_property, item_revisions, lineage_ids, record_version_revision, version_status,
)
from .provider_values import stable_uuid

_DEPENDENTS = '''
CALL {
  MATCH (item:Entity {group_id: $group_id})
  WHERE item.fuli_invalid_at IS NULL
    AND any(basis IN coalesce(item.fuli_derived_from_item_ids, []) WHERE basis IN $lineage)
  RETURN 'entity' AS item_kind, item.uuid AS item_id
  UNION
  MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()
  WHERE item.invalid_at IS NULL
    AND any(basis IN coalesce(item.fuli_derived_from_item_ids, []) WHERE basis IN $lineage)
  RETURN 'relationship' AS item_kind, item.uuid AS item_id
}
RETURN DISTINCT item_kind, item_id ORDER BY item_kind, item_id
'''
# The assertions of approved personal-global decisions whose sources name the
# basis; the assertion may have new versions since the decision named it.
_DECISION_ASSERTIONS = '''
MATCH (decision:FuliPersonalGlobalPreferenceDecision {space_id: $space_id})
WHERE decision.global_assertion_id IS NOT NULL
MATCH (event:FuliPersonalGlobalPreferenceDecisionEvent {space_id: $space_id, id: decision.current_event_id})
WHERE any(basis IN $lineage WHERE event.source_items_json CONTAINS ('"' + basis + '"'))
RETURN DISTINCT decision.global_assertion_id AS item_id
'''


async def require_current_bases(store, space: dict, item_ids: list[str]) -> None:
    """A capture may only conclude from knowledge that is current now."""
    if not item_ids:
        return
    found = {basis['item_id']: basis for basis in await _basis_records(store, space, item_ids)}
    stale = [item_id for item_id in item_ids if item_id not in found or found[item_id]['invalid_at']]
    if stale:
        raise HTTPException(status_code=422, detail={
            'code': 'derived_from_not_current', 'item_ids': stale,
            'message': 'derived_from names knowledge that is missing or no longer current'})


async def end_dependents(scoped, actor, space, item_kind, item_id, *, reason, changed_by,
                         created_at: datetime) -> list[dict]:
    """End every conclusion drawn from this item (now out of date), and the
    conclusions drawn from those; return what was ended."""
    ended, seen = [], {(item_kind, item_id)}
    frontier = [(item_kind, item_id)]
    while frontier:
        dependents = []
        for basis_kind, basis_id in frontier:
            for dependent in await dependents_of(scoped, space, basis_kind, basis_id):
                if dependent not in seen:
                    seen.add(dependent)
                    dependents.append((dependent, (basis_kind, basis_id)))
        frontier = []
        for (dependent_kind, dependent_id), (basis_kind, basis_id) in dependents:
            if await _end_validity(scoped, actor, space, dependent_kind, dependent_id, basis_kind, basis_id,
                                   reason=reason, changed_by=changed_by, created_at=created_at):
                ended.append({'item_kind': dependent_kind, 'item_id': dependent_id,
                              'basis_kind': basis_kind, 'basis_id': basis_id})
                frontier.append((dependent_kind, dependent_id))
    return ended


async def dependents_of(scoped, space, basis_kind, basis_id) -> list[tuple[str, str]]:
    lineage = await lineage_ids(scoped, space, basis_kind, basis_id)
    records, _, _ = await scoped.runtime.driver.execute_query(
        _DEPENDENTS, group_id=space['group_id'], lineage=lineage)
    found = [(record['item_kind'], record['item_id']) for record in records]
    assertions, _, _ = await scoped.runtime.driver.execute_query(
        _DECISION_ASSERTIONS, space_id=space['id'], lineage=lineage)
    for record in assertions:
        current = await current_version_id(scoped, space, 'entity', record['item_id'])
        if current and ('entity', current) not in found:
            found.append(('entity', current))
    return found


async def item_bases(store, space, item_kind, item_id, current) -> list[dict]:
    """The knowledge this item was concluded from, each with where it stands now."""
    basis_ids = list(dict.fromkeys([*(current.get('derived_from_item_ids') or []),
                                    *await _decision_sources(store, space, item_kind, item_id)]))
    if not basis_ids:
        return []
    bases = {basis['item_id']: basis for basis in await _basis_records(store, space, basis_ids)}
    revisions = {}
    for kind in ('entity', 'relationship'):
        ids = [basis_id for basis_id, basis in bases.items() if basis['item_kind'] == kind]
        if ids:
            revisions.update(await item_revisions(store, space, kind, ids))
    return [{'item_kind': bases[basis_id]['item_kind'], 'item_id': basis_id,
             'content': bases[basis_id]['content'] or basis_id,
             'status': version_status(bases[basis_id]['invalid_at'], bases[basis_id]['replaced_by_item_id'],
                                      revisions.get(basis_id, []))}
            for basis_id in basis_ids if basis_id in bases]


async def _decision_sources(store, space, item_kind, item_id) -> list[str]:
    """The project preferences an approved personal-global decision rests on."""
    if item_kind != 'entity':
        return []
    # A decision names the assertion it wrote; a later version of that
    # assertion rests on the same sources.
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (decision:FuliPersonalGlobalPreferenceDecision {space_id: $space_id})
        WHERE decision.global_assertion_id IN $lineage
        MATCH (event:FuliPersonalGlobalPreferenceDecisionEvent {space_id: $space_id,
                                                               id: decision.current_event_id})
        RETURN event.source_items_json AS source_items_json
        ''', space_id=space['id'], lineage=await lineage_ids(store, space, 'entity', item_id), routing_='r')
    sources = []
    for record in records:
        listed = json.loads(record['source_items_json'] or '[]')
        sources.extend(source['item_id'] for source in listed if isinstance(source, dict) and source.get('item_id'))
    return sources


async def _basis_records(store, space, item_ids) -> list[dict]:
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        CALL {
          UNWIND $item_ids AS id
          MATCH (item:Entity {uuid: id, group_id: $group_id})
          RETURN 'entity' AS item_kind, item.uuid AS item_id, coalesce(item.summary, item.name) AS content,
                 item.fuli_invalid_at AS invalid_at, item.fuli_replaced_by_item_id AS replaced_by_item_id
          UNION
          UNWIND $item_ids AS id
          MATCH ()-[item:RELATES_TO {uuid: id, group_id: $group_id}]->()
          RETURN 'relationship' AS item_kind, item.uuid AS item_id, item.fact AS content,
                 item.invalid_at AS invalid_at, item.fuli_replaced_by_item_id AS replaced_by_item_id
        }
        RETURN item_kind, item_id, content, invalid_at, replaced_by_item_id
        ''', item_ids=list(item_ids), group_id=space['group_id'], routing_='r')
    return [dict(record) for record in records]


async def _end_validity(scoped, actor, space, item_kind, item_id, basis_kind, basis_id, *, reason,
                        changed_by, created_at) -> bool:
    current = await _read_item(scoped, space, item_id, item_kind)
    if current is None or current.get('invalid_at'):
        return False
    invalid = invalid_property(item_kind)
    records, _, _ = await scoped.runtime.driver.execute_query(
        _item_match(item_kind) + f'''
        WHERE item.{invalid} IS NULL
        SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1,
            item.{invalid} = $created_at, item.expired_at = $created_at
        RETURN item.uuid AS item_id
        ''', item_id=item_id, group_id=space['group_id'], created_at=created_at)
    if not records:
        return False
    previous = _snapshot(current, item_kind)
    await record_version_revision(
        scoped, actor, space, item_kind, item_id,
        revision_id=stable_uuid(space['id'], 'knowledge-revision', item_kind, item_id, 'basis-outdated',
                                basis_kind, basis_id, created_at.isoformat()),
        action='basis_outdated', reason=reason, previous=previous,
        current={**previous, 'invalidAt': created_at.isoformat(),
                 'basis': {'itemKind': basis_kind, 'itemId': basis_id}},
        changed_by=changed_by, created_at=created_at)
    return True
