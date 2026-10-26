"""Zero-content deletion watermark for each process's recovery gate (D-31.B5).

An ordinary authorized reader can compare this aggregate with its local proof.
Deletion IDs, item identities and audit records stay on the human-review channel.
"""
from datetime import datetime
from typing import Any

from pydantic import Field

from .knowledge_item_view import personal_reader_space
from .model_base import StrictModel
from .provider_values import native_datetime


class KnowledgeDeletionWatermarkRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)


class KnowledgeDeletionWatermark(StrictModel):
    count: int = Field(ge=0)
    latest_deleted_at: datetime | None


def register_knowledge_deletion_watermark_route(application, store, Actor: Any) -> None:
    @application.post('/v1/knowledge/hard-deletions/watermark', response_model=KnowledgeDeletionWatermark)
    async def deletion_watermark(request: KnowledgeDeletionWatermarkRequest, actor: Actor):
        space = await personal_reader_space(store, actor, request.personal_space_id)
        records, _, _ = await store.runtime.driver.execute_query(
            '''
            MATCH (trace:FuliKnowledgeAudit {space_id: $space_id, action: 'hard_delete'})
            RETURN count(trace) AS count, max(trace.created_at) AS latest_deleted_at
            ''', space_id=space['id'], routing_='r')
        aggregate = records[0]
        return KnowledgeDeletionWatermark(
            count=aggregate['count'], latest_deleted_at=native_datetime(aggregate['latest_deleted_at']))
