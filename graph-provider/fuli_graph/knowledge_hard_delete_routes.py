"""HTTP routes of a person's hard delete (rec#5 C9). Every one takes the
human-review channel: an Agent's access token alone is refused (403), so no
MCP or Agent tool can preview, delete, ask about or abort a delete."""

from typing import Any

from .knowledge_integrity import (
    KnowledgeIntegrityRequest, KnowledgeIntegrityReport, check_knowledge_integrity,
)

from .knowledge_hard_delete import (
    abort_hard_delete, apply_hard_delete, hard_delete_status, hard_deletions, preview_hard_delete,
    read_hard_delete_operation,
)
from .knowledge_hard_delete_models import (
    KnowledgeHardDeleteConfirm,
    KnowledgeHardDeleteOperation,
    KnowledgeHardDeletePreview,
    KnowledgeHardDeleteRecord,
    KnowledgeHardDeleteRef,
    KnowledgeHardDeleteSpace,
    KnowledgeHardDeleteStatus,
)


def register_knowledge_hard_delete_routes(application, store, HumanReviewer: Any) -> None:
    @application.post('/v1/knowledge/integrity', response_model=KnowledgeIntegrityReport)
    async def knowledge_integrity(request: KnowledgeIntegrityRequest, actor: HumanReviewer):
        return await check_knowledge_integrity(store, actor, request)

    @application.post('/v1/knowledge/items/{item_id}/hard-delete/preview',
                      response_model=KnowledgeHardDeletePreview)
    async def hard_delete_preview(item_id: str, request: KnowledgeHardDeleteRef, actor: HumanReviewer):
        return await preview_hard_delete(store, actor, item_id, request)

    @application.post('/v1/knowledge/items/{item_id}/hard-delete/status', response_model=KnowledgeHardDeleteStatus)
    async def hard_delete_state(item_id: str, request: KnowledgeHardDeleteRef, actor: HumanReviewer):
        return await hard_delete_status(store, actor, item_id, request)

    @application.post('/v1/knowledge/hard-delete-operations/{operation_id}',
                      response_model=KnowledgeHardDeleteOperation)
    async def hard_delete_operation(operation_id: str, request: KnowledgeHardDeleteSpace, actor: HumanReviewer):
        return await read_hard_delete_operation(store, actor, operation_id, request)

    @application.post('/v1/knowledge/hard-delete-operations/{operation_id}/abort',
                      response_model=KnowledgeHardDeleteOperation)
    async def hard_delete_abort(operation_id: str, request: KnowledgeHardDeleteSpace, actor: HumanReviewer):
        return await abort_hard_delete(store, actor, operation_id, request)

    @application.post('/v1/knowledge/hard-deletions', response_model=list[KnowledgeHardDeleteRecord])
    async def hard_deletion_list(request: KnowledgeHardDeleteSpace, actor: HumanReviewer):
        return await hard_deletions(store, actor, request)

    @application.post('/v1/knowledge/items/{item_id}/hard-delete', response_model=KnowledgeHardDeleteRecord)
    async def hard_delete(item_id: str, request: KnowledgeHardDeleteConfirm, actor: HumanReviewer):
        return await apply_hard_delete(store, actor, item_id, request)
