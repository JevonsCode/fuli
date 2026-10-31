"""A person moves one knowledge item to where it should apply (rec#20 quick edit).

The same item keeps its ID, source and history: only where it applies from
now on changes, with a revision of the scope before and after. Narrowing stops
later use elsewhere; nothing already done is undone. An edit from a stale read
is refused with the current edit revision. A preference already in use (confirmed by
a person or an Agent policy) can be narrowed or moved within its coverage, but
widening it still goes through the reviewed global-preference decision. An
item held in a temporary or unknown scope is placed, not widened, wherever the
person chooses. Other knowledge applies to one or more projects
(knowledge_project_scope); adding a project is what 加入项目 already lets a
person do. A session's batch migration (knowledge_session_migration) moves
each item through this same change, all inside one transaction.
"""
import json
from datetime import datetime, timezone

from fastapi import HTTPException

from .knowledge_audit import record_human_change
from .knowledge_item_version import lock_version, require_edit_revision
from .knowledge_item_view import item_scope, scope_snapshot
from .knowledge_item_view_models import KnowledgeScopeChange
from .knowledge_management import _read_item
from .knowledge_project_scope import write_knowledge_projects
from .knowledge_versions import lock_knowledge
from .knowledge_weight import effective_confirmation_status
from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .provider_values import stable_uuid
from .store_transactions import query_store_transaction

_WIDENING = ('This preference already applies; widening where it applies needs the reviewed '
             'global-preference decision. Narrow it here, or use that decision to widen it.')


async def change_knowledge_scope(store, actor: dict, item_id: str, request: KnowledgeScopeChange) -> dict:
    space = await scope_editor_space(store, actor, request.personal_space_id)
    async with query_store_transaction(store) as scoped:
        await lock_knowledge(scoped, space)
        return await apply_scope_change(scoped, actor, space, item_id, request)


async def scope_editor_space(store, actor: dict, space_id: str) -> dict:
    """The person's space for a scope write. The change is audited as theirs,
    so it needs the human-review channel (the route's HumanReviewer); this
    refuses any other caller of these functions as well."""
    if actor.get('_human_review_verified') is not True:
        raise HTTPException(status_code=403, detail='independent human review proof required')
    store._require_personal()
    space = await store.authorize(actor, space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='knowledge scope is personal-only')
    return space


async def apply_scope_change(scoped, actor: dict, space: dict, item_id: str, request: KnowledgeScopeChange) -> dict:
    """One item's scope change inside the caller's transaction, which holds
    the space's knowledge lock: 加入项目 takes the same lock, so no reference
    lands between the version check and the write."""
    current = await _editable_item(scoped, space, item_id, request.item_kind, request.expected_version)
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
    elif request.scope != 'projects':
        raise HTTPException(status_code=422, detail=(
            'facts, experiences and other knowledge apply to one or more projects; only personal '
            'preferences can be global or belong to one FLA'))
    result = await _write_scope(scoped, actor, space, item_id, request.item_kind, current, before,
                                scope=request.scope, project_ids=request.project_ids,
                                agent_id=request.agent_id, reason=request.reason)
    await record_human_change(scoped, actor, space, item_id, request.item_kind,
                              reason=request.reason, operation='knowledge_scope')
    return result


async def place_scope_as(scoped, actor: dict, space: dict, author_id: str, item_kind: str, item_id: str, *,
                         expected_version: int, project_ids: list[str], reason: str,
                         scope_status: str | None = None) -> dict:
    """A move FULI itself makes for a person's decision (rec#11 D-86: a
    promoted topic's session knowledge and the undo that returns it), inside
    the caller's transaction and knowledge lock. The same version guard and
    scope_change revision as a quick edit, recorded as author_id instead of
    the person and without a human audit. Unlike a quick edit it may name a
    temporary project: an undo puts the item back where it was held."""
    current = await _editable_item(scoped, space, item_id, item_kind, expected_version)
    for project_id in project_ids:
        await authorize_personal_project(scoped, actor, space, project_id)
    before = await item_scope(scoped, space, item_kind, item_id, current)
    return await _write_scope(scoped, {**actor, 'id': author_id}, space, item_id, item_kind, current, before,
                              scope='projects', project_ids=project_ids, agent_id=None, reason=reason,
                              scope_status=scope_status)


async def _editable_item(scoped, space, item_id, item_kind, expected_version) -> dict:
    current = await _read_item(scoped, space, item_id, item_kind)
    if current is None:
        raise HTTPException(status_code=404, detail='knowledge item not found')
    await require_edit_revision(scoped, space, item_kind, item_id, expected_version)
    if current.get('invalid_at'):
        raise HTTPException(status_code=409, detail='historical knowledge keeps the scope it had')
    return current


async def _write_scope(scoped, author: dict, space, item_id, item_kind, current, before, *, scope, project_ids,
                       agent_id, reason, scope_status=None) -> dict:
    """Write where the item applies and its scope_change revision, as author."""
    if current.get('profile_aspect'):
        await _write_preference_scope(scoped, space, item_kind, item_id, scope, project_ids, agent_id,
                                      lock_version(current), scope_status)
    else:
        await write_knowledge_projects(scoped, author, space, item_id, item_kind, project_ids,
                                       current=current, reason=reason, scope_status=scope_status)
    after = await item_scope(scoped, space, item_kind, item_id, await _read_item(scoped, space, item_id, item_kind))
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
        ''', space_id=space['id'], item_id=item_id, item_kind=item_kind,
        revision_id=stable_uuid(space['id'], 'knowledge-revision', item_kind, item_id,
                                changed_at.isoformat(), author['id']),
        reason=reason, previous_json=_json({'scope': scope_snapshot(before)}),
        current_json=_json({'scope': scope_snapshot(after)}), created_by=author['id'],
        created_at=changed_at)
    return {'item_kind': item_kind, 'item_id': item_id,
            'previous_scope': scope_snapshot(before), 'scope': scope_snapshot(after)}


def _widens(before, request) -> bool:
    """True when the new scope reaches anywhere the item did not apply before.
    A temporary or unknown scope is no place the person chose: choosing one is
    placing the item, not widening it. Its confirmation stays as it was."""
    if before.kind in ('global', 'temporary', 'unknown'):
        return False
    if request.scope == 'global':
        return True
    covered = {project.id for project in before.projects}
    if before.kind == 'agent':
        return not (request.scope == 'agent' and request.project_ids == [before.projects[0].id]
                    and request.agent_id == before.agent_id)
    return not set(request.project_ids) <= covered


async def _write_preference_scope(store, space, item_kind, item_id, scope, projects, agent_id, expected_version,
                                  scope_status):
    match = ('MATCH (item:Entity {uuid: $item_id, group_id: $group_id})' if item_kind == 'entity'
             else 'MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()')
    records, _, _ = await store.runtime.driver.execute_query(
        match + '''
        SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1
        WITH item WHERE item.fuli_ai_review_lock_version = $expected_version + 1
        SET item.fuli_preference_scope = $scope, item.fuli_preference_project_id = $project_id,
            item.fuli_preference_project_ids = $project_ids, item.fuli_preference_agent_id = $agent_id,
            item.fuli_scope_status = $scope_status
        RETURN item.uuid AS item_id
        ''', item_id=item_id, group_id=space['group_id'], expected_version=expected_version,
        scope={'global': 'global', 'projects': 'project', 'agent': 'agent'}[scope],
        project_id=projects[0] if projects else None,
        project_ids=projects if len(projects) > 1 else None, agent_id=agent_id, scope_status=scope_status)
    if not records:
        raise HTTPException(status_code=409, detail={'code': 'stale_version',
                                                     'message': 'knowledge changed while its scope was being saved'})


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)
