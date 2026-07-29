from .models import (
    KnowledgeAssignmentRecord,
    KnowledgeConflictRecord,
    KnowledgeProjectReferenceRecord,
    KnowledgeRevisionRecord,
)
from .provider_values import json_object, native_datetime


def revision_record(value: dict) -> KnowledgeRevisionRecord:
    return KnowledgeRevisionRecord(
        id=value['id'],
        item_id=value['item_id'],
        item_kind=value['item_kind'],
        action=value['action'],
        reason=value['reason'],
        previous=json_object(value.get('previous_json')),
        current=json_object(value.get('current_json')),
        created_at=native_datetime(value['created_at']),
    )


def assignment_record(value: dict) -> KnowledgeAssignmentRecord:
    return KnowledgeAssignmentRecord(
        id=value['id'],
        item_id=value['item_id'],
        item_kind=value['item_kind'],
        project_id=value['project_id'],
        previous_project_id=value.get('previous_project_id'),
        reason=value.get('reason') or '调整项目归属',
        created_at=native_datetime(value['created_at']),
        updated_at=native_datetime(value['updated_at']),
    )


def reference_record(value: dict) -> KnowledgeProjectReferenceRecord:
    return KnowledgeProjectReferenceRecord(
        id=value['id'],
        item_id=value['item_id'],
        item_kind=value['item_kind'],
        project_id=value['project_id'],
        source_project_id=value.get('source_project_id'),
        status=value['status'],
        matched_item_id=value.get('matched_item_id'),
        reason=value.get('reason') or '加入项目',
        created_at=native_datetime(value['created_at']),
        updated_at=native_datetime(value['updated_at']),
    )


def conflict_record(value: dict) -> KnowledgeConflictRecord:
    return KnowledgeConflictRecord(
        id=value['id'],
        item_id=value['item_id'],
        target_item_id=value['target_item_id'],
        source_project_id=value.get('source_project_id'),
        target_project_id=value['target_project_id'],
        status=value['status'],
        resolution=value.get('resolution') or 'defer',
        reason=value.get('reason') or '跨项目知识冲突',
        created_at=native_datetime(value['created_at']),
        updated_at=native_datetime(value['updated_at']),
    )
