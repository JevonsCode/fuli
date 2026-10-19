"""A scripted driver port: each query returns the next prepared rows.

Transactions run their statements through the same script, so a test can
drive production code that wraps writes in query_store_transaction.
"""

from contextlib import asynccontextmanager


class SequentialDriver:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return next(self.responses), None, None

    @asynccontextmanager
    async def transaction(self):
        yield SequentialTransaction(self)


class SequentialTransaction:
    def __init__(self, driver):
        self.driver = driver

    async def run(self, query, **parameters):
        records, _, _ = await self.driver.execute_query(query, **parameters)
        return AsyncRows(records)


class AsyncRows:
    """The async-iterable result shape of a Neo4j transaction run."""

    def __init__(self, records):
        self.records = iter(records)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self.records)
        except StopIteration:
            raise StopAsyncIteration from None
