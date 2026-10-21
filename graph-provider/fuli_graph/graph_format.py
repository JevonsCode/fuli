"""Check and prepare the graph's data format before anything else touches it
(rec#17 D-09).

prepare_graph_format runs once per provider start, before any DDL, background
work or business write, and decides what the rest of the provider may do:

- a fresh, empty graph is built directly at the current version;
- an unversioned graph is inspected: a step whose effect is already present is
  recorded as detected, a missing index or constraint is added (the only
  automatic kind), and a step that would still change records stops the
  upgrade there and leaves the graph read-only until a person confirms it;
- a newer graph than this FULI knows is read-only only when that version is
  verified readable, otherwise refused;
- a step that started and never finished leaves the graph read-only unless it
  is an automatic schema step, which is idempotent and simply runs again.

Neo4j has no in-process backup, which is why only declared indexes and
constraints ever run here; every ledger event says so.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import timedelta
import logging
from uuid import uuid4

from neo4j.exceptions import ClientError

from .graph_format_ledger import (
    GRAPH_STORE,
    GraphFormatLockLost,
    LedgerStep,
    acquire_graph_migration_lock,
    ensure_graph_ledger_identity,
    read_graph_ledger,
    read_graph_ledger_events,
    record_graph_event,
    release_graph_migration_lock,
    stamp_graph_version,
)
from .graph_format_migrations import GRAPH_FORMAT_VERSION, GRAPH_MIGRATIONS, GraphMigration
from .graph_format_schema import schema_fingerprint
from .graph_schema_state import compare_rules, existing_rules
from .provider_values import now_utc

logger = logging.getLogger(__name__)

# Newer graph versions this FULI has verified it can read without misreading
# them. None yet: a newer graph is refused until a version says otherwise.
READABLE_NEWER_VERSIONS = frozenset()
NO_BACKUP_NOTE = (
    'no backup: Neo4j has no in-process backup, so only declared indexes and '
    'constraints run automatically'
)
_MIGRATIONS = {migration.id: migration for migration in GRAPH_MIGRATIONS}
# One start at a time migrates the graph. A crashed start's lease expires, and
# every stamp renews it; another start waits a little longer than one lease.
LOCK_LEASE = timedelta(seconds=120)
LOCK_WAIT_SECONDS = 150
LOCK_POLL_SECONDS = 1


class GraphFormatUnavailable(Exception):
    """A graph operation the current data format does not allow."""

    def __init__(self, code: str, message: str, steps: tuple[str, ...] = ()):
        super().__init__(message)
        self.code = code
        self.message = message
        self.steps = steps

    def detail(self) -> dict:
        return {'code': self.code, 'message': self.message, 'store': 'graph',
                'steps': list(self.steps)}


@dataclass(frozen=True)
class GraphFormatState:
    access: str  # 'write', 'read' or 'none'
    # 'current', 'pending_confirmation', 'interrupted', 'newer', 'blocked', 'locked' or 'unchecked'
    state: str
    version: int | None
    message: str | None = None
    pending: tuple[str, ...] = field(default_factory=tuple)

    def health(self) -> dict:
        return {
            'store': 'graph',
            'version': self.version,
            'supported_version': GRAPH_FORMAT_VERSION,
            'access': self.access,
            'state': self.state,
            'pending': list(self.pending),
            'message': self.message,
        }

    def refusal(self) -> GraphFormatUnavailable:
        code = 'data_format_read_only' if self.access == 'read' else 'data_format_blocked'
        return GraphFormatUnavailable(
            code, self.message or 'The graph cannot be written now.', self.pending
        )


UNCHECKED = GraphFormatState(
    'none', 'unchecked', None, 'The graph data format has not been checked yet.'
)

# The last statement of every business write transaction of every provider,
# just before it commits: takes the graph identity node's write lock (a
# confirmed apply or undo holds it to its own commit, so this waits) and
# reads the graph's version in the same transaction. A provider that decided
# "writable" before another process applied or undid a step finds out here
# and its transaction rolls back, instead of committing in a format the graph
# no longer has. Writers hold the lock only from this statement to their
# commit, so ordinary writes do not wait for each other's work.
_WRITER_FENCE = '''
MATCH (format:FuliDataFormat {store: $store})
SET format._fuli_writer = true
REMOVE format._fuli_writer
RETURN format.version AS version
'''


async def writer_fence(transaction) -> None:
    result = await transaction.run(_WRITER_FENCE, store=GRAPH_STORE)
    records = [record async for record in result]
    version = records[0]['version'] if records else None
    if version != GRAPH_FORMAT_VERSION:
        raise GraphFormatUnavailable(
            'data_format_changed_underneath',
            f'The graph is at data format {version} (a person applied or undid a migration) while '
            f'this provider was writing it as {GRAPH_FORMAT_VERSION}. Nothing was written; restart FULI.',
        )


def ledger_step(migration: GraphMigration) -> LedgerStep:
    return LedgerStep(migration.id, migration.from_version, migration.to_version, migration.kind)


@dataclass(frozen=True)
class MigrationRun:
    """One hold on the graph's migration lock: its owner and its clock. A
    provider start and a person's confirmed migration (graph_format_confirm.py)
    both migrate only under it."""
    driver: object
    settings: object
    owner: str
    now: object

    @classmethod
    def start(cls, driver, settings, now):
        return cls(driver, settings, f'{settings.provider_id}:{uuid4()}', now)

    def until(self):
        return self.now() + LOCK_LEASE

    async def acquire(self, wait_seconds, sleep) -> bool:
        """Takes the lock, waiting up to wait_seconds for another holder."""
        deadline = asyncio.get_running_loop().time() + wait_seconds
        while not await acquire_graph_migration_lock(self.driver, self.owner, until=self.until()):
            if asyncio.get_running_loop().time() >= deadline:
                return False
            await sleep(LOCK_POLL_SECONDS)
        return True

    async def release(self):
        await release_graph_migration_lock(self.driver, self.owner)

    async def record(self, step, status, *, detail):
        await record_graph_event(self.driver, step, status, owner=self.owner, now=self.now, detail=detail)

    async def stamp(self, version):
        await stamp_graph_version(self.driver, version, owner=self.owner, now=self.now, until=self.until())


async def prepare_graph_format(
    driver, settings, *, now=now_utc, lock_wait_seconds=LOCK_WAIT_SECONDS, sleep=asyncio.sleep,
) -> GraphFormatState:
    """driver is the unguarded maintenance handle. A newer graph is refused
    before any DDL; otherwise this start takes the graph's migration lock,
    reads the ledger again under it, and only moves the version forward."""
    ledger = await read_graph_ledger(driver)
    if ledger.version is not None and ledger.version > GRAPH_FORMAT_VERSION:
        return _log(_newer(ledger.version))
    try:
        await ensure_graph_ledger_identity(driver)
    except ClientError:
        return _log(GraphFormatState(
            'none', 'blocked', ledger.version,
            'The graph has more than one data format ledger. FULI does not use it until the '
            'duplicate ledger is resolved or the graph is restored from a backup.',
        ))
    run = MigrationRun.start(driver, settings, now)
    if not await run.acquire(lock_wait_seconds, sleep):
        return _log(GraphFormatState(
            'none', 'locked', ledger.version,
            'Another FULI provider start is migrating this graph. Restart this provider '
            'once it has finished.',
        ))
    try:
        return await _prepare_locked(run)
    except GraphFormatLockLost as error:
        return _log(GraphFormatState('none', 'locked', None, f'{error}. Restart this provider.'))
    finally:
        await run.release()


def _log(state: GraphFormatState) -> GraphFormatState:
    logger.warning(
        'graph format: store graph is %s (version %s, steps %s): %s',
        state.state, state.version, ', '.join(state.pending) or '-', state.message,
    )
    return state


async def _prepare_locked(run: MigrationRun) -> GraphFormatState:
    driver = run.driver
    # Another start may have moved the graph while this one waited.
    ledger = await read_graph_ledger(driver)
    if ledger.version is not None and ledger.version > GRAPH_FORMAT_VERSION:
        return _log(_newer(ledger.version))
    unfinished = [
        migration_id for migration_id, status in ledger.latest.items()
        if status == 'started'
        and not (migration_id in _MIGRATIONS and _MIGRATIONS[migration_id].automatic)
    ]
    if unfinished:
        return _log(GraphFormatState(
            'read', 'interrupted', ledger.version,
            f'A graph migration ({", ".join(unfinished)}) started and did not finish. FULI '
            'keeps the graph read-only until it is completed or the graph is restored '
            'from a backup.',
            tuple(unfinished),
        ))
    if ledger.version is None and await _empty(driver):
        await _create(run)
        return _current()
    version = ledger.version or 0
    for migration in GRAPH_MIGRATIONS:
        if migration.to_version <= version:
            continue
        refusal = await _advance(run, migration, ledger)
        if refusal:
            return refusal
        version = migration.to_version
        await run.stamp(version)
    return _current()


@dataclass(frozen=True)
class _Decision:
    state: str  # 'detected', 'automatic' or 'pending_confirmation'
    detail: str
    missing: tuple = ()
    # A record step's records that still need it, by ID only.
    keys: tuple[str, ...] = ()


async def decide_graph_step(driver, settings, migration) -> _Decision:
    """How one step stands against the graph, from reads only. Also what a
    person's confirmation is computed from (graph_format_confirm.py)."""
    if not migration.automatic:
        keys = tuple(await migration.pending(driver, settings))
        if not keys:
            return _Decision('detected', 'no record needs this step')
        return _Decision(
            'pending_confirmation',
            f'{len(keys)} records need this step; it changes existing records', keys=keys,
        )
    missing, mismatched = compare_rules(migration.rules, await existing_rules(driver))
    if mismatched:
        return _Decision('pending_confirmation', 'schema mismatch: ' + '; '.join(mismatched))
    missing = tuple(missing)
    if not missing:
        return _Decision('detected', 'all declared rules already exist')
    conflicts = await _unique_conflicts(driver, missing)
    if conflicts:
        return _Decision('pending_confirmation', 'existing records conflict with ' + ', '.join(
            f'{name} ({count} duplicate values)' for name, count in conflicts
        ))
    return _Decision('automatic', f'creates {", ".join(rule.name for rule in missing)}', missing)


async def _advance(run: MigrationRun, migration, ledger) -> GraphFormatState | None:
    driver = run.driver
    decision = await decide_graph_step(driver, run.settings, migration)
    if decision.state == 'pending_confirmation':
        return await _pending(run, migration, ledger, decision.detail)
    if decision.state == 'detected':
        if not migration.automatic:
            await run.record(ledger_step(migration), 'baseline_detected', detail=decision.detail)
            return None
        await run.record(
            ledger_step(migration), 'baseline_detected' if ledger.version is None else 'applied',
            detail=_schema_detail(migration, decision.detail),
        )
        return None
    missing = decision.missing
    await run.record(ledger_step(migration), 'started', detail=NO_BACKUP_NOTE)
    for rule in missing:
        await _run_rule(driver, rule)
    still_missing, mismatched = compare_rules(migration.rules, await existing_rules(driver))
    if still_missing or mismatched:
        raise RuntimeError(
            f'{migration.id} did not create {", ".join(rule.name for rule in still_missing)}'
            f'{"; " + "; ".join(mismatched) if mismatched else ""}'
        )
    await run.record(
        ledger_step(migration), 'applied',
        detail=_schema_detail(migration, f'created {len(missing)} rules; {NO_BACKUP_NOTE}'),
    )
    logger.info('graph format %s applied: %s', migration.id, NO_BACKUP_NOTE)
    return None


async def _pending(run: MigrationRun, migration, ledger, detail) -> GraphFormatState:
    already = (
        ledger.latest.get(migration.id) == 'pending_confirmation'
        and ledger.details.get(migration.id) == detail
    )
    if not already:
        await run.record(ledger_step(migration), 'pending_confirmation', detail=detail)
    logger.warning(
        'graph format: store graph step %s needs confirmation: %s', migration.id, detail
    )
    return GraphFormatState(
        'read', 'pending_confirmation', migration.from_version,
        f'The graph needs migration {migration.id} ({migration.summary}): {detail}. '
        'FULI does not run it automatically and keeps the graph read-only until a '
        'person confirms it.',
        (migration.id,),
    )


def _newer(version: int) -> GraphFormatState:
    if version in READABLE_NEWER_VERSIONS:
        return GraphFormatState(
            'read', 'newer', version,
            f'The graph uses data format {version}, newer than this FULI writes '
            f'({GRAPH_FORMAT_VERSION}). FULI reads it but does not write to it; upgrade FULI '
            'to write again.',
        )
    return GraphFormatState(
        'none', 'newer', version,
        f'The graph uses data format {version}, newer than this FULI supports '
        f'({GRAPH_FORMAT_VERSION}). Upgrade FULI, or restore the backup made before the '
        'newer version first ran.',
    )


def _current() -> GraphFormatState:
    return GraphFormatState('write', 'current', GRAPH_FORMAT_VERSION)


def _schema_detail(migration: GraphMigration, note: str) -> str:
    return f'fingerprint {schema_fingerprint(migration.rules, migration.labels)}; {note}'


async def _empty(driver) -> bool:
    """No node but the ledger's own; stops at the first one found."""
    records, _, _ = await driver.execute_query(
        '''
        CALL {
          MATCH (n) WHERE NOT n:FuliDataFormat AND NOT n:FuliDataFormatEvent
            AND NOT n:FuliDataFormatUndo
          RETURN n LIMIT 1
        }
        RETURN count(n) AS used
        ''',
        routing_='r',
    )
    return not records or not records[0]['used']


async def _create(run: MigrationRun) -> None:
    rules = [rule for migration in GRAPH_MIGRATIONS for rule in migration.rules]
    missing, mismatched = compare_rules(rules, await existing_rules(run.driver))
    if mismatched:
        raise RuntimeError('a fresh graph already has rules that differ: ' + '; '.join(mismatched))
    for rule in missing:
        await _run_rule(run.driver, rule)
    await run.record(
        LedgerStep('graph/created', 0, GRAPH_FORMAT_VERSION, 'schema'), 'created',
        detail=f'a fresh graph built at version {GRAPH_FORMAT_VERSION} with {len(rules)} rules',
    )
    await run.stamp(GRAPH_FORMAT_VERSION)


async def _unique_conflicts(driver, rules) -> list[tuple[str, int]]:
    """Duplicate values that would make a uniqueness constraint fail."""
    conflicts = []
    for rule in rules:
        if not rule.unique_label:
            continue
        present = ' AND '.join(f'n.{name} IS NOT NULL' for name in rule.unique_properties)
        values = ', '.join(f'n.{name} AS {name}' for name in rule.unique_properties)
        records, _, _ = await driver.execute_query(
            f'''
            MATCH (n:{rule.unique_label}) WHERE {present}
            WITH {values}, count(*) AS copies
            WHERE copies > 1
            RETURN count(*) AS conflicts
            ''',
            routing_='r',
        )
        count = int(records[0]['conflicts']) if records else 0
        if count:
            conflicts.append((rule.name, count))
    return conflicts


async def _run_rule(driver, rule) -> None:
    try:
        await driver.execute_query(rule.cypher)
    except ClientError as error:
        # IF NOT EXISTS can still race an equivalent rule created concurrently.
        if 'EquivalentSchemaRuleAlreadyExists' not in str(error):
            raise


async def inspect_graph_format(driver, settings) -> dict:
    """What prepare_graph_format would find and do, from reads only: no DDL,
    no ledger event, no version stamp. The caller's driver runs every query in
    Neo4j's read access mode, so Neo4j itself would refuse a write here."""
    ledger = await read_graph_ledger(driver)
    report = {
        'store': 'graph', 'kind': 'neo4j', 'version': ledger.version,
        'target': GRAPH_FORMAT_VERSION, 'ledger': await read_graph_ledger_events(driver),
        'steps': [],
    }
    if ledger.version is not None and ledger.version > GRAPH_FORMAT_VERSION:
        readable = ledger.version in READABLE_NEWER_VERSIONS
        return {**report, 'state': 'newer_readable' if readable else 'newer_format'}
    started = [
        {'id': migration_id, 'state': 'half_applied', 'detail': 'started and did not finish'}
        for migration_id, status in ledger.latest.items() if status == 'started'
    ]
    if started:
        return {**report, 'state': 'half_applied', 'steps': started}
    if ledger.version == GRAPH_FORMAT_VERSION:
        return {**report, 'state': 'current'}
    if ledger.version is None and await _empty(driver):
        return {**report, 'state': 'empty', 'note': 'built at the current version on start'}
    steps = []
    for migration in GRAPH_MIGRATIONS:
        if migration.to_version <= (ledger.version or 0):
            continue
        decision = await decide_graph_step(driver, settings, migration)
        steps.append({'id': migration.id, 'state': decision.state, 'detail': decision.detail})
        if decision.state == 'pending_confirmation':
            break
    pending = any(step['state'] == 'pending_confirmation' for step in steps)
    return {**report, 'steps': steps,
            'state': 'pending_confirmation' if pending else 'upgrade_on_start'}
