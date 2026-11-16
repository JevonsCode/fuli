"""Which items the statement's "learned" numbers count (复利账单的明细), for the person's console.

For one personal space and one window: the items captured in it and the ones
the person confirmed in it, the latest first. The definitions are the weekly
statement's own (`item_facts`, a new version left out as there), so a list
names exactly the items its number counts. Ids, kinds and times only: the
console reads each item's text itself, through the item view. The list names
every FLA's items, so it is read only with the human-review proof.
"""
import asyncio
from datetime import datetime
from typing import Literal

from fastapi import HTTPException
from pydantic import Field, model_validator

from .knowledge_item_view import personal_reader_space
from .knowledge_statement import BASIS_FRAGMENTS, _INSTANT, item_facts
from .model_base import StrictModel
from .provider_values import native_datetime

MAX_LISTED = 200


class KnowledgeStatementItemsRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    since: datetime
    until: datetime
    # How many of each list are named; `total` still counts them all.
    limit: int = Field(default=50, ge=1, le=MAX_LISTED)

    @model_validator(mode='after')
    def validate_window(self):
        if self.since.tzinfo is None or self.until.tzinfo is None:
            raise ValueError('statement times need a time zone')
        if self.since >= self.until:
            raise ValueError('since must be before until')
        return self


class StatementItemRef(StrictModel):
    item_kind: Literal['entity', 'relationship']
    item_id: str
    # When it was captured, or when the person confirmed it.
    at: datetime


class StatementItemList(StrictModel):
    total: int
    items: list[StatementItemRef]


class KnowledgeStatementItems(StrictModel):
    captured: StatementItemList
    confirmed_by_you: StatementItemList


def listed_items_query(item_kind: str) -> str:
    """The statement's `captured` and `confirmed_by_you`, as [id, time] rows instead of counts."""
    return item_facts(item_kind) + '''
        WITH collect(item.fuli_replaced_by_item_id) AS versions,
             collect(CASE WHEN created_at >= $since AND created_at < $until
                          THEN [item.uuid, created_at] END) AS created,
             collect(CASE WHEN confirmer = 'you' AND confirmed_at >= $since AND confirmed_at < $until
                          THEN [item.uuid, confirmed_at] END) AS confirmed
        RETURN [row IN created WHERE NOT row[0] IN versions] AS captured,
               [row IN confirmed WHERE NOT row[0] IN versions] AS confirmed_by_you
        '''


async def knowledge_statement_items(store, space, request: KnowledgeStatementItemsRequest) -> KnowledgeStatementItems:
    async def one(item_kind):
        records, _, _ = await store.runtime.driver.execute_query(
            listed_items_query(item_kind), group_id=space['group_id'], since=request.since, until=request.until,
            instant=_INSTANT, routing_='r', **BASIS_FRAGMENTS)
        return dict(records[0]) if records else {}

    parts = dict(zip(('entity', 'relationship'), await asyncio.gather(one('entity'), one('relationship'))))

    def listed(field):
        rows = sorted(((native_datetime(at), item_id, item_kind) for item_kind, part in parts.items()
                       for item_id, at in part.get(field) or []), reverse=True)
        return StatementItemList(total=len(rows), items=[
            StatementItemRef(item_kind=item_kind, item_id=item_id, at=at) for at, item_id, item_kind in rows[:request.limit]])

    return KnowledgeStatementItems(captured=listed('captured'), confirmed_by_you=listed('confirmed_by_you'))


def register_knowledge_statement_items_route(application, store, ReviewAwareActor) -> None:
    @application.post('/v1/knowledge/statement/items', response_model=KnowledgeStatementItems)
    async def read_knowledge_statement_items(request: KnowledgeStatementItemsRequest, actor: ReviewAwareActor):
        if actor.get('_human_review_verified') is not True:
            raise HTTPException(status_code=403, detail='independent human review proof required')
        space = await personal_reader_space(store, actor, request.personal_space_id)
        return await knowledge_statement_items(store, space, request)
