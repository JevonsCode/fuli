"""The graph's part of the compounding statement day by day (复利账单的日历).

For one personal space and a range of at most 371 days, per local day: the
items learned (captured) and confirmed, and the uses Agents reported. The
definitions are the weekly statement's own (`item_facts`, `USES_MATCH`); only
the grouping differs. Three aggregate queries run side by side, each grouped by
day in Cypher; no item text, id or vector leaves the Provider.

A day is the caller's local day: the range's own UTC offset (both ends carry
the same one) is added before the instant is cut into days, so an item
captured at 23:30 local time counts on that day, not the next.
"""
import asyncio
from datetime import date, datetime, timedelta

from pydantic import Field, model_validator

from .knowledge_item_view import personal_reader_space
from .knowledge_statement import BASIS_FRAGMENTS, COUNTED_CONFIRMERS, USES_MATCH, _INSTANT, item_facts
from .model_base import StrictModel

MAX_DAYS = 371
_DAY_MS = 24 * 60 * 60 * 1000
_EPOCH = date(1970, 1, 1)


def _local_day(instant: str) -> str:
    """The local day of a Neo4j datetime, as whole days since 1970-01-01."""
    return f'toInteger(floor(({instant}.epochMillis + $offset_ms) / {_DAY_MS}.0))'


class KnowledgeStatementDaysRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    since: datetime
    until: datetime

    @model_validator(mode='after')
    def validate_range(self):
        if self.since.tzinfo is None or self.until.tzinfo is None:
            raise ValueError('statement times need a time zone')
        if self.since.utcoffset() != self.until.utcoffset():
            raise ValueError('since and until must carry the same UTC offset')
        if self.since >= self.until:
            raise ValueError('since must be before until')
        if self.until - self.since > timedelta(days=MAX_DAYS):
            raise ValueError(f'since and until may be at most {MAX_DAYS} days apart')
        return self


class StatementDay(StrictModel):
    day: date
    learned: int
    confirmed: int
    used: int


class KnowledgeStatementDays(StrictModel):
    # Oldest first; a day with nothing to count is left out.
    days: list[StatementDay]


def item_days_query(item_kind: str) -> str:
    return item_facts(item_kind) + f'''
        WITH collect(item.fuli_replaced_by_item_id) AS versions,
             collect(CASE WHEN created_at >= $since AND created_at < $until
                          THEN [item.uuid, {_local_day('created_at')}] END) AS created,
             collect(CASE WHEN confirmer IN {COUNTED_CONFIRMERS}
                               AND confirmed_at >= $since AND confirmed_at < $until
                          THEN [item.uuid, {_local_day('confirmed_at')}] END) AS confirmations
        UNWIND [row IN created WHERE NOT row[0] IN versions | ['learned', row[1]]]
             + [row IN confirmations WHERE NOT row[0] IN versions | ['confirmed', row[1]]] AS event
        RETURN event[0] AS measure, event[1] AS day, count(*) AS count
        '''


USES_DAYS_QUERY = USES_MATCH + f'''
    WITH audit, {_local_day('audit.created_at')} AS day
    RETURN 'used' AS measure, day, count(audit) AS count
'''


async def knowledge_statement_days(store, space, request: KnowledgeStatementDaysRequest) -> KnowledgeStatementDays:
    offset_ms = int(request.since.utcoffset().total_seconds() * 1000)
    window = {'since': request.since, 'until': request.until, 'offset_ms': offset_ms, 'routing_': 'r'}

    async def rows(query, **values):
        records, _, _ = await store.runtime.driver.execute_query(query, **window, **values)
        return [dict(record) for record in records]

    item_values = {'group_id': space['group_id'], 'instant': _INSTANT, **BASIS_FRAGMENTS}
    parts = await asyncio.gather(
        rows(item_days_query('entity'), **item_values),
        rows(item_days_query('relationship'), **item_values),
        rows(USES_DAYS_QUERY, space_id=space['id']))
    days: dict[int, dict[str, int]] = {}
    for part in parts:
        for row in part:
            counts = days.setdefault(int(row['day']), {'learned': 0, 'confirmed': 0, 'used': 0})
            counts[row['measure']] += int(row['count'] or 0)
    return KnowledgeStatementDays(days=[
        StatementDay(day=_EPOCH + timedelta(days=number), **counts)
        for number, counts in sorted(days.items()) if any(counts.values())])


def register_knowledge_statement_days_route(application, store, Actor) -> None:
    @application.post('/v1/knowledge/statement/days', response_model=KnowledgeStatementDays)
    async def read_knowledge_statement_days(request: KnowledgeStatementDaysRequest, actor: Actor):
        space = await personal_reader_space(store, actor, request.personal_space_id)
        return await knowledge_statement_days(store, space, request)
