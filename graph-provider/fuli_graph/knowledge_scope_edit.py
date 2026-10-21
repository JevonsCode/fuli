"""A person moves one knowledge item to where it should apply (rec#20 quick edit).

The same item keeps its ID, source and history: only where it applies from
now on changes, with a revision of the scope before and after. Narrowing stops
later use elsewhere; nothing already done is undone. An edit from a stale read
is refused with the current version. A preference already in use (confirmed by
a person or an Agent policy) can be narrowed or moved within its coverage, but
widening it still goes through the reviewed global-preference decision.
"""
import json
from datetime import datetime, timezone

from fastapi import HTTPException

from .knowledge_audit import record_human_change
from .knowledge_item_version import item_version, require_item_version
from .knowledge_item_view import item_scope, scope_snapshot
from .knowledge_item_view_models import KnowledgeScopeChange
from .knowledge_management import _implicit_project_id, _read_assignment, _read_item, write_project_assignment
from .knowledge_weight import effective_confirmation_status
from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .provider_values import stable_uuid
from .store_transactions import query_store_transaction

_WIDENING = ('This preference already applies; widening where it applies needs the reviewed '
             'global-preference decision. Narrow it here, or use that decision to widen it.')


async def change_knowledge_scope(store, actor: dict, item_id: str, request: KnowledgeScopeChange) -> dict:
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='knowledge scope is personal-only')
    async with query_store_transaction(store) as scoped:
        current = await _read_item(scoped, space, item_id, request.item_kind)
        if current is None:
            raise HTTPException(status_code=404, detail='knowledge item not found')
        require_item_version(current, request.expected_version)
        if current.get('invalid_at'):
            raise HTTPException(status_code=409, detail='historical knowledge keeps the scope it had')
        for project_id in request.project_ids:
            project = await authorize_personal_project(scoped, actor, space, project_id)
            if project.get('scope_type') == 'temporary':
                raise HTTPException(status_code=422, detail='choose a registered project, not a temporary one')
        if request.agent_id:
            agent = await authorize_project_agent(scoped, actor, space, request.project_ids[0],
                                                  request.agent_id, require_active=True)
            request = request.model_copy(update={'agent_id': agent['agent_id']})
        before = await item_scope(scoped, space, request.item_kind, item_id, current)
        if current.get('profile_aspect'):
            if effective_confirmation_status(current) != 'pending' and _widens(before, request):
                raise HTTPException(status_code=409, detail={'code': 'widening_requires_review',
                                                             'message': _WIDENING})
            await _write_preference_scope(scoped, space, item_id, request, item_version(current))
        else:
            await _write_project_scope(scoped, actor, space, item_id, request, current)
        after = await item_scope(scoped, space, request.item_kind, item_id,
                                 await _read_item(scoped, space, item_id, request.item_kind))
        changed_at = datetime.now(timezone.utc)
        await scoped.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
            CREATE (revision:FuliKnowledgeRevision {
              id: $revision_id, space_id: $space_id, item_id: $item_id, item_kind: $item_kind,
              action: 'scope_change', reason: $reason, previous_json: $previous_json,
              current_json: $current_json, created_by: $created_by, created_at: $created_at
            })
            MERGE (space)-[:HAS_KNOWLEDGE_REVISION]->(revision)
            ''', space_id=space['id'], item_id=item_id, item_kind=request.item_kind,
            revision_id=stable_uuid(space['id'], 'knowledge-revision', request.item_kind, item_id,
                                    changed_at.isoformat(), actor['id']),
            reason=request.reason, previous_json=_json({'scope': scope_snapshot(before)}),
            current_json=_json({'scope': scope_snapshot(after)}), created_by=actor['id'],
            created_at=changed_at)
        await record_human_change(scoped, actor, space, item_id, request.item_kind,
                                  reason=request.reason, operation='knowledge_scope')
    return {'item_kind': request.item_kind, 'item_id': item_id,
            'previous_scope': scope_snapshot(before), 'scope': scope_snapshot(after)}


def _widens(before, request) -> bool:
    """True when the new scope reaches anywhere the item did not apply before."""
    if before.kind == 'global':
        return False
    if request.scope == 'global' or before.kind in ('temporary', 'unknown'):
        return True
    covered = {project.id for project in before.projects}
    if before.kind == 'agent':
        return not (request.scope == 'agent' and request.project_ids == [before.projects[0].id]
                    and request.agent_id == before.agent_id)
    return not set(request.project_ids) <= covered


async def _write_preference_scope(store, space, item_id, request, expected_version):
    match = ('MATCH (item:Entity {uuid: $item_id, group_id: $group_id})' if request.item_kind == 'entity'
             else 'MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()')
    projects = request.project_ids
    records, _, _ = await store.runtime.driver.execute_query(
        match + '''
        SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1
        WITH item WHERE item.fuli_ai_review_lock_version = $expected_version + 1
        SET item.fuli_preference_scope = $scope, item.fuli_preference_project_id = $project_id,
            item.fuli_preference_project_ids = $project_ids, item.fuli_preference_agent_id = $agent_id,
            item.fuli_scope_status = NULL
        RETURN item.uuid AS item_id
        ''', item_id=item_id, group_id=space['group_id'], expected_version=expected_version,
        scope={'global': 'global', 'projects': 'project', 'agent': 'agent'}[request.scope],
        project_id=projects[0] if projects else None,
        project_ids=projects if len(projects) > 1 else None, agent_id=request.agent_id)
    if not records:
        raise HTTPException(status_code=409, detail={'code': 'stale_version',
                                                     'message': 'knowledge changed while its scope was being saved'})


async def _write_project_scope(store, actor, space, item_id, request, current):
    # Other knowledge belongs to one project through its assignment; several
    # projects or one FLA would need a model of their own (rec#20 part 2).
    if request.scope != 'projects' or len(request.project_ids) != 1:
        raise HTTPException(status_code=422, detail=(
            'this kind of knowledge applies to one project; only personal preferences '
            'can be global, span several projects or belong to one FLA'))
    match = ('MATCH (item:Entity {uuid: $item_id, group_id: $group_id})' if request.item_kind == 'entity'
             else 'MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()')
    records, _, _ = await store.runtime.driver.execute_query(
        match + '''
        SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1
        WITH item WHERE item.fuli_ai_review_lock_version = $expected_version + 1
        SET item.fuli_scope_status = NULL
        RETURN item.uuid AS item_id
        ''', item_id=item_id, group_id=space['group_id'], expected_version=item_version(current))
    if not records:
        raise HTTPException(status_code=409, detail={'code': 'stale_version',
                                                     'message': 'knowledge changed while its scope was being saved'})
    existing = await _read_assignment(store, space['id'], item_id, request.item_kind)
    await write_project_assignment(
        store, space, item_id, request.item_kind, request.project_ids[0],
        previous_project_id=(existing.project_id if existing
                             else await _implicit_project_id(store, space, item_id, request.item_kind)),
        existing=existing, reason=request.reason, changed_by=actor['id'])


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)
