from datetime import datetime, timezone

from fastapi import HTTPException

from .knowledge_audit import record_human_change
from .knowledge_records import conflict_record, reference_record
from .personal_project_access import authorize_personal_project
from .knowledge_management import (
    _implicit_project_id,
    _read_assignment,
    _read_item,
    reassign_knowledge_item,
)
from .models import (
    KnowledgeAssignmentChange,
    PersonalProjectUpsert,
    ProjectProfile,
    ProjectSource,
)
from .project_action_models import (
    KnowledgeProjectActionRequest,
    KnowledgeProjectActionResult,
    KnowledgeProjectMatch,
    KnowledgeProjectPreviewRecord,
    KnowledgeProjectPreviewRequest,
)
from .provider_values import (
    normalized_text as _normalized,
    stable_uuid as _stable_uuid,
)


async def preview_knowledge_project_action(
    store,
    actor: dict,
    item_id: str,
    request: KnowledgeProjectPreviewRequest,
) -> KnowledgeProjectPreviewRecord:
    space, item = await _authorize_item(store, actor, item_id, request)
    if request.mode == 'create':
        source_project_id = await _source_project_id(
            store, space, item_id, request.item_kind
        )
        target_project_id = request.new_project_id
        await _ensure_new_project_id(store, space, target_project_id)
        match = KnowledgeProjectMatch(
            kind='none',
            reason='新项目标识可用，尚未执行创建。',
        )
    else:
        target_project_id = request.target_project_id
        await authorize_personal_project(store, actor, space, target_project_id)
        source_project_id = await _source_project_id(
            store, space, item_id, request.item_kind
        )
        match = await _match_target_project(
            store,
            space,
            item_id,
            request.item_kind,
            item,
            target_project_id,
            source_project_id,
        )
    return KnowledgeProjectPreviewRecord(
        item_id=item_id,
        item_name=item['name'],
        item_summary=item.get('summary') or '',
        source_project_id=source_project_id,
        target_project_id=target_project_id,
        match=match,
    )


async def apply_knowledge_project_action(
    store,
    actor: dict,
    item_id: str,
    request: KnowledgeProjectActionRequest,
) -> KnowledgeProjectActionResult:
    space, item = await _authorize_item(store, actor, item_id, request)
    source_project_id = await _source_project_id(
        store, space, item_id, request.item_kind
    )
    project_created = request.mode == 'create'
    if project_created:
        target_project_id = request.new_project_id
        await _ensure_new_project_id(store, space, target_project_id)
        await store.upsert_personal_project(
            actor,
            PersonalProjectUpsert(
                personal_space_id=space['id'],
                project_id=target_project_id,
                profile=_new_project_profile(item_id, item, request),
            ),
        )
        match = KnowledgeProjectMatch(
            kind='none',
            reason='新项目中还没有同名知识，将以当前节点作为项目起点。',
        )
    else:
        target_project_id = request.target_project_id
        await authorize_personal_project(store, actor, space, target_project_id)
        match = await _match_target_project(
            store,
            space,
            item_id,
            request.item_kind,
            item,
            target_project_id,
            source_project_id,
        )

    if match.kind == 'already_linked':
        relation_present = await _maybe_create_project_relation(
            store,
            space,
            source_project_id,
            target_project_id,
            request,
            actor['id'],
        )
        result = _action_result(
            'already_linked', source_project_id, target_project_id,
            project_created, relation_present, match,
        )
        await _record_project_action_if_human(
            store, actor, space, item_id, request
        )
        return result

    if source_project_id is None and match.kind == 'none':
        await reassign_knowledge_item(
            store,
            actor,
            item_id,
            KnowledgeAssignmentChange(
                personal_space_id=space['id'],
                item_kind=request.item_kind,
                target_project_id=target_project_id,
                reason=request.reason,
                operation_actor=request.operation_actor,
            ),
        )
        status = 'created' if project_created else 'linked'
        return _action_result(
            status, None, target_project_id, project_created, False, match,
        )

    reference_status = _reference_status(match.kind, request.conflict_resolution)
    reference = await _upsert_reference(
        store,
        space,
        actor,
        item_id,
        request.item_kind,
        target_project_id,
        source_project_id,
        reference_status,
        match.item_id,
        request.reason,
    )
    conflict = None
    if match.kind == 'conflict':
        conflict = await _upsert_conflict(
            store,
            space,
            actor,
            item_id,
            match.item_id,
            source_project_id,
            target_project_id,
            request.conflict_resolution,
            request.reason,
        )

    relation_present = await _maybe_create_project_relation(
        store,
        space,
        source_project_id,
        target_project_id,
        request,
        actor['id'],
    )

    status = _action_status(
        project_created, match.kind, request.conflict_resolution
    )
    result = _action_result(
        status,
        source_project_id,
        target_project_id,
        project_created,
        relation_present,
        match,
        reference,
        conflict,
    )
    await _record_project_action_if_human(
        store, actor, space, item_id, request
    )
    return result


async def _record_project_action_if_human(
    store,
    actor,
    space,
    item_id,
    request,
):
    if request.operation_actor != 'human':
        return
    await record_human_change(
        store,
        actor,
        space,
        item_id,
        request.item_kind,
        reason=request.reason,
        operation='project_action',
    )


async def read_project_references(store, space_id: str, item_ids: list[str]):
    if not item_ids:
        return {}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_REFERENCE]->
              (reference:FuliKnowledgeProjectReference)
        WHERE reference.item_id IN $item_ids
        RETURN reference ORDER BY reference.updated_at DESC
        ''',
        space_id=space_id,
        item_ids=item_ids,
        routing_='r',
    )
    result = {}
    for record in records:
        value = reference_record(dict(record['reference']))
        result.setdefault(value.item_id, []).append(value)
    return result


async def read_knowledge_conflicts(store, space_id: str, item_ids: list[str]):
    if not item_ids:
        return {}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_CONFLICT]->(conflict:FuliKnowledgeConflict)
        WHERE conflict.item_id IN $item_ids OR conflict.target_item_id IN $item_ids
        RETURN conflict ORDER BY conflict.updated_at DESC
        ''',
        space_id=space_id,
        item_ids=item_ids,
        routing_='r',
    )
    result = {}
    for record in records:
        value = conflict_record(dict(record['conflict']))
        result.setdefault(value.item_id, []).append(value)
        if value.target_item_id != value.item_id:
            result.setdefault(value.target_item_id, []).append(value)
    return result


async def read_personal_project_relations(store, space_id: str) -> list[dict]:
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:CONTAINS_PROJECT]->(source:FuliPersonalProject)-
              [relation:PERSONAL_PROJECT_RELATION]->(target:FuliPersonalProject)
        RETURN source.project_id AS source_project_id,
               source.name AS source_name,
               target.project_id AS target_project_id,
               target.name AS target_name,
               relation
        ORDER BY relation.updated_at DESC
        ''',
        space_id=space_id,
        routing_='r',
    )
    return [
        {
            'source_project_id': record['source_project_id'],
            'source_name': record['source_name'],
            'target_project_id': record['target_project_id'],
            'target_name': record['target_name'],
            **dict(record['relation']),
        }
        for record in records
    ]


async def _authorize_item(store, actor, item_id, request):
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='knowledge project action is personal-only')
    item = await _read_item(store, space, item_id, request.item_kind)
    if item is None:
        raise HTTPException(status_code=404, detail='knowledge item not found')
    if item.get('profile_aspect'):
        raise HTTPException(
            status_code=422,
            detail='personal profile knowledge cannot be added to a project',
        )
    if item.get('invalid_at'):
        raise HTTPException(
            status_code=422,
            detail='historical knowledge must be restored before adding it to a project',
        )
    return space, item


async def _source_project_id(store, space, item_id, item_kind):
    assignment = await _read_assignment(store, space['id'], item_id, item_kind)
    if assignment:
        return assignment.project_id
    return await _implicit_project_id(store, space, item_id, item_kind)


async def _ensure_new_project_id(store, space, project_id):
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:CONTAINS_PROJECT]->
              (project:FuliPersonalProject {project_id: $project_id})
        RETURN project.project_id AS project_id
        ''',
        space_id=space['id'],
        project_id=project_id,
        routing_='r',
    )
    if records:
        raise HTTPException(
            status_code=409,
            detail='personal project id already exists; choose the existing-project option',
        )


def _new_project_profile(item_id, item, request):
    purpose = request.new_project_purpose or item.get('summary') or None
    return ProjectProfile(
        name=request.new_project_name,
        purpose=purpose,
        scope=f'以图谱节点“{item["name"]}”作为项目知识起点。',
        lifecycle='active',
        sources=[ProjectSource(
            key=f'graph-node-{item_id[:24]}',
            kind='other',
            title=f'图谱节点：{item["name"]}',
            summary=item.get('summary') or '由本机个人图谱节点创建。',
            sensitivity='private',
        )],
    )


async def _match_target_project(
    store,
    space,
    item_id,
    item_kind,
    item,
    target_project_id,
    source_project_id,
):
    if source_project_id == target_project_id:
        return KnowledgeProjectMatch(
            kind='already_linked',
            reason='这条知识的主要归属已经是目标项目。',
            item_id=item_id,
            item_name=item['name'],
            item_summary=item.get('summary') or '',
        )
    existing = await _read_reference(
        store, space['id'], item_id, item_kind, target_project_id
    )
    if existing and existing.status in {'active', 'pending_conflict', 'duplicate'}:
        kind = {
            'active': 'already_linked',
            'pending_conflict': 'conflict',
            'duplicate': 'exact_duplicate',
        }[existing.status]
        target = await _read_entity_summary(
            store, space, existing.matched_item_id
        ) if existing.matched_item_id else None
        return KnowledgeProjectMatch(
            kind=kind,
            reason={
                'active': '目标项目已经在引用这条知识。',
                'pending_conflict': '这条知识与目标项目内容的冲突仍在待处理。',
                'duplicate': '目标项目已经存在完全相同的内容。',
            }[existing.status],
            item_id=existing.matched_item_id or item_id,
            item_name=(target or item).get('name'),
            item_summary=(target or item).get('summary') or '',
        )

    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (candidate:Entity {group_id: $group_id})
        WHERE candidate.uuid <> $item_id
          AND toLower(trim(candidate.name)) = $normalized_name
          AND coalesce(candidate.fuli_type, 'Entity') = $item_type
          AND candidate.fuli_invalid_at IS NULL
        OPTIONAL MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(candidate)
        WITH candidate, collect(DISTINCT episode) AS episodes
        OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
          space_id: $space_id,
          item_kind: 'entity',
          item_id: candidate.uuid
        })
        OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REFERENCE]->
              (reference:FuliKnowledgeProjectReference {item_id: candidate.uuid})
        WITH candidate, episodes, assignment, collect(reference) AS references
        WHERE assignment.project_id = $target_project_id
           OR (assignment.project_id IS NULL AND any(
                episode IN episodes
                WHERE episode.fuli_personal_project_id = $target_project_id
              ))
           OR any(reference IN references WHERE
                reference.project_id = $target_project_id
                AND reference.status = 'active')
        RETURN candidate.uuid AS id, candidate.name AS name,
               coalesce(candidate.summary, '') AS summary,
               coalesce(candidate.fuli_current_quadrant, 'known_known') AS current_quadrant,
               coalesce(candidate.fuli_epistemic_status, 'confirmed') AS epistemic_status,
               coalesce(candidate.fuli_confirmation_status, 'pending')
                 AS confirmation_status
        ORDER BY candidate.created_at DESC LIMIT 8
        ''',
        group_id=space['group_id'],
        space_id=space['id'],
        item_id=item_id,
        normalized_name=_normalized(item['name']),
        item_type=item.get('type') or 'Entity',
        target_project_id=target_project_id,
        routing_='r',
    )
    exact = next((record for record in records if _same_content(item, record)), None)
    if exact:
        return KnowledgeProjectMatch(
            kind='exact_duplicate',
            reason='目标项目已经存在名称、类型和说明完全相同的内容，将复用现有节点。',
            item_id=exact['id'],
            item_name=exact['name'],
            item_summary=exact['summary'],
        )
    conflict = next((record for record in records if _confirmed_current(item, record)), None)
    if conflict:
        return KnowledgeProjectMatch(
            kind='conflict',
            reason='目标项目存在同名的已确认知识，但两者说明不同。',
            item_id=conflict['id'],
            item_name=conflict['name'],
            item_summary=conflict['summary'],
        )
    return KnowledgeProjectMatch(
        kind='none',
        reason='目标项目中没有检测到完全重复或已确认的同名冲突。',
    )


async def _read_reference(store, space_id, item_id, item_kind, project_id):
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_REFERENCE]->
              (reference:FuliKnowledgeProjectReference {
                item_id: $item_id,
                item_kind: $item_kind,
                project_id: $project_id
              })
        RETURN reference
        ''',
        space_id=space_id,
        item_id=item_id,
        item_kind=item_kind,
        project_id=project_id,
        routing_='r',
    )
    return reference_record(dict(records[0]['reference'])) if records else None


async def _read_entity_summary(store, space, item_id):
    if not item_id:
        return None
    return await _read_item(store, space, item_id, 'entity')


async def _upsert_reference(
    store,
    space,
    actor,
    item_id,
    item_kind,
    project_id,
    source_project_id,
    status,
    matched_item_id,
    reason,
):
    reference_id = _stable_uuid(
        space['id'], 'knowledge-reference', item_kind, item_id, project_id
    )
    changed_at = datetime.now(timezone.utc)
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        MATCH (space)-[:CONTAINS_PROJECT]->
              (target:FuliPersonalProject {project_id: $project_id})
        MERGE (reference:FuliKnowledgeProjectReference {
          space_id: $space_id,
          item_kind: $item_kind,
          item_id: $item_id,
          project_id: $project_id
        })
        ON CREATE SET reference.id = $reference_id,
                      reference.created_at = $changed_at
        SET reference.source_project_id = $source_project_id,
            reference.status = $status,
            reference.matched_item_id = $matched_item_id,
            reference.reason = $reason,
            reference.changed_by = $changed_by,
            reference.updated_at = $changed_at
        MERGE (space)-[:HAS_KNOWLEDGE_REFERENCE]->(reference)
        MERGE (reference)-[:REFERENCES_IN]->(target)
        RETURN reference
        ''',
        space_id=space['id'],
        item_kind=item_kind,
        item_id=item_id,
        project_id=project_id,
        reference_id=reference_id,
        source_project_id=source_project_id,
        status=status,
        matched_item_id=matched_item_id,
        reason=reason,
        changed_by=actor['id'],
        changed_at=changed_at,
    )
    return reference_record(dict(records[0]['reference']))


async def _upsert_conflict(
    store,
    space,
    actor,
    item_id,
    target_item_id,
    source_project_id,
    target_project_id,
    resolution,
    reason,
):
    conflict_id = _stable_uuid(
        space['id'], 'knowledge-conflict', item_id, target_project_id, target_item_id
    )
    changed_at = datetime.now(timezone.utc)
    status = 'pending' if resolution == 'defer' else 'resolved'
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        MERGE (conflict:FuliKnowledgeConflict {id: $conflict_id})
        ON CREATE SET conflict.created_at = $changed_at
        SET conflict.space_id = $space_id,
            conflict.item_id = $item_id,
            conflict.target_item_id = $target_item_id,
            conflict.source_project_id = $source_project_id,
            conflict.target_project_id = $target_project_id,
            conflict.status = $status,
            conflict.resolution = $resolution,
            conflict.reason = $reason,
            conflict.decided_by = $decided_by,
            conflict.updated_at = $changed_at
        MERGE (space)-[:HAS_KNOWLEDGE_CONFLICT]->(conflict)
        RETURN conflict
        ''',
        space_id=space['id'],
        conflict_id=conflict_id,
        item_id=item_id,
        target_item_id=target_item_id,
        source_project_id=source_project_id,
        target_project_id=target_project_id,
        status=status,
        resolution=resolution,
        reason=reason,
        decided_by=actor['id'] if status == 'resolved' else None,
        changed_at=changed_at,
    )
    return conflict_record(dict(records[0]['conflict']))


async def _maybe_create_project_relation(
    store,
    space,
    source_project_id,
    target_project_id,
    request,
    actor_id,
):
    if (
        not request.keep_source_relation
        or not source_project_id
        or source_project_id == target_project_id
    ):
        return False
    source, target = _relation_endpoints(
        source_project_id, target_project_id, request
    )
    if request.relation_type == 'RELATED_TO' and source > target:
        source, target = target, source
    relation_id = _stable_uuid(
        space['id'], 'personal-project-relation', source, target, request.relation_type
    )
    changed_at = datetime.now(timezone.utc)
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:CONTAINS_PROJECT]->
              (source:FuliPersonalProject {project_id: $source_project_id})
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:CONTAINS_PROJECT]->
              (target:FuliPersonalProject {project_id: $target_project_id})
        MERGE (source)-[relation:PERSONAL_PROJECT_RELATION {
          id: $relation_id,
          relation_type: $relation_type
        }]->(target)
        ON CREATE SET relation.created_at = $changed_at,
                      relation.created_by = $created_by
        SET relation.updated_at = $changed_at
        RETURN relation.id AS id
        ''',
        space_id=space['id'],
        source_project_id=source,
        target_project_id=target,
        relation_id=relation_id,
        relation_type=request.relation_type,
        created_by=actor_id,
        changed_at=changed_at,
    )
    return bool(records)


def _relation_endpoints(source_project_id, target_project_id, request):
    """Keep an extracted project as the child side of directional relations."""
    if request.mode == 'create':
        return target_project_id, source_project_id
    return source_project_id, target_project_id


def _reference_status(match_kind, resolution):
    if match_kind == 'exact_duplicate':
        return 'duplicate'
    if match_kind != 'conflict':
        return 'active'
    return {
        'defer': 'pending_conflict',
        'keep_target': 'rejected',
        'use_source': 'active',
        'coexist': 'active',
    }[resolution]


def _action_status(project_created, match_kind, resolution):
    if match_kind == 'exact_duplicate':
        return 'duplicate_reused'
    if match_kind == 'conflict':
        return 'conflict_pending' if resolution == 'defer' else 'conflict_resolved'
    return 'created' if project_created else 'linked'


def _action_result(
    status,
    source_project_id,
    target_project_id,
    project_created,
    relation_present,
    match,
    reference=None,
    conflict=None,
):
    return KnowledgeProjectActionResult(
        status=status,
        source_project_id=source_project_id,
        target_project_id=target_project_id,
        project_created=project_created,
        project_relation_created=relation_present,
        match=match,
        reference=reference,
        conflict=conflict,
    )


def _same_content(source, target):
    return _normalized(source.get('summary')) == _normalized(target.get('summary'))


def _confirmed_current(source, target):
    return all(
        item.get('confirmation_status', 'pending') == 'confirmed'
        for item in (source, target)
    )
