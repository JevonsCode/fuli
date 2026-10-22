"""Where knowledge other than personal preferences applies (rec#20 part 2).

A fact, an experience or any other non-preference item belongs to one primary
project, its assignment (else the projects its sources name), and may apply to
more projects through the same active project references the 加入项目 action
writes. Several projects is as far as it reaches: global and one FLA stay a
personal preference's scope, because a fact's wider reach is where its
sources were learned, and an edit never rewrites where something was learned.

A person's scope edit keeps the same item and ID. Adding a project writes an
active reference, after the same duplicate and conflict check 加入项目 makes
for an entity; removing one ends its reference ('rejected'), whose record
stays. A new version carries the assignment and the active references, so
the scope survives edits (knowledge_versions).
"""
from datetime import datetime, timezone

from fastapi import HTTPException

from .knowledge_item_version import lock_version
from .knowledge_management import _implicit_project_id, _read_assignment, _source_project_ids, write_project_assignment
from .project_knowledge import match_target_project, upsert_reference

# 加入项目 resolves these in the target project; a scope edit does not guess.
_UNRESOLVED_MATCHES = frozenset({'exact_duplicate', 'conflict'})


async def knowledge_project_ids(store, space, item_id, item_kind) -> list[str]:
    """The primary project (or the source projects) first, then each project
    an active reference adds."""
    assignment = await _read_assignment(store, space['id'], item_id, item_kind)
    primary = [assignment.project_id] if assignment else await _source_project_ids(store, space, item_id, item_kind)
    return list(dict.fromkeys([*primary, *await _reference_project_ids(store, space, item_id, item_kind)]))


async def write_knowledge_projects(store, actor, space, item_id, item_kind, project_ids, *, current, reason):
    """Make the item apply to exactly `project_ids`, inside the caller's
    transaction. The primary project stays where it is when it is still
    chosen; otherwise the first chosen project becomes primary."""
    match = ('MATCH (item:Entity {uuid: $item_id, group_id: $group_id})' if item_kind == 'entity'
             else 'MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()')
    records, _, _ = await store.runtime.driver.execute_query(
        match + '''
        SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1
        WITH item WHERE item.fuli_ai_review_lock_version = $expected_version + 1
        SET item.fuli_scope_status = NULL
        RETURN item.uuid AS item_id
        ''', item_id=item_id, group_id=space['group_id'], expected_version=lock_version(current))
    if not records:
        raise HTTPException(status_code=409, detail={'code': 'stale_version',
                                                     'message': 'knowledge changed while its scope was being saved'})
    existing = await _read_assignment(store, space['id'], item_id, item_kind)
    sources = [] if existing else await _source_project_ids(store, space, item_id, item_kind)
    current_primary = existing.project_id if existing else None
    primary = next((project for project in project_ids if project in ([current_primary] if existing else sources)),
                   project_ids[0])
    referenced = await _reference_project_ids(store, space, item_id, item_kind)
    added = [project for project in project_ids if project != primary and project not in referenced]
    if item_kind == 'entity':
        await _refuse_unresolved_matches(store, space, item_id, current, added, current_primary or primary)
    if primary != current_primary:
        await write_project_assignment(
            store, space, item_id, item_kind, primary,
            previous_project_id=current_primary or await _implicit_project_id(store, space, item_id, item_kind),
            existing=existing, reason=reason, changed_by=actor['id'])
    for project in added:
        await upsert_reference(store, space, actor, item_id, item_kind, project, primary, 'active', None, reason)
    await _end_references(store, actor, space, item_id, item_kind,
                          [project for project in referenced if project not in project_ids or project == primary],
                          reason)


async def _refuse_unresolved_matches(store, space, item_id, current, added, source_project_id):
    for project in added:
        found = await match_target_project(store, space, item_id, 'entity', current, project, source_project_id)
        if found.kind in _UNRESOLVED_MATCHES:
            raise HTTPException(status_code=409, detail={
                'code': 'project_has_match', 'project_id': project, 'match_item_id': found.item_id,
                'message': f'{found.reason} Use 加入项目 on the knowledge page to decide how they relate.'})


async def _reference_project_ids(store, space, item_id, item_kind) -> list[str]:
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_KNOWLEDGE_REFERENCE]->
              (reference:FuliKnowledgeProjectReference {item_kind: $item_kind, item_id: $item_id, status: 'active'})
        RETURN reference.project_id AS project_id ORDER BY reference.created_at, project_id
        ''', space_id=space['id'], item_kind=item_kind, item_id=item_id, routing_='r')
    return [record['project_id'] for record in records]


async def _end_references(store, actor, space, item_id, item_kind, project_ids, reason) -> None:
    if not project_ids:
        return
    await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_KNOWLEDGE_REFERENCE]->
              (reference:FuliKnowledgeProjectReference {item_kind: $item_kind, item_id: $item_id, status: 'active'})
        WHERE reference.project_id IN $project_ids
        SET reference.status = 'rejected', reference.reason = $reason, reference.changed_by = $changed_by,
            reference.updated_at = $changed_at
        ''', space_id=space['id'], item_kind=item_kind, item_id=item_id, project_ids=project_ids,
        reason=reason, changed_by=actor['id'], changed_at=datetime.now(timezone.utc))
