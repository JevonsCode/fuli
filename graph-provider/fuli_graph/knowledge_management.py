import json
from datetime import datetime, timezone

from fastapi import HTTPException

from .knowledge_audit import record_human_change
from .knowledge_records import assignment_record
from .personal_project_access import authorize_personal_project
from .models import (
    ConfirmationBasis,
    KnowledgeAssignmentChange,
    KnowledgeAssignmentRecord,
    PreferenceScopeChange,
    KnowledgeRevisionCreate,
    KnowledgeRevisionRecord,
)
from .provider_values import (
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
    await _update_item(
        store, space, item_id, request.item_kind, next_value, embedding
    )

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
        current_json=json.dumps(next_value, ensure_ascii=False, sort_keys=True),
        created_by=actor['id'],
        created_at=created_at,
    )
    if request.operation_actor == 'human':
        await record_human_change(
            store,
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
    changed_at = datetime.now(timezone.utc)
    assignment_id = existing.id if existing else _stable_uuid(
        space['id'], 'knowledge-assignment', request.item_kind, item_id
    )
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        MATCH (space)-[:CONTAINS_PROJECT]->
              (target:FuliPersonalProject {project_id: $target_project_id})
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
        WITH assignment, target
        OPTIONAL MATCH (assignment)-[old:ASSIGNED_TO]->(:FuliPersonalProject)
        DELETE old
        MERGE (assignment)-[:ASSIGNED_TO]->(target)
        MERGE (space)-[:HAS_KNOWLEDGE_ASSIGNMENT]->(assignment)
        RETURN assignment
        ''',
        space_id=space['id'],
        target_project_id=request.target_project_id,
        item_kind=request.item_kind,
        item_id=item_id,
        assignment_id=assignment_id,
        previous_project_id=previous_project_id,
        reason=request.reason,
        changed_by=actor['id'],
        changed_at=changed_at,
    )
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
    if request.operation_actor == 'human':
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
               item.fuli_replaced_by_item_id AS replaced_by_item_id,
               item.fuli_replaced_by_item_kind AS replaced_by_item_kind
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
               item.fuli_replaced_by_item_id AS replaced_by_item_id,
               item.fuli_replaced_by_item_kind AS replaced_by_item_kind
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
    project_ids = records[0]['project_ids'] if records else []
    return project_ids[0] if len(project_ids) == 1 else None


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
    return value


async def _updated_embedding(store, previous: dict, current: dict, request):
    if request.action != 'update':
        return None
    key = 'name' if request.item_kind == 'entity' else 'fact'
    if previous.get(key) == current.get(key):
        return None
    return (await store.runtime.embedder.create_batch([current[key]]))[0]


async def _update_item(store, space, item_id, item_kind, value, embedding):
    invalid_at = _parse_datetime(value.get('invalidAt'))
    if item_kind == 'entity':
        query = '''
        MATCH (item:Entity {uuid: $item_id, group_id: $group_id})
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
            item.fuli_replaced_by_item_id = $replaced_by_item_id,
            item.fuli_replaced_by_item_kind = $replaced_by_item_kind,
            item.name_embedding = coalesce($embedding, item.name_embedding)
        '''
        parameters = {'name': value['name'], 'summary': value['summary']}
    else:
        query = '''
        MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
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
            item.fuli_replaced_by_item_id = $replaced_by_item_id,
            item.fuli_replaced_by_item_kind = $replaced_by_item_kind,
            item.fact_embedding = coalesce($embedding, item.fact_embedding)
        '''
        parameters = {'fact': value['fact']}
    await store.runtime.driver.execute_query(
        query,
        item_id=item_id,
        group_id=space['group_id'],
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
        replaced_by_item_id=value.get('replacedByItemId'),
        replaced_by_item_kind=value.get('replacedByItemKind'),
        embedding=embedding,
        **parameters,
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
        SET item.fuli_preference_scope = $scope,
            item.fuli_preference_project_id = $project_id
        '''
    else:
        query = '''
        MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
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
