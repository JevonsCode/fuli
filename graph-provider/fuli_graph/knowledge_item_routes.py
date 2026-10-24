"""HTTP routes of one knowledge item's authoritative view, a turn's receipt,
the scope quick edit and a session's batch migration into a formal project
(rec#20), and everything one session recorded (rec#5 C6). Reads are POST
queries like the other Provider queries; every scope write names its expected
version and reason. A scope write is audited as the person's own change, so
it takes the human-review channel the local console holds (as a hard delete
does); an Agent's access token alone is refused (rec#11 D-22, dot P1-1).
An item view, a receipt, a session's records and its migration preview are
read in full only with that proof; without it the reader is an Agent and sees
no other FLA's knowledge, and a wrong proof is refused (knowledge_visibility)."""

from typing import Any

from .knowledge_item_view import read_knowledge_item_view, read_turn_receipt
from .knowledge_item_view_models import (
    KnowledgeItemRef,
    KnowledgeItemView,
    KnowledgeScopeChange,
    KnowledgeTurnReceipt,
    KnowledgeTurnReceiptRead,
)
from .knowledge_scope_edit import change_knowledge_scope
from .knowledge_session_migration import apply_session_migration, preview_session_migration
from .knowledge_session_migration_models import (
    SessionMigrationApply,
    SessionMigrationPreview,
    SessionMigrationRead,
    SessionMigrationResult,
)
from .session_records import read_session_records
from .session_records_models import SessionRecords, SessionRecordsRead


def register_knowledge_item_routes(application, store, Actor: Any, ReviewAwareActor: Any,
                                   HumanReviewer: Any) -> None:
    @application.post('/v1/knowledge/item-views', response_model=KnowledgeItemView)
    async def item_view(request: KnowledgeItemRef, actor: ReviewAwareActor):
        return await read_knowledge_item_view(store, actor, request)

    @application.post('/v1/knowledge/turn-receipts', response_model=KnowledgeTurnReceipt)
    async def turn_receipt(request: KnowledgeTurnReceiptRead, actor: ReviewAwareActor):
        return await read_turn_receipt(store, actor, request)

    @application.post('/v1/knowledge/items/{item_id}/scope')
    async def item_scope(item_id: str, request: KnowledgeScopeChange, actor: HumanReviewer):
        return await change_knowledge_scope(store, actor, item_id, request)

    @application.post('/v1/knowledge/session-migrations/preview', response_model=SessionMigrationPreview)
    async def session_migration_preview(request: SessionMigrationRead, actor: ReviewAwareActor):
        return await preview_session_migration(store, actor, request)

    @application.post('/v1/knowledge/session-migrations/apply', response_model=SessionMigrationResult)
    async def session_migration_apply(request: SessionMigrationApply, actor: HumanReviewer):
        return await apply_session_migration(store, actor, request)

    @application.post('/v1/session-records', response_model=SessionRecords)
    async def session_records(request: SessionRecordsRead, actor: ReviewAwareActor):
        return await read_session_records(store, actor, request)
