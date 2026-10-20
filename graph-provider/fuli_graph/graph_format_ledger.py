"""The graph's applied-migration ledger (rec#17 D-09).

One FuliDataFormat node holds the graph's format version; every step the
format registry takes or declines is appended as a FuliDataFormatEvent with
its migration ID, source and target version, backup and status. Events are
never rewritten: a migration's state is its latest event.
"""

from dataclasses import dataclass

GRAPH_STORE = 'graph'
# Owned by the ledger itself, outside any migration's declared labels.
LEDGER_LABELS = frozenset({'FuliDataFormat', 'FuliDataFormatEvent'})
STATUSES = frozenset({
    'created',  # a fresh graph was built at the current version
    'baseline_detected',  # an unversioned graph already had this step in effect
    'started',  # an automatic step began; without a later status it was interrupted
    'applied',
    'pending_confirmation',  # needed, but changes records or failed a preflight
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


@dataclass(frozen=True)
class LedgerStep:
    migration_id: str
    from_version: int
    to_version: int
    kind: str


async def record_graph_event(
    driver, step: LedgerStep, status: str, *, now, detail: str, backup_ref: str | None = None
) -> None:
    if status not in STATUSES:
        raise ValueError(f'unknown ledger status {status}')
    await driver.execute_query(
        '''
        MERGE (format:FuliDataFormat {store: $store})
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
        ''',
        store=GRAPH_STORE,
        migration_id=step.migration_id,
        from_version=step.from_version,
        to_version=step.to_version,
        kind=step.kind,
        status=status,
        backup_ref=backup_ref,
        detail=detail,
        recorded_at=now(),
    )


async def stamp_graph_version(driver, version: int, *, now) -> None:
    await driver.execute_query(
        '''
        MERGE (format:FuliDataFormat {store: $store})
        SET format.version = $version, format.updated_at = $updated_at
        ''',
        store=GRAPH_STORE,
        version=version,
        updated_at=now(),
    )
