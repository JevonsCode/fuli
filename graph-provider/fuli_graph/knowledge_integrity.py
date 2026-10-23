"""Read-only integrity of a previously observed set of knowledge identities.

A caller supplies its earlier inventory, not bodies. Audited hard deletes are
legitimate absence; unexplained loss is reported, never automatically restored.
The current graph alone cannot prove that an unreferenced item once existed.
"""
from typing import Literal

from pydantic import Field

from .knowledge_item_view import personal_reader_space
from .model_base import StrictModel


class KnowledgeIntegrityRef(StrictModel):
    kind: Literal['entity', 'relationship', 'episode']
    id: str = Field(min_length=1, max_length=256)


class KnowledgeIntegrityRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    references: list[KnowledgeIntegrityRef] = Field(max_length=10000)


class KnowledgeIntegrityReport(StrictModel):
    status: Literal['healthy', 'attention_required']
    expected_count: int
    present_count: int
    hard_deleted_count: int
    missing_count: int
    missing: list[KnowledgeIntegrityRef]
    resurrected: list[KnowledgeIntegrityRef]
    deletion_ids: list[str]


async def check_knowledge_integrity(store, actor, request) -> KnowledgeIntegrityReport:
    space = await personal_reader_space(store, actor, request.personal_space_id)
    references = {(ref.kind, ref.id): ref.model_dump() for ref in request.references}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        UNWIND $references AS ref
        OPTIONAL MATCH (entity:Entity {group_id: $group_id, uuid: ref.id})
        WHERE ref.kind = 'entity'
        OPTIONAL MATCH ()-[edge:RELATES_TO {group_id: $group_id, uuid: ref.id}]->()
        WHERE ref.kind = 'relationship'
        OPTIONAL MATCH (episode:Episodic {group_id: $group_id, uuid: ref.id})
        WHERE ref.kind = 'episode'
        WITH ref, entity IS NOT NULL OR edge IS NOT NULL OR episode IS NOT NULL AS present
        OPTIONAL MATCH (trace:FuliKnowledgeAudit {space_id: $space_id, action: 'hard_delete'})
        WHERE (ref.kind = 'episode' AND ref.id IN coalesce(trace.removed_episode_ids, []))
           OR (ref.kind <> 'episode' AND (ref.kind + ':' + ref.id) IN coalesce(trace.deleted_item_keys, []))
        RETURN ref.kind AS kind, ref.id AS id, present, collect(DISTINCT trace.id) AS deletion_ids
        ''', references=list(references.values()), group_id=space['group_id'], space_id=space['id'], routing_='r')
    missing, resurrected, deletions = [], [], set()
    present_count = deleted_count = 0
    for row in records:
        ref = KnowledgeIntegrityRef(kind=row['kind'], id=row['id'])
        if row['deletion_ids']:
            deletions.update(row['deletion_ids'])
            deleted_count += 1
            if row['present']:
                resurrected.append(ref)
        elif row['present']:
            present_count += 1
        else:
            missing.append(ref)
    return KnowledgeIntegrityReport(
        status='attention_required' if missing or resurrected else 'healthy',
        expected_count=len(references), present_count=present_count, hard_deleted_count=deleted_count,
        missing_count=len(missing), missing=missing, resurrected=resurrected, deletion_ids=sorted(deletions))
