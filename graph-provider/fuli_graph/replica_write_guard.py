"""Writes never change a read-only copy kept here (docs/runner-roles-design.md
§12, "Write refusal").

A copy (scope_import.py) is changed only by its import. Neo4j Community cannot
say which records a transaction changed, so this guard compares instead: after
every import (and when a startup probe finds copies) it keeps
in memory a digest of every copied node and relationship, without the derived
properties a computer computes for itself (vectors, `fuli_semantic_*`), and, on a follower, how
many records of `global` this graph holds. Just before a write transaction
commits, in that transaction, it reads the copies again by their element IDs
and the counts, and refuses the write (409 `replica_read_only`, rolled back,
nothing written) when a copy changed, went, got a relationship of this
computer's to another copy, or this computer made a record of `global` of its
own.

The check runs only while this graph holds copies: a graph without copies (any
ordinary FULI) reads no digests for business writes. Whether it runs at every
write is one constant (CHECK_EVERY_WRITE), decided by what it costs; above
MAX_GUARDED_RECORDS copies it does not, and the status says so. Optional
report-only observation measures the check without using its result to refuse a write. Tests turn it
on for every write (`STRICT`), so a write path that changes a copy fails there.

The import is the one writer it lets through (replica_import_transaction in
runtime.py, which only scope_import.py calls, and scope_release.py when this
computer stops keeping copies; tests/test_replica_write_guard.py keeps it so). A format backfill runs before the digests are taken (at start, and
again after a person's confirmed migration), so an automatic migration that
only adds fields may shape copies as it shapes every record.
"""
import asyncio
import hashlib
from dataclasses import dataclass, field
from time import monotonic

from fastapi import HTTPException

from .replica_guard_observation import ReplicaGuardObservation
from .scope_classifier import DERIVED_PROPERTIES, GLOBAL_JUDGE, NODE_RULES
from .scope_export import canonical, encoded_properties

# Off: measured on a follower's graph (docs/runner-roles-design.md §12, "Write
# refusal"), 455 copied records beside a 6,000-node project, one check took
# 41 ms (median of 20) and turned a 1.5 ms write into 42 ms, over the 40 ms
# the check may cost. Writes of `global` are refused at their entries instead,
# and the periodic import (Node global-sync.js) puts a changed copy back.
CHECK_EVERY_WRITE = False
# Were it on: above this many copied records one check takes ~100 ms (it grows
# with the records read, ~0.09 ms each).
MAX_GUARDED_RECORDS = 1000
# Tests only: check every write whatever the two constants above say.
STRICT = False

# Labels that are `global` whatever their properties say, and the habits of
# `global`: what a follower must never make of its own.
GLOBAL_LABELS = tuple(sorted(label for label, rule in NODE_RULES.items() if rule.judge == GLOBAL_JUDGE))
_COUNTS = 'RETURN ' + ', '.join(
    [f'COUNT {{ (:{label}) }} AS `{label}`' for label in GLOBAL_LABELS]
    + ["COUNT { (habit:Entity) WHERE habit.fuli_preference_scope = 'global' } AS `Entity`"])
_HAS_COPIES = """RETURN EXISTS { MATCH (n) WHERE n.fuli_replica_owner IS NOT NULL }
    OR EXISTS { MATCH ()-[r]->() WHERE r.fuli_replica_owner IS NOT NULL } AS present"""
_PROPERTIES = '[key IN keys({0}) WHERE NOT key IN $derived | [key, {0}[key]]]'
_COPIED_NODES = f'''
MATCH (node) WHERE node.fuli_replica_owner IS NOT NULL
RETURN elementId(node) AS id, labels(node) AS labels, {_PROPERTIES.format('node')} AS properties'''
_COPIED_RELATIONSHIPS = f'''
MATCH ()-[link]->() WHERE link.fuli_replica_owner IS NOT NULL
RETURN elementId(link) AS id, type(link) AS type, {_PROPERTIES.format('link')} AS properties'''
_NODES_NOW = f'''
UNWIND $ids AS id
OPTIONAL MATCH (node) WHERE elementId(node) = id
RETURN id, labels(node) AS labels, {_PROPERTIES.format('node')} AS properties'''
_RELATIONSHIPS_NOW = f'''
UNWIND $ids AS id
OPTIONAL MATCH ()-[link]->() WHERE elementId(link) = id
RETURN id, type(link) AS type, {_PROPERTIES.format('link')} AS properties'''
# This computer's relationships from one copy to another: they would change
# what the copies say (a local edge to a copy from a record of its own is fine).
_LOCAL_LINKS = '''
UNWIND $ids AS id
MATCH (node) WHERE elementId(node) = id
MATCH (node)-[link]->(other)
WHERE link.fuli_replica_owner IS NULL AND other.fuli_replica_owner IS NOT NULL
RETURN count(link) AS links'''


@dataclass(frozen=True)
class _Copy:
    digest: str
    name: str  # what the refusal names: the record's label and key, or its type
    owner: str
    scopes: tuple[str, ...]


@dataclass
class _Snapshot:
    nodes: dict[str, _Copy] = field(default_factory=dict)
    relationships: dict[str, _Copy] = field(default_factory=dict)
    local_links: int = 0
    counts: dict[str, int] = field(default_factory=dict)

    @property
    def size(self) -> int:
        return len(self.nodes) + len(self.relationships)


def _digest(kind, properties) -> str:
    return hashlib.sha256(canonical([kind, encoded_properties(dict(properties or []))]).encode()).hexdigest()


def _node_kind(labels) -> list[str]:
    return sorted(labels or [])


def _node_name(labels, properties: dict) -> str:
    label = next((label for label in sorted(labels) if label in NODE_RULES), sorted(labels)[0])
    rule = NODE_RULES.get(label)
    key = '/'.join(str(properties.get(name)) for name in rule.key) if rule else '?'
    return f'{label}:{key}'


def _copy(kind, name, properties) -> _Copy:
    values = dict(properties)
    return _Copy(_digest(kind, properties), name, values.get('fuli_replica_owner') or '',
                 tuple(values.get('fuli_replica_scopes') or ()))


async def _rows(transaction, query, **parameters) -> list[dict]:
    result = await transaction.run(query, derived=sorted(DERIVED_PROPERTIES), **parameters)
    return [dict(record) async for record in result]


def refusal(name: str, owner: str | None, scopes) -> HTTPException:
    scope = ', '.join(scopes) or 'global'
    return HTTPException(status_code=409, detail={
        'code': 'replica_read_only',
        'record': name, 'scopes': list(scopes) or ['global'], 'owner': owner,
        'message': f'{name} is part of {scope}, which another computer owns ({owner or "the computer this one follows"}); '
                   'this computer keeps only a read-only copy of it. Send the change to its owner. Nothing was written. '
                   f'{name} 属于 {scope}，归另一台电脑所有，这台电脑只有只读副本：请在那台电脑上改。什么都没写。'})


class ReplicaWriteGuard:
    def __init__(self, global_replica: bool, *, observe=False):
        # config.global_replica: `global` is a copy here even before its first import.
        self.global_replica = global_replica
        self.inventory_known = False
        self.observation = ReplicaGuardObservation() if observe else None
        self.active = global_replica
        self._snapshot = _Snapshot()
        self._generation = 0
        self._importing = asyncio.Lock()

    @property
    def owners(self) -> list[str]:
        return sorted({copy.owner for records in (self._snapshot.nodes, self._snapshot.relationships)
                       for copy in records.values()} - {''})

    def status(self) -> dict:
        """What the state says about this graph's copies and how writes are kept off them."""
        if not self.inventory_known:
            state = {'holdsCopies': None, 'checks': 'unknown'}
        elif not self.active:
            state = {'holdsCopies': False, 'checks': 'none'}
        else:
            size = self._snapshot.size
            checks = 'every_write' if self._checks_every_write() else (
                'too_large' if CHECK_EVERY_WRITE or (self.observation and size > MAX_GUARDED_RECORDS) else
                'report' if self.observation else 'periodic_import')
            state = {'holdsCopies': size > 0, 'copiedRecords': size, 'checks': checks}
            if size and not self.global_replica:
                state['owners'] = self.owners
        if self.observation:
            state['observation'] = self.observation.status()
        return state

    async def has_copies(self, transaction):
        return (await _rows(transaction, _HAS_COPIES))[0]['present']

    def _checks_every_write(self) -> bool:
        return STRICT or (CHECK_EVERY_WRITE and self._snapshot.size <= MAX_GUARDED_RECORDS)

    async def refresh(self, transaction) -> None:
        """Take the digests again: at start and after every import."""
        snapshot = _Snapshot()
        for row in await _rows(transaction, _COPIED_NODES):
            snapshot.nodes[row['id']] = _copy(_node_kind(row['labels']),
                                              _node_name(row['labels'], dict(row['properties'])), row['properties'])
        for row in await _rows(transaction, _COPIED_RELATIONSHIPS):
            snapshot.relationships[row['id']] = _copy(row['type'], row['type'], row['properties'])
        await self._install(transaction, snapshot)

    async def refresh_empty(self, transaction):
        await self._install(transaction, _Snapshot())

    async def _install(self, transaction, snapshot):
        snapshot.local_links, snapshot.counts = await self._links_and_counts(transaction, snapshot)
        self.inventory_known = True
        self._snapshot = snapshot
        self._generation += 1
        self.active = self.global_replica or snapshot.size > 0

    def held_for_import(self) -> asyncio.Lock:
        """Held by an import from its start until its digests are taken again."""
        return self._importing

    async def check(self, transaction) -> None:
        """Before a write commits, in its transaction: refuse it if it changed a copy."""
        if not self.inventory_known:
            if self.observation:
                self.observation.skipped['inventory_unknown'] += 1
            if STRICT or CHECK_EVERY_WRITE:
                raise HTTPException(status_code=503, detail={'code': 'replica_inventory_unknown'})
            return
        if not self.active:
            return
        if not self._checks_every_write():
            if self.observation:
                await self._report(transaction)
            return
        generation = self._generation
        problem = await self._changed(transaction)
        if problem and self._importing.locked():
            # An import committed meanwhile: compare with what it left.
            async with self._importing:
                pass
            if self._generation != generation:
                problem = await self._changed(transaction)
        if problem:
            raise refusal(*problem)

    async def _report(self, transaction):
        if self._snapshot.size > MAX_GUARDED_RECORDS:
            self.observation.skipped['too_large'] += 1
            return
        generation = self._generation
        if self._importing.locked():
            self.observation.skipped['import_in_progress'] += 1
            return
        started = monotonic()
        problem = await self._changed(transaction)
        if self._importing.locked() or self._generation != generation:
            self.observation.skipped['import_in_progress'] += 1
        else:
            self.observation.record(started, problem)

    async def _changed(self, transaction):
        snapshot = self._snapshot
        for row in await _rows(transaction, _NODES_NOW, ids=list(snapshot.nodes)):
            held = snapshot.nodes[row['id']]
            if row['properties'] is None or _digest(_node_kind(row['labels']), row['properties']) != held.digest:
                return held.name, held.owner, held.scopes
        for row in await _rows(transaction, _RELATIONSHIPS_NOW, ids=list(snapshot.relationships)):
            held = snapshot.relationships[row['id']]
            if row['properties'] is None or _digest(row['type'], row['properties']) != held.digest:
                return held.name, held.owner, held.scopes
        links, counts = await self._links_and_counts(transaction, snapshot)
        owner = next(iter(self.owners), None)
        if links > snapshot.local_links:
            return 'a relationship of this computer\'s between two copied records', owner, tuple(
                sorted({scope for record in snapshot.nodes.values() for scope in record.scopes}))
        for label, count in counts.items():
            if count > snapshot.counts.get(label, 0):
                return f'a new {label} of global', owner, ('global',)
        return None

    async def _links_and_counts(self, transaction, snapshot) -> tuple[int, dict[str, int]]:
        links = (await _rows(transaction, _LOCAL_LINKS, ids=list(snapshot.nodes)))[0]['links'] if snapshot.nodes else 0
        counts = (await _rows(transaction, _COUNTS))[0] if self.global_replica else {}
        return links, counts


# The entries that write `global` directly refuse up front, with a clear answer
# (docs/runner-roles-design.md §12, "Write refusal"), before the guard above
# would roll their write back at its commit.

def refuse_if_copy(record: dict | None, name: str) -> None:
    """A write about this record is refused when it is a read-only copy of another computer's."""
    if record and record.get('fuli_replica_owner') is not None:
        raise refusal(name, record['fuli_replica_owner'], tuple(record.get('fuli_replica_scopes') or ('global',)))


def refuse_global_write(store, what: str) -> None:
    """A write of `global` (a new habit or FLA of the person's, a change to the roster) is refused
    while `global` is another computer's (config.global_replica): its owner writes it."""
    if global_is_copy(store):
        guard = store.runtime.driver.replica_guard
        raise refusal(what, next(iter(guard.owners), None) if guard else None, ('global',))


def global_is_copy(store) -> bool:
    """config.global_replica of the store's Provider (a store double without settings is no follower's)."""
    return getattr(getattr(store, 'settings', None), 'global_replica', False) is True
