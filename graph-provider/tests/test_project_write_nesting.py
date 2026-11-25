"""Nested writes stay within their transaction's admission, and no process lock
is waited for inside an open Neo4j transaction (synthetic gates, no graph)."""
import asyncio
from contextlib import closing
from hashlib import sha256
from types import SimpleNamespace
import sqlite3

from fastapi import HTTPException
import pytest

from fuli_graph.knowledge_group_lock import group_lock
from fuli_graph.project_write_gate import DERIVED, effects_compared, project_targets, write_admission
from fuli_graph.replica_write_guard import ReplicaWriteGuard
from fuli_graph.store_transactions import TransactionQueryDriver, classifying_copies

SPACE = 'synthetic-space'


def gates(root, rows):
    directory = root / sha256(SPACE.encode()).hexdigest()
    directory.mkdir(exist_ok=True)
    for file, records in [('index.sqlite', rows), *[(sha256(row[0].encode()).hexdigest() + '.sqlite', [row])
                                                     for row in rows]]:
        with closing(sqlite3.connect(directory / file)) as db, db:
            db.execute('PRAGMA user_version=1')
            db.execute('CREATE TABLE IF NOT EXISTS gates(project TEXT PRIMARY KEY,role,generation,state,move_id)')
            db.execute('DELETE FROM gates')
            db.executemany('INSERT INTO gates VALUES(?,?,?,?,?)', records)
    return SimpleNamespace(project_gate_directory=root, project_gate_space=SPACE)


def code(error):
    return error.value.detail['code']


@pytest.mark.asyncio
async def test_two_local_projects_write_beside_a_copy_and_nested_writes_stay_inside(tmp_path):
    settings = gates(tmp_path, [('local', 'owner', 1, 'open', None), ('second', 'owner', 1, 'open', None),
                                ('copy', 'replica', 1, 'open', None)])
    enter = write_admission(settings)
    for project in ('local', 'second'):
        with project_targets(SPACE, [project]):
            async with enter():
                with project_targets(SPACE, [project]), project_targets(SPACE, []):
                    pass
                # Nothing can be taken once the transaction is open.
                with pytest.raises(HTTPException) as outside:
                    with project_targets(SPACE, ['copy']):
                        pass
                assert code(outside) == 'project_scope_changed'
                # The entry is the first Provider module outside the gates (None from a test).
                assert 'entry' in outside.value.detail
    with project_targets(SPACE, ['copy']), pytest.raises(HTTPException) as copied:
        async with enter():
            pytest.fail('a write of the copy was admitted')
    assert code(copied) == 'project_write_blocked'
    # An unresolved write is still refused, and says where it came from.
    with pytest.raises(HTTPException) as unresolved:
        async with enter():
            pytest.fail('an unresolved write was admitted beside a copy')
    assert code(unresolved) == 'project_write_requires_owner_scope'
    assert 'entry' in unresolved.value.detail
    # A maintenance comparison checks what is nested in it.
    with project_targets(SPACE, []):
        async with enter():
            with effects_compared(SPACE), project_targets(SPACE, ['copy']):
                pass


@pytest.mark.asyncio
async def test_derived_writes_reach_copies_but_wait_for_no_frozen_project(tmp_path):
    rows = [('local', 'owner', 1, 'open', None), ('copy', 'replica', 1, 'open', None)]
    enter = write_admission(gates(tmp_path, rows))
    with project_targets(SPACE, [], kind=DERIVED):
        async with enter():
            with project_targets(SPACE, [], kind=DERIVED):
                pass
            with pytest.raises(HTTPException) as business:
                with project_targets(SPACE, ['local']):
                    pass
            assert code(business) == 'project_scope_changed'
    enter = write_admission(gates(tmp_path, [('local', 'owner', 1, 'closed', 'move'), rows[1]]))
    with project_targets(SPACE, [], kind=DERIVED), pytest.raises(HTTPException) as frozen:
        async with enter():
            pytest.fail('a vector was written during a move')
    assert code(frozen) == 'project_scope_unknown'


class _Transaction:
    async def run(self, query, **parameters):
        raise AssertionError('no query is expected')


@pytest.mark.asyncio
async def test_an_open_transaction_never_waits_for_the_classification_or_group_lock():
    guard = ReplicaWriteGuard(False)
    inside = SimpleNamespace(runtime=SimpleNamespace(driver=TransactionQueryDriver(_Transaction(), guard)),
                             _group_locks={})
    outside = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(replica_guard=guard)),
                              _group_locks=inside._group_locks)
    held, release = asyncio.Event(), asyncio.Event()

    async def capture():
        async with group_lock(outside, 'group'), classifying_copies(outside):
            held.set()
            await release.wait()

    task = asyncio.create_task(capture())
    await held.wait()
    for lock, busy in ((lambda: group_lock(inside, 'group'), 'knowledge_writes_busy'),
                       (lambda: classifying_copies(inside), 'project_writes_busy')):
        with pytest.raises(HTTPException) as refused:
            async with asyncio.timeout(1):
                async with lock():
                    pytest.fail('took a lock another writer holds')
        assert code(refused) == busy
    release.set()
    await task
    # Free, they are taken at once; the task that holds them may enter again.
    async with group_lock(inside, 'group'), classifying_copies(inside):
        async with group_lock(inside, 'group'), classifying_copies(outside):
            pass
