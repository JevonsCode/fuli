"""Explicit transaction scope for query-only Store operations.

The scoped Store owns a private driver port. Never replace the shared runtime's
driver: simultaneous HTTP requests must not borrow one another's transactions.
"""

from contextlib import asynccontextmanager
from copy import copy
from types import SimpleNamespace


@asynccontextmanager
async def query_store_transaction(store):
    async with store.runtime.driver.transaction() as transaction:
        scoped = copy(store)
        # Query-only workflows intentionally have no raw Graphiti escape hatch.
        scoped.runtime = SimpleNamespace(driver=TransactionQueryDriver(transaction))
        yield scoped


class TransactionQueryDriver:
    """Adapt the Store execute_query port to one already-open transaction."""

    def __init__(self, transaction):
        self._transaction = transaction

    async def execute_query(self, query, **kwargs):
        parameters = dict(kwargs.pop('params', None) or {})
        # The transaction already owns its session/routing. Reads must observe
        # its uncommitted writes instead of opening an independent read session.
        kwargs.pop('routing_', None)
        parameters.update(kwargs)
        result = await self._transaction.run(query, **parameters)
        records = [record async for record in result]
        return records, None, list(records[0].keys()) if records else []

    @asynccontextmanager
    async def transaction(self):
        # Nested query-only operations join the owner; only it commits/rolls back.
        yield self._transaction
