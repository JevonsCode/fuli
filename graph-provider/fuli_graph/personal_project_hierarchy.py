"""Moving a personal project in the person's hierarchy (the console's 调整层级).

A project's parent is its active PART_OF relation. A move ends the current
active PART_OF relations (status rejected, with the reason) and makes the new
parent's relation active, each as a human review event, so the history of
where the project sat stays in the review ledger. Nothing else changes: other
relations between projects, their review state and the usage weights keep
their values. Inherited scope and the knowledge reads follow PART_OF at query
time, so they follow the new parent without a separate index.
"""

from dataclasses import dataclass

from fastapi import HTTPException

from .project_action_models import PersonalProjectParentChange, PersonalProjectParentRecord
from .project_knowledge import personal_project_relation_id, relation_review_event_id
from .provider_values import now_utc


@dataclass(frozen=True)
class PartOfRelation:
    id: str
    child: str
    parent: str
    status: str
    revision: int


@dataclass(frozen=True)
class ParentChangePlan:
    retire: tuple[PartOfRelation, ...]
    # The relation that becomes active: an existing one to the new parent, or a new one.
    attach_id: str | None
    attach_revision: int
    previous_parents: tuple[str, ...]


def plan_parent_change(
    space_id: str,
    projects: set[str],
    relations: list[PartOfRelation],
    project_id: str,
    parent_project_id: str | None,
) -> ParentChangePlan:
    """What a move changes, or the HTTP refusal that explains why it cannot."""
    if project_id not in projects:
        raise _refusal(404, 'project_not_found', 'personal project not found')
    if parent_project_id is not None and parent_project_id not in projects:
        raise _refusal(404, 'parent_not_found', 'the new parent project is not in this space')
    if parent_project_id == project_id:
        raise _refusal(422, 'project_hierarchy_self', 'a project cannot be its own parent')
    active = [relation for relation in relations if relation.status == 'active']
    if parent_project_id is not None and parent_project_id in _descendants(active, project_id):
        raise _refusal(
            409, 'project_hierarchy_cycle',
            'the new parent sits inside this project; moving it there would make a cycle',
        )
    current = [relation for relation in active if relation.child == project_id]
    retire = tuple(relation for relation in current if relation.parent != parent_project_id)
    attach_id, attach_revision = None, 0
    if parent_project_id is not None and not any(r.parent == parent_project_id for r in current):
        existing = next((
            relation for relation in relations
            if relation.child == project_id and relation.parent == parent_project_id
        ), None)
        attach_id = existing.id if existing else personal_project_relation_id(
            space_id, project_id, parent_project_id, 'PART_OF'
        )
        attach_revision = existing.revision if existing else 0
    return ParentChangePlan(
        retire=retire,
        attach_id=attach_id,
        attach_revision=attach_revision,
        previous_parents=tuple(sorted(relation.parent for relation in current)),
    )


async def change_personal_project_parent(
    store,
    actor: dict,
    space_id: str,
    project_id: str,
    request: PersonalProjectParentChange,
) -> PersonalProjectParentRecord:
    store._require_personal()
    space = await store.authorize(actor, space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='personal project hierarchy is personal-only')
    projects, relations = await _read_hierarchy(store, space_id)
    plan = plan_parent_change(space_id, projects, relations, project_id, request.parent_project_id)
    record = PersonalProjectParentRecord(
        personal_space_id=space_id,
        project_id=project_id,
        parent_project_id=request.parent_project_id,
        previous_parent_project_ids=list(plan.previous_parents),
        changed=bool(plan.retire or plan.attach_id),
    )
    if not record.changed:
        return record
    attach = None
    if plan.attach_id:
        next_revision = plan.attach_revision + 1
        attach = {
            'relation_id': plan.attach_id,
            'expected_revision': plan.attach_revision,
            'next_revision': next_revision,
            'review_id': relation_review_event_id(space_id, plan.attach_id, next_revision, 'activate'),
        }
    records, _, _ = await store.runtime.driver.execute_query(
        _MOVE_PERSONAL_PROJECT_QUERY,
        space_id=space_id,
        project_id=project_id,
        parent_project_id=request.parent_project_id,
        expected_active=[f'{relation.id}@{relation.revision}' for relation in relations
                         if relation.status == 'active' and relation.child == project_id],
        retire_ids=[relation.id for relation in plan.retire],
        retire_revisions={relation.id: relation.revision + 1 for relation in plan.retire},
        retire_review_ids={
            relation.id: relation_review_event_id(space_id, relation.id, relation.revision + 1, 'reject')
            for relation in plan.retire
        },
        attach=attach,
        reason=request.reason,
        reviewed_by=actor['id'],
        changed_at=now_utc(),
    )
    if not records:
        raise _refusal(
            409, 'project_hierarchy_changed',
            'the project hierarchy changed while moving; refresh and try again',
        )
    return record


async def _read_hierarchy(store, space_id: str) -> tuple[set[str], list[PartOfRelation]]:
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        /* fuli:read-personal-project-hierarchy */
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
              [:CONTAINS_PROJECT]->(project:FuliPersonalProject)
        OPTIONAL MATCH (project)-
              [relation:PERSONAL_PROJECT_RELATION {relation_type: 'PART_OF'}]->
              (parent:FuliPersonalProject)<-[:CONTAINS_PROJECT]-(space)
        RETURN project.project_id AS project_id,
               relation.id AS relation_id,
               parent.project_id AS parent_project_id,
               relation.status AS status,
               coalesce(relation.decision_revision, 0) AS decision_revision
        ''',
        space_id=space_id,
        routing_='r',
    )
    projects = {record['project_id'] for record in records}
    relations = [
        PartOfRelation(
            id=record['relation_id'],
            child=record['project_id'],
            parent=record['parent_project_id'],
            status=record['status'] or 'pending',
            revision=int(record['decision_revision']),
        )
        for record in records
        if record['relation_id']
    ]
    return projects, relations


def _descendants(active: list[PartOfRelation], project_id: str) -> set[str]:
    children: dict[str, list[str]] = {}
    for relation in active:
        children.setdefault(relation.parent, []).append(relation.child)
    found: set[str] = set()
    pending = [project_id]
    while pending:
        for child in children.get(pending.pop(), []):
            if child not in found:
                found.add(child)
                pending.append(child)
    return found


def _refusal(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={'code': code, 'message': message})


# One transaction: the space is locked first so two moves cannot race into a
# cycle, then the same checks run again against the stored graph (the child's
# active parents are still the ones read, the new parent is not inside the
# child, the relation to activate is still at the revision read). A failed
# check writes nothing and returns no row.
_MOVE_PERSONAL_PROJECT_QUERY = '''
/* fuli:move-personal-project */
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
      [:CONTAINS_PROJECT]->(child:FuliPersonalProject {project_id: $project_id})
SET space.updated_at = $changed_at
WITH space, child
OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]->
      (parent:FuliPersonalProject {project_id: $parent_project_id})
WITH space, child, parent
WHERE ($parent_project_id IS NULL OR parent IS NOT NULL)
  AND NOT EXISTS {
    MATCH (parent)-[links:PERSONAL_PROJECT_RELATION*0..]->(child)
    WHERE all(link IN links WHERE link.relation_type = 'PART_OF' AND link.status = 'active')
  }
OPTIONAL MATCH (child)-
      [current:PERSONAL_PROJECT_RELATION {relation_type: 'PART_OF'}]->(:FuliPersonalProject)
WHERE current.status = 'active'
WITH space, child, parent, collect(current) AS currents
WHERE size(currents) = size($expected_active)
  AND all(link IN currents WHERE
    link.id + '@' + toString(coalesce(link.decision_revision, 0)) IN $expected_active)
OPTIONAL MATCH (child)-[existing:PERSONAL_PROJECT_RELATION {id: $attach.relation_id}]->(parent)
WITH space, child, parent, currents, existing
WHERE $attach IS NULL OR coalesce(existing.decision_revision, 0) = $attach.expected_revision
FOREACH (old IN [link IN currents WHERE link.id IN $retire_ids] |
  SET old.status = 'rejected',
      old.confirmation_authority = null,
      old.decision_revision = $retire_revisions[old.id],
      old.reviewed_by = $reviewed_by,
      old.reviewed_at = $changed_at,
      old.review_reason = $reason,
      old.updated_at = $changed_at
  CREATE (review:FuliPersonalProjectRelationReview {
    id: $retire_review_ids[old.id],
    space_id: $space_id,
    relation_id: old.id,
    decision_revision: $retire_revisions[old.id],
    decision: 'rejected',
    confirmation_authority: 'human_review',
    reason: $reason,
    reviewed_by: $reviewed_by,
    reviewed_at: $changed_at
  })
  MERGE (space)-[:HAS_PERSONAL_PROJECT_RELATION_REVIEW]->(review)
)
FOREACH (_ IN CASE WHEN $attach IS NULL THEN [] ELSE [1] END |
  MERGE (child)-[relation:PERSONAL_PROJECT_RELATION {
    id: $attach.relation_id,
    relation_type: 'PART_OF'
  }]->(parent)
  ON CREATE SET relation.created_at = $changed_at,
                relation.created_by = $reviewed_by
  SET relation.status = 'active',
      relation.confirmation_authority = 'human_review',
      relation.decision_revision = $attach.next_revision,
      relation.reviewed_by = $reviewed_by,
      relation.reviewed_at = $changed_at,
      relation.review_reason = $reason,
      relation.updated_at = $changed_at
  CREATE (review:FuliPersonalProjectRelationReview {
    id: $attach.review_id,
    space_id: $space_id,
    relation_id: $attach.relation_id,
    decision_revision: $attach.next_revision,
    decision: 'active',
    confirmation_authority: 'human_review',
    reason: $reason,
    reviewed_by: $reviewed_by,
    reviewed_at: $changed_at
  })
  MERGE (space)-[:HAS_PERSONAL_PROJECT_RELATION_REVIEW]->(review)
)
RETURN child.project_id AS project_id
'''
