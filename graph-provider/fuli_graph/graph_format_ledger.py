"""The graph's applied-migration ledger (rec#17 D-09).

One FuliDataFormat node holds the graph's format version; every step the
format registry takes or declines is appended as a FuliDataFormatEvent with
its migration ID, source and target version, backup and status. Events are
never rewritten: a migration's state is its latest event.
"""

from dataclasses import dataclass

GRAPH_STORE = 'graph'
# Owned by the ledger itself, outside any migration's declared labels; the
# undo journal of a confirmed migration is part of it (graph_format_journal.py).
LEDGER_LABELS = frozenset({'FuliDataFormat', 'FuliDataFormatEvent', 'FuliDataFormatUndo'})
STATUSES = frozenset({
    'created',  # a fresh graph was built at the current version
    'baseline_detected',  # an unversioned graph already had this step in effect
    'started',  # an automatic step began; without a later status it was interrupted
    'applied',
    'pending_confirmation',  # needed, but changes records or failed a preflight
    'rolled_back',  # a confirmed step a person undid
})


@dataclass(frozen=True)
class GraphLedger:
    version: int | None
    # migration ID -> its latest status
    latest: dict[str, str]
    # migration ID -> the detail of its latest event
    details: dict[str, str]


async def read_graph_ledger(driver) -> GraphLedger:
    records, _, _ = await driver.execute_query(
        '''
        OPTIONAL MATCH (format:FuliDataFormat {store: $store})
        OPTIONAL MATCH (format)-[:HAS_FORMAT_EVENT]->(event:FuliDataFormatEvent)
        WITH format, event ORDER BY event.seq
        RETURN format.version AS version,
               [item IN collect(event) | [item.migration_id, item.status, item.detail]] AS events
        ''',
        store=GRAPH_STORE,
        routing_='r',
    )
    record = records[0] if records else {'version': None, 'events': []}
    latest, details = {}, {}
    for migration_id, status, detail in record['events']:
        latest[migration_id] = status
        details[migration_id] = detail
    version = record['version']
    return GraphLedger(int(version) if version is not None else None, latest, details)


async def read_graph_ledger_events(driver) -> list[dict]:
    """Every ledger event, oldest first: IDs, versions, statuses and counts."""
    records, _, _ = await driver.execute_query(
        '''
        MATCH (:FuliDataFormat {store: $store})-[:HAS_FORMAT_EVENT]->(event:FuliDataFormatEvent)
        RETURN event.migration_id AS migrationId, event.from_version AS fromVersion,
               event.to_version AS toVersion, event.status AS status,
               event.backup_ref AS backupRef, event.detail AS detail,
               toString(event.recorded_at) AS recordedAt
        ORDER BY event.seq
        ''',
        store=GRAPH_STORE,
        routing_='r',
    )
    return [dict(record) for record in records]


@dataclass(frozen=True)
class LedgerStep:
    migration_id: str
    from_version: int
    to_version: int
    kind: str


class GraphFormatLockLost(RuntimeError):
    """This start no longer holds the graph's migration lock."""


# The ledger's own identity: exactly one FuliDataFormat node per store, so two
# starts can never keep two versions. Part of the ledger contract every format
# version shares, which is why it is created before the format is known.
IDENTITY_CONSTRAINT = (
    'CREATE CONSTRAINT fuli_data_format_store IF NOT EXISTS '
    'FOR (n:FuliDataFormat) REQUIRE n.store IS UNIQUE'
)


async def ensure_graph_ledger_identity(driver) -> None:
    await driver.execute_query(IDENTITY_CONSTRAINT)
    await driver.execute_query('MERGE (:FuliDataFormat {store: $store})', store=GRAPH_STORE)


async def hold_graph_identity(driver) -> None:
    """Inside a confirmed apply or undo: takes the identity node's write lock
    and keeps it to the commit. Every provider's business write takes the same
    lock as its last statement (graph_format.writer_fence), so none commits
    while this transaction runs, and each then sees the version it left."""
    await driver.execute_query(_LOCKED_IDENTITY + 'RETURN format.version AS version', store=GRAPH_STORE)


# Every ledger write first takes the identity node's write lock with a
# property write, and only then reads the owner, lease or version it decides
# on. A read before the lock could see a value another transaction is about
# to change (Neo4j lost updates), so no decision is made from it.
_LOCKED_IDENTITY = '''
MATCH (format:FuliDataFormat {store: $store})
SET format._format_lock = true
REMOVE format._format_lock
WITH format
'''


async def acquire_graph_migration_lock(driver, owner: str, *, until) -> bool:
    """Take the lease when it is free, expired or already ours."""
    records, _, _ = await driver.execute_query(
        _LOCKED_IDENTITY + '''
        WITH format, format.lock_owner IS NULL OR format.lock_owner = $owner
                     OR format.lock_until < datetime() AS free
        FOREACH (_ IN CASE WHEN free THEN [1] ELSE [] END |
          SET format.lock_owner = $owner, format.lock_until = $until)
        RETURN free AS acquired
        ''',
        store=GRAPH_STORE, owner=owner, until=until,
    )
    return bool(records and records[0]['acquired'])


async def hold_graph_migration_lock(driver, owner: str, *, until) -> int | None:
    """Inside a confirmed operation's transaction: takes the identity node's
    write lock and keeps it to the commit, so no other process takes the
    migration lease meanwhile, even once it has expired. Refuses unless this
    run still holds the lease (another process may have taken it over while
    this one waited), renews it, and returns the version read under the lock."""
    records, _, _ = await driver.execute_query(
        _LOCKED_IDENTITY + '''
        WITH format WHERE format.lock_owner = $owner
        SET format.lock_until = $until
        RETURN format.version AS version
        ''',
        store=GRAPH_STORE, owner=owner, until=until,
    )
    if not records:
        raise GraphFormatLockLost('lost the graph migration lock to another process')
    version = records[0]['version']
    return int(version) if version is not None else None


async def release_graph_migration_lock(driver, owner: str) -> None:
    await driver.execute_query(
        _LOCKED_IDENTITY + '''
        WITH format WHERE format.lock_owner = $owner
        REMOVE format.lock_owner, format.lock_until
        ''',
        store=GRAPH_STORE, owner=owner,
    )


async def record_graph_event(
    driver, step: LedgerStep, status: str, *, owner: str, now, detail: str,
    backup_ref: str | None = None,
) -> None:
    """Append an event; only the holder of the migration lock may."""
    if status not in STATUSES:
        raise ValueError(f'unknown ledger status {status}')
    records, _, _ = await driver.execute_query(
        _LOCKED_IDENTITY + '''
        WITH format WHERE format.lock_owner = $owner
        SET format.event_count = coalesce(format.event_count, 0) + 1
        CREATE (format)-[:HAS_FORMAT_EVENT]->(:FuliDataFormatEvent {
          store: $store,
          seq: format.event_count,
          migration_id: $migration_id,
          from_version: $from_version,
          to_version: $to_version,
          kind: $kind,
          status: $status,
          backup_ref: $backup_ref,
          detail: $detail,
          recorded_at: $recorded_at
        })
        RETURN count(format) AS recorded
        ''',
        store=GRAPH_STORE,
        owner=owner,
        migration_id=step.migration_id,
        from_version=step.from_version,
        to_version=step.to_version,
        kind=step.kind,
        status=status,
        backup_ref=backup_ref,
        detail=detail,
        recorded_at=now(),
    )
    if not records or not records[0]['recorded']:
        raise GraphFormatLockLost(f'lost the graph migration lock before recording {step.migration_id}')


async def stamp_graph_version(driver, version: int, *, owner: str, now, until) -> None:
    """Move the version forward, never back, and only while holding the lock;
    each stamp renews the lease."""
    records, _, _ = await driver.execute_query(
        _LOCKED_IDENTITY + '''
        WITH format WHERE format.lock_owner = $owner AND coalesce(format.version, 0) <= $version
        SET format.version = $version, format.updated_at = $updated_at, format.lock_until = $until
        RETURN count(format) AS stamped
        ''',
        store=GRAPH_STORE,
        owner=owner,
        version=version,
        updated_at=now(),
        until=until,
    )
    if not records or not records[0]['stamped']:
        raise GraphFormatLockLost(
            f'refused to stamp graph version {version}: the lock was lost or the version is higher'
        )


async def lower_graph_version(driver, version: int, *, owner: str, now, current: int) -> None:
    """Undoing a confirmed step moves the version back from exactly current to
    version, only while holding the lock; nothing else ever lowers it."""
    records, _, _ = await driver.execute_query(
        _LOCKED_IDENTITY + '''
        WITH format WHERE format.lock_owner = $owner AND format.version = $current
        SET format.version = $version, format.updated_at = $updated_at
        RETURN count(format) AS lowered
        ''',
        store=GRAPH_STORE, owner=owner, version=version, current=current, updated_at=now(),
    )
    if not records or not records[0]['lowered']:
        raise GraphFormatLockLost(
            f'refused to move graph version {current} back to {version}: the lock was lost or the '
            'version changed'
        )
