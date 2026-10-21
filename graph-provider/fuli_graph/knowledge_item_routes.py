"""HTTP routes of one knowledge item's authoritative view, a turn's receipt and
the scope quick edit (rec#20), and everything one session recorded (rec#5 C6).
Reads are POST queries like the other Provider queries; the scope write names
its expected version and reason."""

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
from .session_records import read_session_records
from .session_records_models import SessionRecords, SessionRecordsRead


def register_knowledge_item_routes(application, store, Actor: Any) -> None:
    @application.post('/v1/knowledge/item-views', response_model=KnowledgeItemView)
    async def item_view(request: KnowledgeItemRef, actor: Actor):
        return await read_knowledge_item_view(store, actor, request)

    @application.post('/v1/knowledge/turn-receipts', response_model=KnowledgeTurnReceipt)
    async def turn_receipt(request: KnowledgeTurnReceiptRead, actor: Actor):
        return await read_turn_receipt(store, actor, request)

    @application.post('/v1/knowledge/items/{item_id}/scope')
    async def item_scope(item_id: str, request: KnowledgeScopeChange, actor: Actor):
        return await change_knowledge_scope(store, actor, item_id, request)

    @application.post('/v1/session-records', response_model=SessionRecords)
    async def session_records(request: SessionRecordsRead, actor: Actor):
        return await read_session_records(store, actor, request)
