import json
from datetime import datetime, timezone

from fastapi import HTTPException

from .knowledge_audit import record_human_change
from .knowledge_item_version import lock_version, require_edit_revision
from .knowledge_records import assignment_record
from .personal_project_access import authorize_personal_project
from .store_transactions import query_store_transaction
from .models import (
    ConfirmationBasis,
    KnowledgeAssignmentChange,
    KnowledgeAssignmentRecord,
    PreferenceScopeChange,
    KnowledgeRevisionCreate,
    KnowledgeRevisionRecord,
)
from .provider_values import (
    json_object,
    native_datetime as _native_datetime,
    stable_uuid as _stable_uuid,
)


async def revise_knowledge_item(store, actor: dict, item_id: str, request: KnowledgeRevisionCreate):
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='knowledge revision is personal-only')
    if request.personal_project_id:
        await authorize_personal_project(
            store, actor, space, request.personal_project_id
        )
        if not await _item_belongs_to_project(
            store, space, item_id, request.item_kind, request.personal_project_id
        ):
            raise HTTPException(status_code=404, detail='knowledge item not found in project')

    current = await _read_item(store, space, item_id, request.item_kind)
    if current is None:
        raise HTTPException(status_code=404, detail='knowledge item not found')
    await require_edit_revision(store, space, request.item_kind, item_id, request.expected_version)
    previous = _snapshot(current, request.item_kind)
    if (
        request.action == 'update'
        and request.origin_quadrant is not None
        and previous.get('classificationStateExplicit')
        and request.origin_quadrant != previous.get('originQuadrant')
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                'origin quadrant is immutable after capture; '
                'update current_quadrant instead'
            ),
        )
    next_profile_aspect = (
        previous.get('profileAspect')
        if request.profile_aspect is None
        else None if request.profile_aspect == 'none'
        else request.profile_aspect
    )
    next_inheritance_mode = (
        request.inheritance_mode
        if request.inheritance_mode is not None
        else previous.get('inheritanceMode', 'local_only')
    )
    if next_profile_aspect and next_inheritance_mode != 'local_only':
        raise HTTPException(
            status_code=422,
            detail='personal preferences cannot inherit across projects',
        )
    if request.action == 'link_replacement' and not previous.get('invalidAt'):
        raise HTTPException(
            status_code=409,
            detail='only historical knowledge can be linked to a replacement',
        )
    if request.replacement_item_id:
        if (
            request.replacement_item_id == item_id
            and request.replacement_item_kind == request.item_kind
        ):
            raise HTTPException(
                status_code=422,
                detail='knowledge cannot replace itself',
            )
        replacement = await _read_item(
            store,
            space,
            request.replacement_item_id,
            request.replacement_item_kind,
        )
        if replacement is None:
            raise HTTPException(status_code=404, detail='replacement knowledge not found')
        if request.personal_project_id and not await _item_belongs_to_project(
            store,
            space,
            request.replacement_item_id,
            request.replacement_item_kind,
            request.personal_project_id,
        ):
            raise HTTPException(status_code=404, detail='replacement knowledge not found')
        if _snapshot(replacement, request.replacement_item_kind).get('invalidAt'):
            raise HTTPException(
                status_code=409,
                detail='replacement knowledge must be currently effective',
            )
    if request.action == 'confirm':
        if previous.get('invalidAt'):
            raise HTTPException(
                status_code=409,
                detail='historical knowledge cannot be confirmed',
            )
        if not previous.get('classificationStateExplicit'):
            raise HTTPException(
                status_code=409,
                detail='knowledge must have an explicit discovery quadrant before confirmation',
            )
        if (
            previous.get('confirmationStateExplicit')
            and previous.get('confirmationStatus') == 'confirmed'
        ):
            raise HTTPException(
                status_code=409,
                detail='knowledge is already confirmed',
            )
    created_at = datetime.now(timezone.utc)
    next_value = _next_snapshot(previous, request, created_at)
    embedding = await _updated_embedding(store, previous, next_value, request)
    revision_id = _stable_uuid(
        space['id'], 'knowledge-revision', request.item_kind, item_id,
        created_at.isoformat(), actor['id']
    )
    if request.action in _LIFECYCLE_ACTIONS:
        lifecycle = await _version_lifecycle(
            store, actor, space, item_id, request, current, previous, next_value,
            embedding=embedding, created_at=created_at, revision_id=revision_id,
        )
        if lifecycle is not None:
            return lifecycle
    # The revision was computed from `current`. If anything wrote the item
    # since (a rejection, usage, another edit), the write is refused and
    # nothing below is kept, instead of replaying the stale snapshot over it.
    rewrite_confirmed = await _confirms_a_rewrite(store, space, item_id, request)
    async with query_store_transaction(store) as scoped:
        if rewrite_confirmed:
            await _lock_knowledge(scoped, space)
        await _update_item(
            scoped, space, item_id, request.item_kind, next_value, embedding,
            expected_lock_version=lock_version(current),
        )
        await _record_revision(
            scoped, actor, space, item_id, request, revision_id,
            previous, next_value, created_at,
        )
        changed = 0
        if rewrite_confirmed:
            changed = await _apply_meaning(
                scoped, actor, space, request.item_kind, item_id,
                meaning=request.basis_meaning or 'changed', reason=request.reason,
                changed_by='user', created_at=created_at)
        if request.operation_actor == 'human':
            await record_human_change(
                scoped,
                actor,
                space,
                item_id,
                request.item_kind,
                reason=request.reason,
                operation=f'knowledge_{request.action}',
            )
    return KnowledgeRevisionRecord(
        id=revision_id,
        item_id=item_id,
        item_kind=request.item_kind,
        action=request.action,
        reason=request.reason,
        previous=previous,
        current=next_value,
        created_at=created_at,
        dependents_changed=changed,
    )


async def _confirms_a_rewrite(store, space, item_id, request) -> bool:
    """A person confirming a version that replaced another one (an Agent's
    rewrite waits for exactly this)."""
    if request.action != 'confirm' or request.operation_actor != 'human':
        return False
    from .knowledge_versions import lineage_ids  # deferred: versions build on this module

    return len(await lineage_ids(store, space, request.item_kind, item_id)) > 1


async def _lock_knowledge(scoped, space):
    from .knowledge_versions import lock_knowledge  # deferred: versions build on this module

    await lock_knowledge(scoped, space)


async def _apply_meaning(scoped, actor, space, item_kind, item_id, **options):
    from .knowledge_basis_review import apply_meaning  # deferred: it builds on this module

    return await apply_meaning(scoped, actor, space, item_kind, item_id, **options)


# Edits, restores and the outdated mark go through the item's versions
# (rec#5 C7/C8); confirmations and replacement links stay in place.
_LIFECYCLE_ACTIONS = frozenset({'update', 'restore', 'mark_outdated', 'invalidate', 'reaffirm',
                                'mark_meaning_changed'})


async def _version_lifecycle(
    store, actor, space, item_id, request, current, previous, next_value, *,
    embedding, created_at, revision_id,
):
    """Handle an edit that writes a new version, the outdated mark, and a
    restore that would erase history; None leaves the in-place revision."""
    # Deferred: the version and outdated modules build on this one.
    from .knowledge_basis_review import apply_meaning, basis_review, clear_downstream_of
    from .knowledge_outdated import mark_item_outdated, report_outdated_to_person
    from .knowledge_versions import (
        creates_version, current_version_id, item_revisions, lock_knowledge, terminal, version_status,
        version_value, write_version,
    )

    revisions = (await item_revisions(store, space, request.item_kind, [item_id])).get(item_id, [])
    status = version_status(previous.get('invalidAt'), current.get('replaced_by_item_id'), revisions)
    changed_by = 'user' if request.operation_actor == 'human' else 'agent'
    # Once replaced or out of date, a version stays history: a deactivation
    # cannot overwrite that end and a restore cannot undo it (P1-c).
    if request.action == 'invalidate':
        if terminal(revisions):
            raise HTTPException(status_code=409, detail={
                'code': 'lifecycle_final',
                'message': 'this version was replaced or went out of date; its end stays as it was'})
        return None
    if request.action == 'restore':
        if terminal(revisions):
            raise HTTPException(status_code=409, detail={
                'code': 'reassert_as_new_version',
                'message': ('this knowledge was replaced or went out of date; re-assert it as a new '
                            'version, which keeps the time it was not valid'),
            })
        return None
    if request.action == 'mark_meaning_changed':
        # From any version record of a basis: everything resting on its chain.
        head = await current_version_id(store, space, request.item_kind, item_id) or item_id
        async with query_store_transaction(store) as scoped:
            await lock_knowledge(scoped, space)
            changed = await apply_meaning(scoped, actor, space, request.item_kind, head, meaning='changed',
                                          reason=request.reason, changed_by='user', created_at=created_at)
        return KnowledgeRevisionRecord(
            id=revision_id, item_id=item_id, item_kind=request.item_kind, action='mark_meaning_changed',
            reason=request.reason, previous=previous, current=previous, created_at=created_at,
            changed_by='user', dependents_changed=changed)
    if request.action == 'reaffirm':
        if status != 'current' or basis_review(revisions) is None:
            raise HTTPException(status_code=409, detail={
                'code': 'nothing_to_review', 'message': 'no changed basis waits for a review here'})
        value = version_value(previous, next_value, explicit_confirmation=False, changed_by='user',
                              reason=request.reason, created_at=created_at)
        async with query_store_transaction(store) as scoped:
            version_id = await write_version(
                scoped, actor, space, request.item_kind, item_id, current, value,
                embedding=None, reason=request.reason, changed_by='user',
                created_at=created_at, revision_id=revision_id, previous_snapshot=previous,
            )
            cleared = await clear_downstream_of(scoped, actor, space, request.item_kind, version_id,
                                                reason=request.reason, changed_by='user', created_at=created_at)
            await record_human_change(scoped, actor, space, version_id, request.item_kind,
                                      reason=request.reason, operation='knowledge_reaffirm')
        return KnowledgeRevisionRecord(
            id=revision_id, item_id=item_id, item_kind=request.item_kind, action='reaffirm',
            reason=request.reason, previous=previous, current=value, created_at=created_at,
            changed_by='user', version_item_id=version_id, dependents_changed=cleared)
    if request.action == 'mark_outdated':
        if status != 'current':
            raise HTTPException(status_code=409, detail='only current knowledge can be marked outdated')
        if changed_by == 'agent' and _confirmed_by_person(previous):
            # A person's confirmation stays theirs (D-20.10): the Agent's report
            # is recorded as negative feedback, and only the person ends it in
            # the console.
            async with query_store_transaction(store) as scoped:
                return await report_outdated_to_person(
                    scoped, actor, space, item_id, request, previous,
                    created_at=created_at, revision_id=revision_id,
                )
        async with query_store_transaction(store) as scoped:
            return await mark_item_outdated(
                scoped, actor, space, item_id, request, current, previous,
                created_at=created_at, revision_id=revision_id, changed_by=changed_by,
            )
    content_changed = _content_changed(previous, next_value, request.item_kind)
    # A version with a newer one is history whatever its status says (an
    # outdated version re-asserted since, P2-a): nothing edits it in place.
    if current.get('replaced_by_item_id') and status != 'current':
        raise HTTPException(status_code=409, detail={
            'code': 'superseded',
            'current_item_id': await current_version_id(store, space, request.item_kind, item_id),
            'message': 'a newer version replaced this knowledge; edit the current version',
        })
    if not creates_version(current, status, content_changed):
        return None
    value = version_value(
        previous, next_value, explicit_confirmation=request.confirmation_status is not None,
        changed_by=changed_by, reason=request.reason, created_at=created_at,
    )
    async with query_store_transaction(store) as scoped:
        version_id = await write_version(
            scoped, actor, space, request.item_kind, item_id, current, value,
            embedding=embedding, reason=request.reason, changed_by=changed_by,
            created_at=created_at, revision_id=revision_id, previous_snapshot=previous,
        )
        changed = 0
        if request.operation_actor == 'human':
            await record_human_change(
                scoped, actor, space, version_id, request.item_kind,
                reason=request.reason, operation='knowledge_update',
            )
            # The person says what the edit means for conclusions drawn from it;
            # unsaid, the meaning changed (D-20.7). An Agent's rewrite waits for
            # the person's confirmation, which decides instead.
            changed = await apply_meaning(
                scoped, actor, space, request.item_kind, version_id,
                meaning=request.basis_meaning or 'changed', reason=request.reason,
                changed_by='user', created_at=created_at)
    return KnowledgeRevisionRecord(
        id=revision_id, item_id=item_id, item_kind=request.item_kind, action='update',
        reason=request.reason, previous=previous, current=value, created_at=created_at,
        changed_by=changed_by, version_item_id=version_id, dependents_changed=changed,
    )


def _confirmed_by_person(snapshot: dict) -> bool:
    basis = snapshot.get('confirmationBasis') or {}
    return (snapshot.get('confirmationStatus') == 'confirmed'
            and (basis.get('confirmed_by') or {}).get('kind') == 'user')


def _content_changed(previous: dict, value: dict, item_kind: str) -> bool:
    fields = ('name', 'summary') if item_kind == 'entity' else ('fact',)
    return any(previous.get(field) != value.get(field) for field in fields)


async def _record_revision(
    store, actor, space, item_id, request, revision_id, previous, current, created_at,
):
    await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        CREATE (revision:FuliKnowledgeRevision {
          id: $revision_id,
          space_id: $space_id,
          item_id: $item_id,
          item_kind: $item_kind,
          action: $action,
          reason: $reason,
          previous_json: $previous_json,
          current_json: $current_json,
          created_by: $created_by,
          created_at: $created_at
        })
        MERGE (space)-[:HAS_KNOWLEDGE_REVISION]->(revision)
        ''',
        space_id=space['id'],
        revision_id=revision_id,
        item_id=item_id,
        item_kind=request.item_kind,
        action=request.action,
        reason=request.reason,
        previous_json=json.dumps(previous, ensure_ascii=False, sort_keys=True),
        current_json=json.dumps(current, ensure_ascii=False, sort_keys=True),
        created_by=actor['id'],
        created_at=created_at,
    )


async def reassign_knowledge_item(
    store,
    actor: dict,
    item_id: str,
    request: KnowledgeAssignmentChange,
):
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='knowledge assignment is personal-only')
    await authorize_personal_project(store, actor, space, request.target_project_id)
    item = await _read_item(store, space, item_id, request.item_kind)
    if item is None:
        raise HTTPException(status_code=404, detail='knowledge item not found')
    if item.get('profile_aspect'):
        raise HTTPException(
            status_code=422,
            detail='personal profile knowledge cannot be assigned to a project',
        )

    existing = await _read_assignment(store, space['id'], item_id, request.item_kind)
    previous_project_id = (
        existing.project_id if existing
        else await _implicit_project_id(store, space, item_id, request.item_kind)
    )
    assignment = await write_project_assignment(
        store, space, item_id, request.item_kind, request.target_project_id,
        previous_project_id=previous_project_id, existing=existing,
        reason=request.reason, changed_by=actor['id'],
    )
    # A scope change is a revision of the item, so a page that read it before
    # sees a stale edit version (knowledge_item_version).
    changed_at = assignment.updated_at
    await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        CREATE (revision:FuliKnowledgeRevision {
          id: $revision_id, space_id: $space_id, item_id: $item_id, item_kind: $item_kind,
          action: 'scope_change', reason: $reason, previous_json: $previous_json,
          current_json: $current_json, created_by: $created_by, created_at: $created_at
        })
        MERGE (space)-[:HAS_KNOWLEDGE_REVISION]->(revision)
        ''', space_id=space['id'], item_id=item_id, item_kind=request.item_kind,
        revision_id=_stable_uuid(space['id'], 'knowledge-revision', request.item_kind, item_id,
                                 changed_at.isoformat(), actor['id'], 'assignment'),
        reason=request.reason, previous_json=json.dumps({'projectId': previous_project_id}),
        current_json=json.dumps({'projectId': request.target_project_id,
                                 'changedBy': 'user' if request.operation_actor == 'human' else 'agent'}),
        created_by=actor['id'], created_at=changed_at)
    if request.operation_actor == 'human':
        await record_human_change(
            store,
            actor,
            space,
            item_id,
            request.item_kind,
            reason=request.reason,
            operation='knowledge_assignment',
        )
    return assignment


async def write_project_assignment(
    store, space, item_id, item_kind, target_project_id, *,
    previous_project_id, existing, reason, changed_by,
) -> KnowledgeAssignmentRecord:
    """Point one item at a project; the same item and ID, its history kept."""
    changed_at = datetime.now(timezone.utc)
    assignment_id = existing.id if existing else _stable_uuid(
        space['id'], 'knowledge-assignment', item_kind, item_id
    )
    item_match = (
        'MATCH (item:Entity {uuid: $item_id, group_id: $group_id})'
        if item_kind == 'entity'
        else (
            'MATCH ()-[item:RELATES_TO '
            '{uuid: $item_id, group_id: $group_id}]->()'
        )
    )
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        MATCH (space)-[:CONTAINS_PROJECT]->
              (target:FuliPersonalProject {project_id: $target_project_id})
        '''
        + item_match
        + '''
        SET item.fuli_ai_review_lock_version =
              coalesce(item.fuli_ai_review_lock_version, 0) + 1
        WITH space, target
        MERGE (assignment:FuliKnowledgeAssignment {
          space_id: $space_id,
          item_kind: $item_kind,
          item_id: $item_id
        })
        ON CREATE SET assignment.id = $assignment_id,
                      assignment.created_at = $changed_at
        SET assignment.previous_project_id = $previous_project_id,
            assignment.project_id = $target_project_id,
            assignment.reason = $reason,
            assignment.changed_by = $changed_by,
            assignment.updated_at = $changed_at
        WITH space, assignment, target
        OPTIONAL MATCH (assignment)-[old:ASSIGNED_TO]->(:FuliPersonalProject)
        DELETE old
        MERGE (assignment)-[:ASSIGNED_TO]->(target)
        MERGE (space)-[:HAS_KNOWLEDGE_ASSIGNMENT]->(assignment)
        RETURN assignment
        ''',
        space_id=space['id'],
        group_id=space['group_id'],
        target_project_id=target_project_id,
        item_kind=item_kind,
        item_id=item_id,
        assignment_id=assignment_id,
        previous_project_id=previous_project_id,
        reason=reason,
        changed_by=changed_by,
        changed_at=changed_at,
    )
    return assignment_record(dict(records[0]['assignment']))


async def set_preference_scope(
    store,
    actor: dict,
    item_id: str,
    request: PreferenceScopeChange,
) -> KnowledgeRevisionRecord:
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='preference scope is personal-only')
    if request.scope == 'project':
        await authorize_personal_project(store, actor, space, request.project_id)

    current = await _read_item(store, space, item_id, request.item_kind)
    if current is None:
        raise HTTPException(status_code=404, detail='knowledge item not found')
    if not current.get('profile_aspect'):
        raise HTTPException(
            status_code=422,
            detail='only personal profile knowledge has a preference scope',
        )

    current_scope = current.get('preference_scope') or 'global'
    if not (
        current_scope == 'global'
        and request.scope == 'project'
        and request.project_id
    ):
        raise HTTPException(
            status_code=403,
            detail=(
                'direct preference scope changes may only narrow a global '
                'preference to one project; broader or lateral scope changes '
                'require the independently reviewed convergence workflow'
            ),
        )

    previous = _snapshot(current, request.item_kind)
    next_value = {
        **previous,
        'preferenceScope': request.scope,
        'preferenceProjectId': request.project_id,
    }
    if (
        previous.get('preferenceScope') == request.scope
        and previous.get('preferenceProjectId') == request.project_id
    ):
        raise HTTPException(status_code=409, detail='preference scope is unchanged')

    await _update_preference_scope(
        store,
        space,
        item_id,
        request.item_kind,
        request.scope,
        request.project_id,
    )
    created_at = datetime.now(timezone.utc)
    revision_id = _stable_uuid(
        space['id'], 'knowledge-revision', request.item_kind, item_id,
        created_at.isoformat(), actor['id']
    )
    await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        CREATE (revision:FuliKnowledgeRevision {
          id: $revision_id,
          space_id: $space_id,
          item_id: $item_id,
          item_kind: $item_kind,
          action: 'scope_change',
          reason: $reason,
          previous_json: $previous_json,
          current_json: $current_json,
          created_by: $created_by,
          created_at: $created_at
        })
        MERGE (space)-[:HAS_KNOWLEDGE_REVISION]->(revision)
        ''',
        space_id=space['id'],
        revision_id=revision_id,
        item_id=item_id,
        item_kind=request.item_kind,
        reason=request.reason,
        previous_json=json.dumps(previous, ensure_ascii=False, sort_keys=True),
        current_json=json.dumps(next_value, ensure_ascii=False, sort_keys=True),
        created_by=actor['id'],
        created_at=created_at,
    )
    if (
        request.operation_actor == 'human'
        and actor.get('_human_review_verified') is True
    ):
        await record_human_change(
            store,
            actor,
            space,
            item_id,
            request.item_kind,
            reason=request.reason,
            operation='preference_scope',
        )
    return KnowledgeRevisionRecord(
        id=revision_id,
        item_id=item_id,
        item_kind=request.item_kind,
        action='scope_change',
        reason=request.reason,
        previous=previous,
        current=next_value,
        created_at=created_at,
    )


async def _read_item(store, space: dict, item_id: str, item_kind: str):
    if item_kind == 'entity':
        query = '''
        MATCH (item:Entity {uuid: $item_id, group_id: $group_id})
        RETURN item.name AS name, coalesce(item.fuli_type, 'Entity') AS type,
               coalesce(item.summary, '') AS summary,
               item.fuli_invalid_at AS invalid_at,
               item.fuli_origin_quadrant IS NOT NULL
                 AS classification_state_explicit,
               coalesce(item.fuli_origin_quadrant, 'known_known') AS origin_quadrant,
               coalesce(item.fuli_current_quadrant, 'known_known') AS current_quadrant,
               coalesce(item.fuli_epistemic_status, 'confirmed') AS epistemic_status,
               coalesce(item.fuli_confirmation_status, 'pending')
                 AS confirmation_status,
               item.fuli_confirmation_status IS NOT NULL
                 AND item.fuli_confirmation_basis_json IS NOT NULL
                 AS confirmation_state_explicit,
               item.fuli_confirmation_basis_json AS confirmation_basis_json,
               item.fuli_reasoning_summary AS reasoning_summary,
               item.fuli_profile_aspect AS profile_aspect,
               CASE WHEN item.fuli_profile_aspect IS NULL THEN NULL
                    ELSE coalesce(item.fuli_preference_scope, 'global') END
                    AS preference_scope,
               item.fuli_preference_project_id AS preference_project_id,
               item.fuli_preference_project_ids AS preference_project_ids,
               item.fuli_preference_agent_id AS preference_agent_id,
               item.fuli_scope_status AS scope_status,
               item.fuli_content_source AS content_source,
               item.created_at AS created_at,
               coalesce(item.fuli_inheritance_mode, 'local_only')
                 AS inheritance_mode,
               coalesce(item.fuli_inherited_project_ids, [])
                 AS inherited_project_ids,
               coalesce(item.fuli_utility_score, 0.0) AS utility_score,
               coalesce(item.fuli_confidence_score, 0.5) AS confidence_score,
               coalesce(item.fuli_qualified_use_count, 0)
                 AS qualified_use_count,
               coalesce(item.fuli_distinct_task_count, 0)
                 AS distinct_task_count,
               item.fuli_last_used_at AS last_used_at,
               coalesce(item.fuli_usage_generation, 1) AS usage_generation,
               coalesce(item.fuli_negative_evidence_count, 0)
                 AS negative_evidence_count,
               coalesce(item.fuli_requires_attention, false)
                 AS requires_attention,
               item.fuli_last_feedback_kind AS last_feedback_kind,
               item.fuli_last_feedback_at AS last_feedback_at,
               item.fuli_negative_feedback_block_json
                 AS negative_feedback_block_json,
               item.fuli_replaced_by_item_id AS replaced_by_item_id,
               item.fuli_replaced_by_item_kind AS replaced_by_item_kind,
               item.fuli_derived_from_item_ids AS derived_from_item_ids,
               coalesce(item.fuli_ai_review_lock_version, 0)
                 AS ai_review_lock_version
        '''
    else:
        query = '''
        MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
        RETURN item.name AS type, item.fact AS fact, item.invalid_at AS invalid_at,
               item.fuli_origin_quadrant IS NOT NULL
                 AS classification_state_explicit,
               coalesce(item.fuli_origin_quadrant, 'known_known') AS origin_quadrant,
               coalesce(item.fuli_current_quadrant, 'known_known') AS current_quadrant,
               coalesce(item.fuli_epistemic_status, 'confirmed') AS epistemic_status,
               coalesce(item.fuli_confirmation_status, 'pending')
                 AS confirmation_status,
               item.fuli_confirmation_status IS NOT NULL
                 AND item.fuli_confirmation_basis_json IS NOT NULL
                 AS confirmation_state_explicit,
               item.fuli_confirmation_basis_json AS confirmation_basis_json,
               item.fuli_reasoning_summary AS reasoning_summary,
               item.fuli_profile_aspect AS profile_aspect,
               CASE WHEN item.fuli_profile_aspect IS NULL THEN NULL
                    ELSE coalesce(item.fuli_preference_scope, 'global') END
                    AS preference_scope,
               item.fuli_preference_project_id AS preference_project_id,
               item.fuli_preference_project_ids AS preference_project_ids,
               item.fuli_preference_agent_id AS preference_agent_id,
               item.fuli_scope_status AS scope_status,
               item.fuli_content_source AS content_source,
               item.created_at AS created_at,
               coalesce(item.fuli_inheritance_mode, 'local_only')
                 AS inheritance_mode,
               coalesce(item.fuli_inherited_project_ids, [])
                 AS inherited_project_ids,
               coalesce(item.fuli_utility_score, 0.0) AS utility_score,
               coalesce(item.fuli_confidence_score, 0.5) AS confidence_score,
               coalesce(item.fuli_qualified_use_count, 0)
                 AS qualified_use_count,
               coalesce(item.fuli_distinct_task_count, 0)
                 AS distinct_task_count,
               item.fuli_last_used_at AS last_used_at,
               coalesce(item.fuli_usage_generation, 1) AS usage_generation,
               coalesce(item.fuli_negative_evidence_count, 0)
                 AS negative_evidence_count,
               coalesce(item.fuli_requires_attention, false)
                 AS requires_attention,
               item.fuli_last_feedback_kind AS last_feedback_kind,
               item.fuli_last_feedback_at AS last_feedback_at,
               item.fuli_negative_feedback_block_json
                 AS negative_feedback_block_json,
               item.fuli_replaced_by_item_id AS replaced_by_item_id,
               item.fuli_replaced_by_item_kind AS replaced_by_item_kind,
               item.fuli_derived_from_item_ids AS derived_from_item_ids,
               coalesce(item.fuli_ai_review_lock_version, 0)
                 AS ai_review_lock_version
        '''
    records, _, _ = await store.runtime.driver.execute_query(
        query,
        item_id=item_id,
        group_id=space['group_id'],
        routing_='r',
    )
    return dict(records[0]) if records else None


async def _item_belongs_to_project(
    store,
    space: dict,
    item_id: str,
    item_kind: str,
    project_id: str,
) -> bool:
    assignment = await _read_assignment(store, space['id'], item_id, item_kind)
    if assignment:
        return assignment.project_id == project_id
    return await _implicit_project_id(store, space, item_id, item_kind) == project_id


async def _implicit_project_id(store, space: dict, item_id: str, item_kind: str):
    project_ids = await _source_project_ids(store, space, item_id, item_kind)
    return project_ids[0] if len(project_ids) == 1 else None


async def _source_project_ids(store, space: dict, item_id: str, item_kind: str) -> list[str]:
    """Every project whose episodes mention the item; empty when no source is known."""
    if item_kind == 'entity':
        query = '''
        MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->
              (:Entity {uuid: $item_id, group_id: $group_id})
        WHERE episode.fuli_personal_project_id IS NOT NULL
        RETURN collect(DISTINCT episode.fuli_personal_project_id) AS project_ids
        '''
    else:
        query = '''
        MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
        UNWIND coalesce(item.episodes, []) AS episode_id
        MATCH (episode:Episodic {uuid: episode_id, group_id: $group_id})
        WHERE episode.fuli_personal_project_id IS NOT NULL
        RETURN collect(DISTINCT episode.fuli_personal_project_id) AS project_ids
        '''
    records, _, _ = await store.runtime.driver.execute_query(
        query,
        item_id=item_id,
        group_id=space['group_id'],
        routing_='r',
    )
    return sorted(records[0]['project_ids']) if records else []


async def _read_assignment(store, space_id: str, item_id: str, item_kind: str):
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_ASSIGNMENT]->
              (assignment:FuliKnowledgeAssignment {
                item_id: $item_id,
                item_kind: $item_kind
              })
        RETURN assignment
        ''',
        space_id=space_id,
        item_id=item_id,
        item_kind=item_kind,
        routing_='r',
    )
    return assignment_record(dict(records[0]['assignment'])) if records else None


def _snapshot(value: dict, item_kind: str) -> dict:
    confirmation_basis = _confirmation_basis(value.get('confirmation_basis_json'))
    epistemic = {
        'classificationStateExplicit': (
            value.get('classification_state_explicit') is True
        ),
        'originQuadrant': value.get('origin_quadrant') or 'known_known',
        'currentQuadrant': value.get('current_quadrant') or 'known_known',
        'epistemicStatus': value.get('epistemic_status') or 'confirmed',
        'confirmationStatus': value.get('confirmation_status') or 'pending',
        'confirmationStateExplicit': (
            value.get('confirmation_state_explicit') is True
        ),
        'confirmationBasis': (
            confirmation_basis.model_dump(mode='json')
            if confirmation_basis else None
        ),
        'reasoningSummary': value.get('reasoning_summary'),
        'profileAspect': value.get('profile_aspect'),
        'preferenceScope': value.get('preference_scope'),
        'preferenceProjectId': value.get('preference_project_id'),
        'inheritanceMode': value.get('inheritance_mode') or 'local_only',
        'inheritedProjectIds': value.get('inherited_project_ids') or [],
        'utilityScore': float(value.get('utility_score') or 0),
        'confidenceScore': float(value.get('confidence_score') or 0.5),
        'qualifiedUseCount': int(value.get('qualified_use_count') or 0),
        'distinctTaskCount': int(value.get('distinct_task_count') or 0),
        'lastUsedAt': _iso(value.get('last_used_at')),
        'usageGeneration': int(value.get('usage_generation') or 1),
        'negativeEvidenceCount': int(
            value.get('negative_evidence_count') or 0
        ),
        'requiresAttention': value.get('requires_attention') is True,
        'lastFeedbackKind': value.get('last_feedback_kind'),
        'lastFeedbackAt': _iso(value.get('last_feedback_at')),
        'negativeFeedbackBlock': (
            json_object(value.get('negative_feedback_block_json')) or None
        ),
        'replacedByItemId': value.get('replaced_by_item_id'),
        'replacedByItemKind': value.get('replaced_by_item_kind'),
    }
    if item_kind == 'entity':
        return {
            'name': value['name'],
            'summary': value.get('summary') or '',
            'invalidAt': _iso(value.get('invalid_at')),
            **epistemic,
        }
    return {
        'type': value['type'],
        'fact': value['fact'],
        'invalidAt': _iso(value.get('invalid_at')),
        **epistemic,
    }


def _next_snapshot(previous: dict, request: KnowledgeRevisionCreate, changed_at: datetime):
    value = dict(previous)
    if request.action == 'confirm':
        basis = request.confirmation_basis.model_dump(mode='json')
        basis['confirmed_at'] = changed_at.isoformat()
        value['confirmationStatus'] = 'confirmed'
        value['confirmationStateExplicit'] = True
        value['confirmationBasis'] = basis
        value['epistemicStatus'] = 'confirmed'
        value['confidenceScore'] = 1.0
    elif request.action == 'update':
        content_changed = False
        if request.item_kind == 'entity':
            if request.name is not None:
                content_changed = content_changed or request.name != previous.get('name')
                value['name'] = request.name
            if request.summary is not None:
                content_changed = (
                    content_changed or request.summary != previous.get('summary')
                )
                value['summary'] = request.summary
        elif request.fact is not None:
            content_changed = request.fact != previous.get('fact')
            value['fact'] = request.fact
        origin_established = (
            request.origin_quadrant is not None
            and not previous.get('classificationStateExplicit')
        )
        classification_changed = origin_established or (
            request.current_quadrant is not None
            and request.current_quadrant != previous.get('currentQuadrant')
        )
        if request.origin_quadrant is not None:
            if previous.get('classificationStateExplicit'):
                value['originQuadrant'] = previous.get('originQuadrant')
            else:
                value['originQuadrant'] = request.origin_quadrant
                value['classificationStateExplicit'] = True
                if request.current_quadrant is None:
                    value['currentQuadrant'] = request.origin_quadrant
        if request.current_quadrant is not None:
            value['currentQuadrant'] = request.current_quadrant
        if request.epistemic_status is not None:
            value['epistemicStatus'] = request.epistemic_status
        if request.confirmation_status is not None:
            value['confirmationStatus'] = request.confirmation_status
            value['confirmationBasis'] = request.confirmation_basis.model_dump(mode='json')
            value['confirmationStateExplicit'] = True
        elif content_changed or classification_changed:
            value['confirmationStatus'] = 'pending'
            value['confirmationBasis'] = _pending_confirmation_basis(
                value.get('confirmationBasis'),
                request.reason,
            )
            value['confirmationStateExplicit'] = True
        trust_reset = (
            request.confirmation_status == 'pending'
            and previous.get('confirmationStatus') != 'pending'
        )
        if content_changed or classification_changed or trust_reset:
            value['usageGeneration'] = int(
                previous.get('usageGeneration') or 1
            ) + 1
            value['utilityScore'] = 0.0
            value['qualifiedUseCount'] = 0
            value['distinctTaskCount'] = 0
            value['lastUsedAt'] = None
        if content_changed or classification_changed:
            value['negativeEvidenceCount'] = 0
            value['requiresAttention'] = False
            value['lastFeedbackKind'] = None
            value['lastFeedbackAt'] = None
        if request.reasoning_summary is not None:
            value['reasoningSummary'] = request.reasoning_summary or None
        if request.profile_aspect is not None:
            value['profileAspect'] = (
                None if request.profile_aspect == 'none' else request.profile_aspect
            )
            if value['profileAspect'] is None:
                value['preferenceScope'] = None
                value['preferenceProjectId'] = None
            elif not previous.get('profileAspect'):
                value['preferenceScope'] = 'global'
                value['preferenceProjectId'] = None
        if request.inheritance_mode is not None:
            value['inheritanceMode'] = request.inheritance_mode
        if request.inherited_project_ids is not None:
            value['inheritedProjectIds'] = request.inherited_project_ids
        if value.get('confirmationStatus') == 'confirmed':
            value['epistemicStatus'] = 'confirmed'
            value['confidenceScore'] = 1.0
        elif value.get('confirmationStatus') == 'agent_confirmed':
            value['epistemicStatus'] = 'observed'
            value['confidenceScore'] = min(
                float(value.get('confidenceScore') or 0.75),
                0.85,
            )
        else:
            value['epistemicStatus'] = (
                'exploratory'
                if value.get('originQuadrant') == 'unknown_unknown'
                else 'observed'
            )
            if content_changed or classification_changed or trust_reset:
                value['confidenceScore'] = 0.5
    elif request.action == 'invalidate':
        value['invalidAt'] = changed_at.isoformat()
        value['replacedByItemId'] = request.replacement_item_id
        value['replacedByItemKind'] = request.replacement_item_kind
    elif request.action == 'link_replacement':
        value['replacedByItemId'] = request.replacement_item_id
        value['replacedByItemKind'] = request.replacement_item_kind
    elif request.action == 'restore':
        value['invalidAt'] = None
        value['replacedByItemId'] = None
        value['replacedByItemKind'] = None
    if value.get('confirmationStatus') == 'confirmed':
        # A person's explicit confirmation is the only thing that lifts a
        # negative-feedback block; the revision's previous value keeps it.
        value['negativeFeedbackBlock'] = None
    return value


async def _updated_embedding(store, previous: dict, current: dict, request):
    if request.action != 'update':
        return None
    key = 'name' if request.item_kind == 'entity' else 'fact'
    if previous.get(key) == current.get(key):
        return None
    return (await store.runtime.embedder.create_batch([current[key]]))[0]


async def _update_item(
    store, space, item_id, item_kind, value, embedding, *, expected_lock_version,
):
    # Every item writer bumps fuli_ai_review_lock_version. Bumping it first
    # takes Neo4j's write lock before the read, so the WHERE sees the latest
    # committed version and only an unchanged item is overwritten. The caller's
    # transaction rolls the bump back when the version moved.
    invalid_at = _parse_datetime(value.get('invalidAt'))
    if item_kind == 'entity':
        query = '''
        MATCH (item:Entity {uuid: $item_id, group_id: $group_id})
        SET item.fuli_ai_review_lock_version =
              coalesce(item.fuli_ai_review_lock_version, 0) + 1
        WITH item WHERE item.fuli_ai_review_lock_version = $expected_lock_version + 1
        SET item.name = $name,
            item.summary = $summary,
            item.fuli_invalid_at = $invalid_at,
            item.fuli_origin_quadrant = $origin_quadrant,
            item.fuli_current_quadrant = $current_quadrant,
            item.fuli_epistemic_status = $epistemic_status,
            item.fuli_confirmation_status = $confirmation_status,
            item.fuli_confirmation_basis_json = $confirmation_basis_json,
            item.fuli_reasoning_summary = $reasoning_summary,
            item.fuli_profile_aspect = $profile_aspect,
            item.fuli_preference_scope = $preference_scope,
            item.fuli_preference_project_id = $preference_project_id,
            item.fuli_inheritance_mode = $inheritance_mode,
            item.fuli_inherited_project_ids = $inherited_project_ids,
            item.fuli_utility_score = $utility_score,
            item.fuli_confidence_score = $confidence_score,
            item.fuli_qualified_use_count = $qualified_use_count,
            item.fuli_distinct_task_count = $distinct_task_count,
            item.fuli_last_used_at = $last_used_at,
            item.fuli_usage_generation = $usage_generation,
            item.fuli_negative_evidence_count = $negative_evidence_count,
            item.fuli_requires_attention = $requires_attention,
            item.fuli_last_feedback_kind = $last_feedback_kind,
            item.fuli_last_feedback_at = $last_feedback_at,
            item.fuli_negative_feedback_block_json = $negative_feedback_block_json,
            item.fuli_replaced_by_item_id = $replaced_by_item_id,
            item.fuli_replaced_by_item_kind = $replaced_by_item_kind,
            item.name_embedding = coalesce($embedding, item.name_embedding)
        RETURN item.uuid AS item_id
        '''
        parameters = {'name': value['name'], 'summary': value['summary']}
    else:
        query = '''
        MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
        SET item.fuli_ai_review_lock_version =
              coalesce(item.fuli_ai_review_lock_version, 0) + 1
        WITH item WHERE item.fuli_ai_review_lock_version = $expected_lock_version + 1
        SET item.fact = $fact,
            item.invalid_at = $invalid_at,
            item.fuli_origin_quadrant = $origin_quadrant,
            item.fuli_current_quadrant = $current_quadrant,
            item.fuli_epistemic_status = $epistemic_status,
            item.fuli_confirmation_status = $confirmation_status,
            item.fuli_confirmation_basis_json = $confirmation_basis_json,
            item.fuli_reasoning_summary = $reasoning_summary,
            item.fuli_profile_aspect = $profile_aspect,
            item.fuli_preference_scope = $preference_scope,
            item.fuli_preference_project_id = $preference_project_id,
            item.fuli_inheritance_mode = $inheritance_mode,
            item.fuli_inherited_project_ids = $inherited_project_ids,
            item.fuli_utility_score = $utility_score,
            item.fuli_confidence_score = $confidence_score,
            item.fuli_qualified_use_count = $qualified_use_count,
            item.fuli_distinct_task_count = $distinct_task_count,
            item.fuli_last_used_at = $last_used_at,
            item.fuli_usage_generation = $usage_generation,
            item.fuli_negative_evidence_count = $negative_evidence_count,
            item.fuli_requires_attention = $requires_attention,
            item.fuli_last_feedback_kind = $last_feedback_kind,
            item.fuli_last_feedback_at = $last_feedback_at,
            item.fuli_negative_feedback_block_json = $negative_feedback_block_json,
            item.fuli_replaced_by_item_id = $replaced_by_item_id,
            item.fuli_replaced_by_item_kind = $replaced_by_item_kind,
            item.fact_embedding = coalesce($embedding, item.fact_embedding)
        RETURN item.uuid AS item_id
        '''
        parameters = {'fact': value['fact']}
    records, _, _ = await store.runtime.driver.execute_query(
        query,
        item_id=item_id,
        group_id=space['group_id'],
        expected_lock_version=expected_lock_version,
        invalid_at=invalid_at,
        origin_quadrant=value['originQuadrant'],
        current_quadrant=value['currentQuadrant'],
        epistemic_status=value['epistemicStatus'],
        confirmation_status=value.get('confirmationStatus', 'pending'),
        confirmation_basis_json=(
            json.dumps(
                value['confirmationBasis'],
                ensure_ascii=False,
                sort_keys=True,
            )
            if value.get('confirmationBasis') else None
        ),
        reasoning_summary=value.get('reasoningSummary'),
        profile_aspect=value.get('profileAspect'),
        preference_scope=value.get('preferenceScope'),
        preference_project_id=value.get('preferenceProjectId'),
        inheritance_mode=value.get('inheritanceMode', 'local_only'),
        inherited_project_ids=value.get('inheritedProjectIds') or [],
        utility_score=float(value.get('utilityScore') or 0),
        confidence_score=float(value.get('confidenceScore') or 0.5),
        qualified_use_count=int(value.get('qualifiedUseCount') or 0),
        distinct_task_count=int(value.get('distinctTaskCount') or 0),
        last_used_at=_parse_datetime(value.get('lastUsedAt')),
        usage_generation=int(value.get('usageGeneration') or 1),
        negative_evidence_count=int(
            value.get('negativeEvidenceCount') or 0
        ),
        requires_attention=value.get('requiresAttention') is True,
        last_feedback_kind=value.get('lastFeedbackKind'),
        last_feedback_at=_parse_datetime(value.get('lastFeedbackAt')),
        negative_feedback_block_json=(
            json.dumps(
                value['negativeFeedbackBlock'],
                ensure_ascii=False,
                sort_keys=True,
            )
            if value.get('negativeFeedbackBlock') else None
        ),
        replaced_by_item_id=value.get('replacedByItemId'),
        replaced_by_item_kind=value.get('replacedByItemKind'),
        embedding=embedding,
        **parameters,
    )
    if not records:
        raise HTTPException(
            status_code=409,
            detail='knowledge changed while it was being revised; read it again',
        )


def _confirmation_basis(value) -> ConfirmationBasis | None:
    if not value:
        return None
    if isinstance(value, str):
        value = json.loads(value)
    return ConfirmationBasis.model_validate(value)


def _pending_confirmation_basis(value, reason: str) -> dict:
    basis = dict(value or {})
    basis.setdefault('existence_reason', reason)
    basis.setdefault('quadrant_reason', reason)
    basis.setdefault('proposed_by', {'kind': 'user', 'label': '当前用户'})
    basis['confirmed_by'] = None
    basis['confirmed_at'] = None
    basis.pop('agent_policy_version', None)
    return basis


async def _update_preference_scope(
    store,
    space,
    item_id,
    item_kind,
    scope,
    project_id,
):
    if item_kind == 'entity':
        query = '''
        MATCH (item:Entity {uuid: $item_id, group_id: $group_id})
        SET item.fuli_ai_review_lock_version =
              coalesce(item.fuli_ai_review_lock_version, 0) + 1
        SET item.fuli_preference_scope = $scope,
            item.fuli_preference_project_id = $project_id
        '''
    else:
        query = '''
        MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
        SET item.fuli_ai_review_lock_version =
              coalesce(item.fuli_ai_review_lock_version, 0) + 1
        SET item.fuli_preference_scope = $scope,
            item.fuli_preference_project_id = $project_id
        '''
    await store.runtime.driver.execute_query(
        query,
        item_id=item_id,
        group_id=space['group_id'],
        scope=scope,
        project_id=project_id,
    )
def _iso(value):
    native = _native_datetime(value)
    return native.isoformat() if isinstance(native, datetime) else native


def _parse_datetime(value):
    if not value or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value.replace('Z', '+00:00'))
