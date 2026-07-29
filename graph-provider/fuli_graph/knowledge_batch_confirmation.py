import json
from datetime import datetime, timezone

from fastapi import HTTPException

from .knowledge_audit import record_human_change
from .knowledge_management import _read_item, _snapshot
from .models import (
    ConfirmationBasis,
    KnowledgeBatchConfirmationCreate,
    KnowledgeBatchConfirmationResult,
)
from .provider_values import stable_uuid as _stable_uuid


async def confirm_knowledge_batch(
    store,
    actor: dict,
    request: KnowledgeBatchConfirmationCreate,
) -> KnowledgeBatchConfirmationResult:
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(
            status_code=422,
            detail='knowledge batch confirmation is personal-only',
        )

    confirmed_at = datetime.now(timezone.utc)
    rows = []
    for item in request.items:
        current = await _read_item(store, space, item.item_id, item.item_kind)
        if current is None:
            raise HTTPException(status_code=404, detail='knowledge item not found')
        previous = _snapshot(current, item.item_kind)
        if previous.get('invalidAt'):
            raise HTTPException(
                status_code=409,
                detail='historical knowledge cannot be batch confirmed',
            )
        if (
            previous.get('confirmationStateExplicit')
            and previous.get('confirmationStatus') == 'confirmed'
        ):
            raise HTTPException(
                status_code=409,
                detail='confirmed knowledge cannot be batch confirmed again',
            )

        basis = ConfirmationBasis(
            existence_reason=item.existence_reason,
            quadrant_reason=item.quadrant_reason,
            proposed_by=item.proposed_by,
            confirmed_by=request.confirmer,
            confirmed_at=confirmed_at,
        ).model_dump(mode='json')
        next_value = {
            **previous,
            'epistemicStatus': 'confirmed',
            'confirmationStatus': 'confirmed',
            'confirmationStateExplicit': True,
            'confirmationBasis': basis,
        }
        revision_id = _stable_uuid(
            space['id'],
            'knowledge-revision',
            'batch-confirm',
            item.item_kind,
            item.item_id,
            confirmed_at.isoformat(),
            actor['id'],
        )
        rows.append({
            'item_id': item.item_id,
            'item_kind': item.item_kind,
            'expected_name': previous.get('name'),
            'expected_summary': previous.get('summary') or '',
            'expected_fact': previous.get('fact'),
            'expected_origin_quadrant': previous.get('originQuadrant'),
            'confirmation_basis_json': json.dumps(
                basis,
                ensure_ascii=False,
                sort_keys=True,
            ),
            'revision_id': revision_id,
            'previous_json': json.dumps(
                previous,
                ensure_ascii=False,
                sort_keys=True,
            ),
            'current_json': json.dumps(
                next_value,
                ensure_ascii=False,
                sort_keys=True,
            ),
        })

    records, _, _ = await store.runtime.driver.execute_query(
        _BATCH_CONFIRM_QUERY,
        space_id=space['id'],
        group_id=space['group_id'],
        group_kind=request.group_kind,
        group_value=request.group_value,
        items=rows,
        reason=request.reason,
        created_by=actor['id'],
        confirmed_at=confirmed_at,
    )
    if not records:
        raise HTTPException(
            status_code=409,
            detail=(
                'batch confirmation changed before it could be saved; '
                'refresh and review the group again'
            ),
        )
    confirmed_count = int(records[0]['confirmed_count'])
    if confirmed_count != len(rows):
        raise HTTPException(
            status_code=409,
            detail='batch confirmation did not update every selected item',
        )
    if request.operation_actor == 'human':
        for item in request.items:
            await record_human_change(
                store,
                actor,
                space,
                item.item_id,
                item.item_kind,
                reason=request.reason,
                operation='batch_confirmation',
            )
    return KnowledgeBatchConfirmationResult(
        group_kind=request.group_kind,
        group_value=request.group_value,
        confirmed_count=confirmed_count,
        confirmed_at=confirmed_at,
        item_keys=[
            f'{item.item_kind}:{item.item_id}'
            for item in request.items
        ],
    )


_BATCH_CONFIRM_QUERY = '''
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
WITH space, $items AS items
CALL {
  WITH items
  UNWIND [row IN items WHERE row.item_kind = 'entity'] AS row
  OPTIONAL MATCH (item:Entity {
    uuid: row.item_id,
    group_id: $group_id
  })
  WITH row, item
  WHERE item IS NOT NULL
    AND item.fuli_invalid_at IS NULL
    AND item.fuli_origin_quadrant IS NOT NULL
    AND coalesce(item.fuli_confirmation_status, 'pending') = 'pending'
    AND item.name = row.expected_name
    AND coalesce(item.summary, '') = row.expected_summary
    AND item.fuli_origin_quadrant = row.expected_origin_quadrant
    AND EXISTS {
      MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(item)
      WHERE ($group_kind = 'source' AND episode.uuid = $group_value)
         OR ($group_kind = 'session'
             AND episode.fuli_session_id = $group_value)
    }
  RETURN collect({item: item, row: row}) AS valid_entities
}
CALL {
  WITH items
  UNWIND [row IN items WHERE row.item_kind = 'relationship'] AS row
  OPTIONAL MATCH ()-[item:RELATES_TO {
    uuid: row.item_id,
    group_id: $group_id
  }]->()
  WITH row, item
  WHERE item IS NOT NULL
    AND item.invalid_at IS NULL
    AND item.fuli_origin_quadrant IS NOT NULL
    AND coalesce(item.fuli_confirmation_status, 'pending') = 'pending'
    AND item.fact = row.expected_fact
    AND item.fuli_origin_quadrant = row.expected_origin_quadrant
    AND EXISTS {
      MATCH (episode:Episodic {group_id: $group_id})
      WHERE episode.uuid IN coalesce(item.episodes, [])
        AND (
          ($group_kind = 'source' AND episode.uuid = $group_value)
          OR ($group_kind = 'session'
              AND episode.fuli_session_id = $group_value)
        )
    }
  RETURN collect({item: item, row: row}) AS valid_relationships
}
WITH space, items, valid_entities, valid_relationships,
     size(valid_entities) + size(valid_relationships) AS valid_count
WHERE valid_count = size(items)
CALL {
  WITH space, valid_entities
  UNWIND valid_entities AS valid
  WITH space, valid.item AS item, valid.row AS row
  SET item.fuli_epistemic_status = 'confirmed',
      item.fuli_confirmation_status = 'confirmed',
      item.fuli_confirmation_basis_json = row.confirmation_basis_json
  CREATE (revision:FuliKnowledgeRevision {
    id: row.revision_id,
    space_id: $space_id,
    item_id: row.item_id,
    item_kind: row.item_kind,
    action: 'batch_confirm',
    reason: $reason,
    previous_json: row.previous_json,
    current_json: row.current_json,
    created_by: $created_by,
    created_at: $confirmed_at
  })
  MERGE (space)-[:HAS_KNOWLEDGE_REVISION]->(revision)
  RETURN count(*) AS entity_count
}
CALL {
  WITH space, valid_relationships
  UNWIND valid_relationships AS valid
  WITH space, valid.item AS item, valid.row AS row
  SET item.fuli_epistemic_status = 'confirmed',
      item.fuli_confirmation_status = 'confirmed',
      item.fuli_confirmation_basis_json = row.confirmation_basis_json
  CREATE (revision:FuliKnowledgeRevision {
    id: row.revision_id,
    space_id: $space_id,
    item_id: row.item_id,
    item_kind: row.item_kind,
    action: 'batch_confirm',
    reason: $reason,
    previous_json: row.previous_json,
    current_json: row.current_json,
    created_by: $created_by,
    created_at: $confirmed_at
  })
  MERGE (space)-[:HAS_KNOWLEDGE_REVISION]->(revision)
  RETURN count(*) AS relationship_count
}
RETURN valid_count,
       entity_count + relationship_count AS confirmed_count
'''
