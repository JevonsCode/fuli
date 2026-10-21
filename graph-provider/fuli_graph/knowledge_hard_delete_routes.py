"""HTTP routes of a person's hard delete (rec#5 C9). Both take the
human-review channel: an Agent's access token alone is refused (403), so no
MCP or Agent tool can preview or delete, whatever it sends."""

from typing import Any

from .knowledge_hard_delete import apply_hard_delete, hard_delete_status, preview_hard_delete
from .knowledge_hard_delete_models import (
    KnowledgeHardDeleteConfirm,
    KnowledgeHardDeletePreview,
    KnowledgeHardDeleteRecord,
    KnowledgeHardDeleteRef,
    KnowledgeHardDeleteStatus,
)


def register_knowledge_hard_delete_routes(application, store, HumanReviewer: Any) -> None:
    @application.post('/v1/knowledge/items/{item_id}/hard-delete/preview',
                      response_model=KnowledgeHardDeletePreview)
    async def hard_delete_preview(item_id: str, request: KnowledgeHardDeleteRef, actor: HumanReviewer):
        return await preview_hard_delete(store, actor, item_id, request)

    @application.post('/v1/knowledge/items/{item_id}/hard-delete/status', response_model=KnowledgeHardDeleteStatus)
    async def hard_delete_state(item_id: str, request: KnowledgeHardDeleteRef, actor: HumanReviewer):
        return await hard_delete_status(store, actor, item_id, request)

    @application.post('/v1/knowledge/items/{item_id}/hard-delete', response_model=KnowledgeHardDeleteRecord)
    async def hard_delete(item_id: str, request: KnowledgeHardDeleteConfirm, actor: HumanReviewer):
        return await apply_hard_delete(store, actor, item_id, request)
