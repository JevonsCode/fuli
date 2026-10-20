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

from dataclasses import dataclass, field
import logging

from neo4j.exceptions import ClientError

from .graph_format_ledger import (
    LedgerStep,
    read_graph_ledger,
    record_graph_event,
    stamp_graph_version,
)
from .graph_format_migrations import GRAPH_FORMAT_VERSION, GRAPH_MIGRATIONS, GraphMigration
from .graph_format_schema import schema_fingerprint
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


class GraphFormatUnavailable(Exception):
    """A graph operation the current data format does not allow."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class GraphFormatState:
    access: str  # 'write', 'read' or 'none'
    state: str  # 'current', 'pending_confirmation', 'interrupted', 'newer' or 'unchecked'
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
        return GraphFormatUnavailable(code, self.message or 'The graph cannot be written now.')


UNCHECKED = GraphFormatState(
    'none', 'unchecked', None, 'The graph data format has not been checked yet.'
)


def _step(migration: GraphMigration) -> LedgerStep:
    return LedgerStep(migration.id, migration.from_version, migration.to_version, migration.kind)


async def prepare_graph_format(driver, settings, *, now=now_utc) -> GraphFormatState:
    """driver is the unguarded maintenance handle; nothing else runs meanwhile."""
    ledger = await read_graph_ledger(driver)
    if ledger.version is not None and ledger.version > GRAPH_FORMAT_VERSION:
        return _newer(ledger.version)
    unfinished = [
        migration_id for migration_id, status in ledger.latest.items()
        if status == 'started'
        and not (migration_id in _MIGRATIONS and _MIGRATIONS[migration_id].automatic)
    ]
    if unfinished:
        return GraphFormatState(
            'read', 'interrupted', ledger.version,
            f'A graph migration ({", ".join(unfinished)}) started and did not finish. FULI '
            'keeps the graph read-only until it is completed or the graph is restored '
            'from a backup.',
            tuple(unfinished),
        )
    if ledger.version is None and await _empty(driver):
        await _create(driver, now)
        return _current()
    version = ledger.version or 0
    for migration in GRAPH_MIGRATIONS:
        if migration.to_version <= version:
            continue
        refusal = await _advance(driver, settings, migration, ledger, now)
        if refusal:
            return refusal
        version = migration.to_version
        await stamp_graph_version(driver, version, now=now)
    return _current()


async def _advance(driver, settings, migration, ledger, now) -> GraphFormatState | None:
    unversioned = ledger.version is None
    if not migration.automatic:
        count = await migration.pending(driver, settings)
        if not count:
            await record_graph_event(
                driver, _step(migration), 'baseline_detected', now=now,
                detail='no record needs this step',
            )
            return None
        detail = f'{count} records need this step; it changes existing records'
        return await _pending(driver, migration, ledger, now, detail)
    missing = await _missing_rules(driver, migration.rules)
    if not missing:
        await record_graph_event(
            driver, _step(migration), 'baseline_detected' if unversioned else 'applied',
            now=now, detail=_schema_detail(migration, 'all declared rules already exist'),
        )
        return None
    conflicts = await _unique_conflicts(driver, missing)
    if conflicts:
        detail = 'existing records conflict with ' + ', '.join(
            f'{name} ({count} duplicate values)' for name, count in conflicts
        )
        return await _pending(driver, migration, ledger, now, detail)
    await record_graph_event(
        driver, _step(migration), 'started', now=now, detail=NO_BACKUP_NOTE
    )
    for rule in missing:
        await _run_rule(driver, rule)
    still_missing = await _missing_rules(driver, migration.rules)
    if still_missing:
        raise RuntimeError(
            f'{migration.id} did not create {", ".join(rule.name for rule in still_missing)}'
        )
    await record_graph_event(
        driver, _step(migration), 'applied', now=now,
        detail=_schema_detail(migration, f'created {len(missing)} rules; {NO_BACKUP_NOTE}'),
    )
    logger.info('graph format %s applied: %s', migration.id, NO_BACKUP_NOTE)
    return None


async def _pending(driver, migration, ledger, now, detail) -> GraphFormatState:
    already = (
        ledger.latest.get(migration.id) == 'pending_confirmation'
        and ledger.details.get(migration.id) == detail
    )
    if not already:
        await record_graph_event(
            driver, _step(migration), 'pending_confirmation', now=now, detail=detail
        )
    logger.warning('graph format %s needs confirmation: %s', migration.id, detail)
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
    records, _, _ = await driver.execute_query(
        'MATCH (n) RETURN count(n) > 0 AS used LIMIT 1', routing_='r'
    )
    return not records or not records[0]['used']


async def _create(driver, now) -> None:
    rules = [rule for migration in GRAPH_MIGRATIONS for rule in migration.rules]
    for rule in rules:
        await _run_rule(driver, rule)
    await record_graph_event(
        driver,
        LedgerStep('graph/created', 0, GRAPH_FORMAT_VERSION, 'schema'),
        'created',
        now=now,
        detail=f'a fresh graph built at version {GRAPH_FORMAT_VERSION} with {len(rules)} rules',
    )
    await stamp_graph_version(driver, GRAPH_FORMAT_VERSION, now=now)


async def _existing_rule_names(driver) -> set[str]:
    names = set()
    for query in ('SHOW CONSTRAINTS YIELD name', 'SHOW INDEXES YIELD name'):
        records, _, _ = await driver.execute_query(query, routing_='r')
        names.update(record['name'] for record in records)
    return names


async def _missing_rules(driver, rules):
    existing = await _existing_rule_names(driver)
    return [rule for rule in rules if rule.name not in existing]


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
