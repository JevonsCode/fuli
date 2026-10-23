"""Read-only integrity of a previously observed set of knowledge identities.

A caller supplies its earlier inventory, not bodies. Audited hard deletes are
legitimate absence; unexplained loss is reported, never automatically restored.
The current graph alone cannot prove that an unreferenced item once existed.
"""
from typing import Literal

from pydantic import Field, ValidationError

from .knowledge_item_view import personal_reader_space
from .knowledge_hard_delete_models import HardDeleteTargetKind
from .model_base import StrictModel
from .knowledge_source_tasks import task_shell_is_body_free
from .project_agent_memory_models import ProjectAgentMemoryRecord
from .provider_values import json_object


class KnowledgeIntegrityRef(StrictModel):
    kind: HardDeleteTargetKind
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
        OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_TASK_CONTEXT_SESSION]->
                       (:FuliTaskContextSession {id: ref.id})-[:HAS_CONTEXT]->(task:FuliTaskContext)
        WHERE ref.kind = 'session'
        WITH ref, entity IS NOT NULL OR edge IS NOT NULL OR episode IS NOT NULL AS present,
             collect(task) AS source_tasks
        OPTIONAL MATCH (trace:FuliKnowledgeAudit {space_id: $space_id, action: 'hard_delete'})
        WHERE (ref.kind = 'episode' AND ref.id IN coalesce(trace.removed_episode_ids, []))
           OR (ref.kind + ':' + ref.id) IN coalesce(trace.deleted_item_keys, [])
        RETURN ref.kind AS kind, ref.id AS id, present, collect(DISTINCT trace.id) AS deletion_ids,
               null AS source_application, null AS session_id, source_tasks, null AS memory_checkpoint
        UNION ALL
        MATCH (episode:Episodic {group_id: $group_id})
        WHERE $has_sessions AND episode.fuli_source_application IS NOT NULL
          AND episode.fuli_session_id IS NOT NULL
        RETURN DISTINCT 'session_source' AS kind, null AS id, false AS present, [] AS deletion_ids,
               episode.fuli_source_application AS source_application, episode.fuli_session_id AS session_id,
               [] AS source_tasks, null AS memory_checkpoint
        UNION ALL
        MATCH (:FuliProjectAgentMemory {personal_space_id: $space_id})-[:HAS_MEMORY_CHECKPOINT]->
              (checkpoint:FuliProjectAgentMemoryCheckpoint)
        WHERE $has_sessions
        OPTIONAL MATCH (trace:FuliKnowledgeAudit {space_id: $space_id, action: 'hard_delete', id: checkpoint.scrubbed_by})
        RETURN 'session_memory' AS kind, null AS id, false AS present, [] AS deletion_ids,
               trace.source_application AS source_application, trace.fuli_session_id AS session_id,
               [] AS source_tasks, checkpoint AS memory_checkpoint
        ''', references=list(references.values()), group_id=space['group_id'], space_id=space['id'],
        has_sessions=any(kind == 'session' for kind, _ in references), routing_='r')
    # Episode-only and memory-only sessions need no task-session node. Resolve
    # their identities in the same query as tombstones. Memory bodies stay
    # internal: a marker alone cannot prove that restored text is absent.
    source_sessions = _source_sessions(store, space, records)
    missing, resurrected, deletions = [], [], set()
    present_count = deleted_count = 0
    for row in records:
        if row['kind'] in ('session_source', 'session_memory'):
            continue
        ref = KnowledgeIntegrityRef(kind=row['kind'], id=row['id'])
        present = (row['present'] or (ref.kind == 'session' and ref.id in source_sessions)
                   or any(not task_shell_is_body_free(dict(task)) for task in row.get('source_tasks', [])))
        if row['deletion_ids']:
            deletions.update(row['deletion_ids'])
            deleted_count += 1
            if present:
                resurrected.append(ref)
        elif present:
            present_count += 1
        else:
            missing.append(ref)
    return KnowledgeIntegrityReport(
        status='attention_required' if missing or resurrected else 'healthy',
        expected_count=len(references), present_count=present_count, hard_deleted_count=deleted_count,
        missing_count=len(missing), missing=missing, resurrected=resurrected, deletion_ids=sorted(deletions))


def _source_sessions(store, space, records):
    identities = []
    for row in records:
        if row['kind'] == 'session_source':
            identities.append((row['source_application'], row['session_id']))
        elif row['kind'] == 'session_memory':
            checkpoint = dict(row['memory_checkpoint'])
            record = json_object(checkpoint.get('record_json'))
            if _memory_is_body_free(checkpoint, space['id']):
                continue
            if record.get('personal_space_id') == space['id']:
                identities.append((record.get('source_application'), record.get('source_session_id')))
            # Scrubbing removes the source tuple. The existing deletion receipt
            # remains the identity proof when only a body was restored later.
            identities.append((row.get('source_application'), row.get('session_id')))
    return {store._task_session_id(space['id'], application, session)
            for application, session in identities
            if isinstance(application, str) and application and isinstance(session, str) and session}


def _memory_is_body_free(checkpoint, space_id):
    if checkpoint.get('memory_state') != 'scrubbed' or checkpoint.get('payload_hash') is not None:
        return False
    try:
        record = ProjectAgentMemoryRecord.model_validate_json(checkpoint['record_json'])
    except (KeyError, TypeError, ValidationError):
        return False
    return (record.memory_state == 'scrubbed' and record.scrubbed_by == checkpoint.get('scrubbed_by')
            and record.checkpoint_id == checkpoint.get('id') and record.revision == checkpoint.get('revision')
            and record.personal_space_id == space_id)
