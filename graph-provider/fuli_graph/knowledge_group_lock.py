"""The Provider's per-group knowledge lock, held across a capture's reads and its commit.

Lock order: this lock, then the replica guard's classification lock, then
Neo4j's locks inside one transaction. A capture waits for the Neo4j knowledge
lock while it holds this one, so a writer whose transaction is already open
(a checkpoint recording its knowledge usage) never waits here: it either
holds the lock already, from before its transaction opened, or takes it free,
or is refused, to retry.
"""
import asyncio
from contextlib import asynccontextmanager

from fastapi import HTTPException

from .store_transactions import joins_transaction


class GroupLock:
    def __init__(self):
        self._lock = asyncio.Lock()
        self._task = None

    @asynccontextmanager
    async def held(self, *, inside_transaction=False):
        task = asyncio.current_task()
        if self._task is task:
            yield
            return
        if inside_transaction and self._lock.locked():
            raise HTTPException(409, detail={'code': 'knowledge_writes_busy',
                'message': 'Another capture holds this space; retry. 另一项记录正在写入这个空间，请重试。'})
        async with self._lock:
            self._task = task
            try:
                yield
            finally:
                self._task = None


def group_lock(store, group_id):
    lock = store._group_locks.setdefault(group_id, GroupLock())
    return lock.held(inside_transaction=joins_transaction(store))
