import json
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException

from .common_knowledge_models import (
    CommonKnowledgePromotionPreview,
    CommonKnowledgePromotionRequest,
    CommonKnowledgePromotionResult,
)
from .knowledge_management import (
    _read_assignment,
    _read_item,
    _snapshot,
    _implicit_project_id,
)
from .personal_project_access import authorize_personal_project
from .provider_values import stable_uuid


@dataclass(frozen=True)
class _PromotionItem:
    item_id: str
    project_id: str
    previous: dict


@dataclass(frozen=True)
class _PromotionPlan:
    space: dict
    canonical: _PromotionItem
    duplicates: list[_PromotionItem]

    @property
    def source_project_ids(self) -> list[str]:
        return sorted([
            self.canonical.project_id,
            *(item.project_id for item in self.duplicates),
        ])


async def preview_common_knowledge_promotion(
    store,
    actor: dict,
    request: CommonKnowledgePromotionRequest,
) -> CommonKnowledgePromotionPreview:
    plan = await _promotion_plan(store, actor, request)
    return CommonKnowledgePromotionPreview(
        status='ready',
        personal_space_id=request.personal_space_id,
        parent_project_id=request.parent_project_id,
        item_kind=request.item_kind,
        canonical_item_id=request.canonical_item_id,
        duplicate_item_ids=sorted(request.duplicate_item_ids),
        source_project_ids=plan.source_project_ids,
        reason=request.reason,
        human_confirmation_reason=request.human_confirmation_reason,
    )


async def apply_common_knowledge_promotion(
    store,
    actor: dict,
    request: CommonKnowledgePromotionRequest,
    *,
    changed_at: datetime | None = None,
) -> CommonKnowledgePromotionResult:
    plan = await _promotion_plan(store, actor, request)
    promoted_at = changed_at or datetime.now(timezone.utc)
    promotion_id = stable_uuid(
        request.personal_space_id,
        'common-knowledge-promotion',
        request.parent_project_id,
        request.item_kind,
        request.canonical_item_id,
        promoted_at.isoformat(),
    )
    assignment_id = stable_uuid(
        request.personal_space_id,
        'knowledge-assignment',
        request.item_kind,
        request.canonical_item_id,
    )
    canonical_current = {
        **plan.canonical.previous,
        'inheritanceMode': 'descendants',
        'inheritedProjectIds': [],
    }
    revision_specs = [{
        'revision_id': stable_uuid(
            promotion_id, 'revision', request.canonical_item_id
        ),
        'item_id': request.canonical_item_id,
        'action': 'promote_common',
        'previous_json': _json(plan.canonical.previous),
        'current_json': _json(canonical_current),
    }]
    duplicate_specs = []
    for duplicate in plan.duplicates:
        current = {
            **duplicate.previous,
            'invalidAt': promoted_at.isoformat(),
            'replacedByItemId': request.canonical_item_id,
            'replacedByItemKind': request.item_kind,
        }
        revision_specs.append({
            'revision_id': stable_uuid(
                promotion_id, 'revision', duplicate.item_id
            ),
            'item_id': duplicate.item_id,
            'action': 'replace_common_duplicate',
            'previous_json': _json(duplicate.previous),
            'current_json': _json(current),
        })
        duplicate_specs.append({
            'item_id': duplicate.item_id,
            'project_id': duplicate.project_id,
        })

    query = _promotion_query(request.item_kind)
    records, _, _ = await store.runtime.driver.execute_query(
        query,
        space_id=request.personal_space_id,
        group_id=plan.space['group_id'],
        parent_project_id=request.parent_project_id,
        source_project_ids=plan.source_project_ids,
        canonical_item_id=request.canonical_item_id,
        canonical_source_project_id=plan.canonical.project_id,
        duplicate_specs=duplicate_specs,
        item_kind=request.item_kind,
        assignment_id=assignment_id,
        promotion_id=promotion_id,
        revision_specs=revision_specs,
        reason=request.reason,
        human_confirmation_reason=request.human_confirmation_reason,
        changed_by=actor['id'],
        operation_actor=request.operation_actor,
        changed_at=promoted_at,
    )
    if not records:
        raise HTTPException(
            status_code=409,
            detail='common knowledge changed after preview; review it again',
        )
    record = records[0]
    return CommonKnowledgePromotionResult(
        status='promoted',
        promotion_id=record.get('promotion_id') or promotion_id,
        personal_space_id=request.personal_space_id,
        parent_project_id=request.parent_project_id,
        item_kind=request.item_kind,
        canonical_item_id=request.canonical_item_id,
        invalidated_item_ids=sorted(request.duplicate_item_ids),
        source_project_ids=plan.source_project_ids,
        revision_ids=record.get('revision_ids') or [
            item['revision_id'] for item in revision_specs
        ],
        reason=request.reason,
        human_confirmation_reason=request.human_confirmation_reason,
    )


async def _promotion_plan(store, actor, request) -> _PromotionPlan:
    store._require_personal()
    space = await store.authorize(
        actor, request.personal_space_id, 'maintainer'
    )
    if space['kind'] != 'personal':
        raise HTTPException(
            status_code=422,
            detail='common knowledge promotion is personal-only',
        )
    await authorize_personal_project(
        store, actor, space, request.parent_project_id
    )
    direct_child_ids = await _direct_child_project_ids(
        store, space['id'], request.parent_project_id
    )
    item_ids = [request.canonical_item_id, *request.duplicate_item_ids]
    items = []
    for item_id in item_ids:
        value = await _read_item(store, space, item_id, request.item_kind)
        if value is None:
            raise HTTPException(status_code=404, detail='knowledge item not found')
        if value.get('profile_aspect'):
            raise HTTPException(
                status_code=422,
                detail='personal profile knowledge cannot become common project knowledge',
            )
        if value.get('invalid_at'):
            raise HTTPException(
                status_code=409,
                detail='historical knowledge cannot be promoted as common knowledge',
            )
        project_id = await _item_project_id(
            store, space, item_id, request.item_kind
        )
        if project_id not in direct_child_ids:
            raise HTTPException(
                status_code=422,
                detail='every promoted item must belong to a direct PART_OF child',
            )
        items.append(_PromotionItem(
            item_id=item_id,
            project_id=project_id,
            previous=_snapshot(value, request.item_kind),
        ))
    project_ids = [item.project_id for item in items]
    if len(set(project_ids)) != len(project_ids):
        raise HTTPException(
            status_code=422,
            detail='common knowledge evidence must come from distinct child projects',
        )
    return _PromotionPlan(
        space=space,
        canonical=items[0],
        duplicates=items[1:],
    )


async def _direct_child_project_ids(store, space_id, parent_project_id):
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:CONTAINS_PROJECT]->(child:FuliPersonalProject)-
              [relation:PERSONAL_PROJECT_RELATION {relation_type: 'PART_OF'}]->
              (parent:FuliPersonalProject {project_id: $parent_project_id})
        WHERE relation.status = 'active'
          AND relation.confirmation_authority = 'human_review'
        RETURN child.project_id AS child_project_id
        ORDER BY child.project_id
        ''',
        space_id=space_id,
        parent_project_id=parent_project_id,
        routing_='r',
    )
    return {record['child_project_id'] for record in records}


async def _item_project_id(store, space, item_id, item_kind):
    assignment = await _read_assignment(
        store, space['id'], item_id, item_kind
    )
    if assignment:
        return assignment.project_id
    return await _implicit_project_id(store, space, item_id, item_kind)


def _promotion_query(item_kind):
    canonical_project_guard = _current_project_guard(
        item_kind,
        item_variable='canonical',
        variable_prefix='canonical',
        item_id_expression='$canonical_item_id',
        project_id_expression='$canonical_source_project_id',
    )
    duplicate_project_guard = _current_project_guard(
        item_kind,
        item_variable='duplicate',
        variable_prefix='duplicate',
        item_id_expression='duplicate_spec.item_id',
        project_id_expression='duplicate_spec.project_id',
    )
    if item_kind == 'entity':
        canonical_match = f'''
        MATCH (canonical:Entity {{
          uuid: $canonical_item_id,
          group_id: $group_id
        }})
        WHERE canonical.fuli_invalid_at IS NULL
        {canonical_project_guard}
        '''
        duplicate_match = f'''
        MATCH (duplicate:Entity {{
          uuid: duplicate_spec.item_id,
          group_id: $group_id
        }})
        WHERE duplicate.fuli_invalid_at IS NULL
        {duplicate_project_guard}
        '''
        duplicate_update = '''
        FOREACH (pair IN duplicate_pairs |
          SET pair.item.fuli_invalid_at = $changed_at,
              pair.item.fuli_replaced_by_item_id = $canonical_item_id,
              pair.item.fuli_replaced_by_item_kind = $item_kind
        )
        '''
    else:
        canonical_match = f'''
        MATCH ()-[canonical:RELATES_TO {{
          uuid: $canonical_item_id,
          group_id: $group_id
        }}]->()
        WHERE canonical.invalid_at IS NULL
        {canonical_project_guard}
        '''
        duplicate_match = f'''
        MATCH ()-[duplicate:RELATES_TO {{
          uuid: duplicate_spec.item_id,
          group_id: $group_id
        }}]->()
        WHERE duplicate.invalid_at IS NULL
        {duplicate_project_guard}
        '''
        duplicate_update = '''
        FOREACH (pair IN duplicate_pairs |
          SET pair.item.invalid_at = $changed_at,
              pair.item.fuli_replaced_by_item_id = $canonical_item_id,
              pair.item.fuli_replaced_by_item_kind = $item_kind
        )
        '''
    return f'''
        MATCH (space:FuliSpace {{id: $space_id, kind: 'personal'}})-
              [:CONTAINS_PROJECT]->
              (parent:FuliPersonalProject {{project_id: $parent_project_id}})
        UNWIND $source_project_ids AS source_project_id
        MATCH (space)-[:CONTAINS_PROJECT]->
              (child:FuliPersonalProject {{project_id: source_project_id}})-
              [relation:PERSONAL_PROJECT_RELATION {{relation_type: 'PART_OF'}}]->
              (parent)
        WHERE relation.status = 'active'
          AND relation.confirmation_authority = 'human_review'
        WITH space, parent, collect(DISTINCT child.project_id) AS direct_children
        WHERE size(direct_children) = size($source_project_ids)
        {canonical_match}
        WITH space, parent, canonical, direct_children
        UNWIND $duplicate_specs AS duplicate_spec
        {duplicate_match}
        WITH space, parent, canonical, direct_children,
             collect({{item: duplicate, spec: duplicate_spec}}) AS duplicate_pairs
        WHERE size(duplicate_pairs) = size($duplicate_specs)
        SET canonical.fuli_inheritance_mode = 'descendants',
            canonical.fuli_inherited_project_ids = []
        {duplicate_update}
        MERGE (assignment:FuliKnowledgeAssignment {{
          space_id: $space_id,
          item_kind: $item_kind,
          item_id: $canonical_item_id
        }})
        ON CREATE SET assignment.id = $assignment_id,
                      assignment.created_at = $changed_at
        SET assignment.previous_project_id = $canonical_source_project_id,
            assignment.project_id = $parent_project_id,
            assignment.reason = $reason,
            assignment.changed_by = $changed_by,
            assignment.updated_at = $changed_at
        WITH space, parent, assignment
        OPTIONAL MATCH (assignment)-[old:ASSIGNED_TO]->
                       (:FuliPersonalProject)
        DELETE old
        MERGE (assignment)-[:ASSIGNED_TO]->(parent)
        MERGE (space)-[:HAS_KNOWLEDGE_ASSIGNMENT]->(assignment)
        CREATE (promotion:FuliCommonKnowledgePromotion {{
          id: $promotion_id,
          space_id: $space_id,
          parent_project_id: $parent_project_id,
          item_kind: $item_kind,
          canonical_item_id: $canonical_item_id,
          duplicate_item_ids: [item IN $duplicate_specs | item.item_id],
          source_project_ids: $source_project_ids,
          reason: $reason,
          human_confirmation_reason: $human_confirmation_reason,
          operation_actor: $operation_actor,
          created_by: $changed_by,
          created_at: $changed_at
        }})
        MERGE (space)-[:HAS_COMMON_KNOWLEDGE_PROMOTION]->(promotion)
        WITH promotion, assignment, space
        UNWIND $revision_specs AS revision_spec
        CREATE (revision:FuliKnowledgeRevision {{
          id: revision_spec.revision_id,
          space_id: $space_id,
          item_id: revision_spec.item_id,
          item_kind: $item_kind,
          action: revision_spec.action,
          reason: $reason,
          previous_json: revision_spec.previous_json,
          current_json: revision_spec.current_json,
          created_by: $changed_by,
          created_at: $changed_at
        }})
        MERGE (space)-[:HAS_KNOWLEDGE_REVISION]->(revision)
        RETURN promotion.id AS promotion_id,
               assignment.id AS assignment_id,
               collect(revision.id) AS revision_ids
    '''


def _current_project_guard(
    item_kind,
    *,
    item_variable,
    variable_prefix,
    item_id_expression,
    project_id_expression,
):
    if item_kind == 'entity':
        implicit_project_match = f'''
          MATCH ({variable_prefix}_episode:Episodic {{group_id: $group_id}})-
                [:MENTIONS]->({item_variable})
        '''
    else:
        implicit_project_match = f'''
          UNWIND coalesce({item_variable}.episodes, [])
                 AS {variable_prefix}_episode_id
          MATCH ({variable_prefix}_episode:Episodic {{
            uuid: {variable_prefix}_episode_id,
            group_id: $group_id
          }})
        '''
    return f'''
        AND (
          EXISTS {{
            MATCH (space)-[:HAS_KNOWLEDGE_ASSIGNMENT]->
                  ({variable_prefix}_assignment:FuliKnowledgeAssignment {{
                    item_kind: $item_kind,
                    item_id: {item_id_expression}
                  }})
            WHERE {variable_prefix}_assignment.project_id = {project_id_expression}
          }}
          OR (
            NOT EXISTS {{
              MATCH (space)-[:HAS_KNOWLEDGE_ASSIGNMENT]->
                    (:FuliKnowledgeAssignment {{
                      item_kind: $item_kind,
                      item_id: {item_id_expression}
                    }})
            }}
            AND EXISTS {{
              {implicit_project_match}
              WHERE {variable_prefix}_episode.fuli_personal_project_id
                    IS NOT NULL
              WITH collect(DISTINCT
                     {variable_prefix}_episode.fuli_personal_project_id)
                   AS {variable_prefix}_project_ids
              WHERE {variable_prefix}_project_ids =
                    [{project_id_expression}]
              RETURN {variable_prefix}_project_ids
            }}
          )
        )
    '''


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)
