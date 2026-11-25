"""Explicit transaction scope for query-only Store operations.

The scoped Store owns a private driver port. Never replace the shared runtime's
driver: simultaneous HTTP requests must not borrow one another's transactions.
"""

from contextlib import asynccontextmanager, nullcontext
from copy import copy
from types import SimpleNamespace


@asynccontextmanager
async def query_store_transaction(store):
    async with store.runtime.driver.transaction() as transaction:
        scoped = copy(store)
        # Query-only workflows intentionally have no raw Graphiti escape hatch.
        scoped.runtime = SimpleNamespace(driver=TransactionQueryDriver(
            transaction, getattr(store.runtime.driver, 'replica_guard', None)))
        yield scoped


class TransactionQueryDriver:
    """Adapt the Store execute_query port to one already-open transaction."""

    def __init__(self, transaction, replica_guard=None):
        self._transaction = transaction
        # Whose read-only copies this graph holds (replica_write_guard.py), for a refusal to name.
        self.replica_guard = replica_guard

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

    # A nested gate reads what it decides on in the owner's transaction, its
    # own uncommitted writes included.
    read_transaction = transaction


def joins_transaction(store) -> bool:
    """True when the store's writes join a transaction that is already open."""
    return isinstance(store.runtime.driver, TransactionQueryDriver)


def classifying_copies(store):
    """The replica guard's classification lock, in the one order every writer
    takes it: before its Neo4j transaction opens. Inside an open transaction
    it is only taken when free, never waited for (replica_write_guard.py)."""
    driver = store.runtime.driver
    guard = getattr(driver, 'replica_guard', None)
    if guard is None:
        return nullcontext()
    return guard.classifying_copies(inside_transaction=joins_transaction(store))
