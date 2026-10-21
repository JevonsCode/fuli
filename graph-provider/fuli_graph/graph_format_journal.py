"""The undo journal of a confirmed graph migration (rec#17 D-09 part 2).

Neo4j has no in-process backup, so a record-changing step a person confirms
keeps its own: in the same transaction as the step, every record it may set
properties on gets a FuliDataFormatUndo entry holding those properties as
they were (native Neo4j values, so types survive) and, after the step, a hash
of what the step left; every record it created is listed with the same hash.
Undo restores the earlier values and removes the created records only while
every one of them is still exactly what the step left — the lead-occupation
migration's post-change check. A step that deletes records cannot be undone
this way; it is declared not reversible and needs a whole-graph restore.
"""

from dataclasses import dataclass
import json
import re

from .provider_values import sha256_text

UNDO_LABEL = 'FuliDataFormatUndo'
_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')


@dataclass(frozen=True)
class RecordTouch:
    """Records a step may set properties on: match binds `item`."""
    target: str  # 'node' or 'relationship'
    match: str
    properties: tuple[str, ...]


@dataclass(frozen=True)
class RecordJournal:
    touches: tuple[RecordTouch, ...] = ()
    # ('node', label) or ('relationship', type) the step may create; the step
    # tags what it creates with CREATED_TAG = its apply ID.
    creates: tuple[tuple[str, str], ...] = ()
    reversible: bool = True
    # Why it cannot be undone, said to the person before they confirm.
    irreversible: str | None = None


# Set by a confirmed step on each record it creates, read back and removed
# in the same transaction: the journal lists exactly what this apply created,
# never what another process created meanwhile.
CREATED_TAG = 'fuli_format_apply_id'


@dataclass(frozen=True)
class JournalHeader:
    apply_id: str
    migration_id: str
    from_version: int
    to_version: int
    plan_digest: str
    reversible: bool


def _names(properties) -> tuple[str, ...]:
    for name in properties:
        if not _NAME.match(name):
            raise ValueError(f'unsafe property name {name!r}')
    return tuple(properties)


def _item(target: str) -> str:
    return '(item)' if target == 'node' else '()-[item]->()'


def _hash(value) -> str:
    return sha256_text(json.dumps(value, sort_keys=True, default=str, ensure_ascii=False))


async def _rows(queries, query, **parameters):
    records, _, _ = await queries.execute_query(query, **parameters)
    return records


async def open_journal(queries, migration, *, apply_id, plan_digest, recorded_at) -> dict:
    """Before the step: its header and the earlier values of every record it
    may change. Returns what the step may create that exists already."""
    journal = migration.journal
    await queries.execute_query(
        f'''
        CREATE (:{UNDO_LABEL} {{apply_id: $apply_id, kind: 'apply', migration_id: $migration_id,
          from_version: $from_version, to_version: $to_version, plan_digest: $plan_digest,
          reversible: $reversible, state: 'applied', recorded_at: $recorded_at}})
        ''',
        apply_id=apply_id, migration_id=migration.id, from_version=migration.from_version,
        to_version=migration.to_version, plan_digest=plan_digest,
        reversible=journal.reversible, recorded_at=recorded_at,
    )
    if not journal.reversible:
        return
    for index, touch in enumerate(journal.touches):
        snapshot = ', '.join(f'u.b_{name} = item.{name}' for name in _names(touch.properties))
        await queries.execute_query(
            f'''
            {touch.match}
            WITH DISTINCT item
            CREATE (u:{UNDO_LABEL} {{apply_id: $apply_id, kind: 'record', touch: $touch,
              target: $target, ref: elementId(item)}})
            SET {snapshot}
            ''',
            apply_id=apply_id, touch=index, target=touch.target,
        )


async def _created_by(queries, created, apply_id) -> list[str]:
    """What this apply created of one label or type, untagged on the way."""
    target, name = created
    _names((name,))
    pattern = f'(item:{name})' if target == 'node' else f'()-[item:{name}]->()'
    records = await _rows(
        queries,
        f'MATCH {pattern} WHERE item.{CREATED_TAG} = $apply_id '
        f'REMOVE item.{CREATED_TAG} RETURN elementId(item) AS ref',
        apply_id=apply_id,
    )
    return sorted(record['ref'] for record in records)


async def close_journal(queries, migration, *, apply_id) -> dict:
    """After the step: what it left on each record, and what it created."""
    journal = migration.journal
    if not journal.reversible:
        return {'records': 0, 'created': 0}
    records = 0
    for index, touch in enumerate(journal.touches):
        current = await _touched_values(queries, apply_id, index, touch)
        records += len(current)
        await queries.execute_query(
            'UNWIND $rows AS row MATCH (u) WHERE elementId(u) = row.undo '
            'SET u.after_hash = row.hash',
            rows=[{'undo': row['undo'], 'hash': _hash(row['values'])} for row in current],
        )
    created = 0
    for entry in journal.creates:
        target = entry[0]
        new = await _created_by(queries, entry, apply_id)
        for row in await _created_state(queries, target, new):
            await queries.execute_query(
                f'''
                CREATE (:{UNDO_LABEL} {{apply_id: $apply_id, kind: 'created', target: $target,
                  ref: $ref, after_hash: $after_hash, after_degree: $after_degree}})
                ''',
                apply_id=apply_id, target=target, ref=row['ref'],
                after_hash=_hash(row['properties']), after_degree=row['degree'],
            )
            created += 1
    return {'records': records, 'created': created}


async def _touched_values(queries, apply_id, index, touch):
    properties = _names(touch.properties)
    return await _rows(
        queries,
        f'''
        MATCH (u:{UNDO_LABEL} {{apply_id: $apply_id, kind: 'record', touch: $touch}})
        OPTIONAL MATCH {_item(touch.target)} WHERE elementId(item) = u.ref
        RETURN elementId(u) AS undo, u.after_hash AS after_hash,
               CASE WHEN item IS NULL THEN null
                    ELSE [name IN $properties | item[name]] END AS values
        ''',
        apply_id=apply_id, touch=index, properties=list(properties),
    )


async def _created_state(queries, target, refs):
    degree = 'COUNT { (item)--() }' if target == 'node' else '0'
    return await _rows(
        queries,
        f'''
        UNWIND $refs AS ref
        OPTIONAL MATCH {_item(target)} WHERE elementId(item) = ref
        RETURN ref, CASE WHEN item IS NULL THEN null ELSE properties(item) END AS properties,
               CASE WHEN item IS NULL THEN null ELSE {degree} END AS degree
        ''',
        refs=refs,
    )


def _header(record) -> JournalHeader:
    return JournalHeader(
        record['apply_id'], record['migration_id'], int(record['from_version']),
        int(record['to_version']), record['plan_digest'], bool(record['reversible']),
    )


_HEADERS = f'''
MATCH (u:{UNDO_LABEL} {{kind: 'apply', state: 'applied'}})
RETURN u.apply_id AS apply_id, u.migration_id AS migration_id, u.from_version AS from_version,
       u.to_version AS to_version, u.plan_digest AS plan_digest, u.reversible AS reversible
ORDER BY u.recorded_at DESC
'''


async def applied_journals(queries) -> list[JournalHeader]:
    """Confirmed graph migrations not undone, newest first."""
    return [_header(record) for record in await _rows(queries, _HEADERS)]


async def journal_inventory(queries) -> list[dict]:
    """Every journal in the graph, newest first: its apply, state, entries
    and an estimate of its size (the JSON size of its nodes' properties)."""
    records = await _rows(
        queries,
        f"""
        MATCH (u:{UNDO_LABEL})
        RETURN u.apply_id AS apply_id, u.kind AS kind, u.state AS state,
               u.migration_id AS migration_id, toString(u.recorded_at) AS recorded_at,
               properties(u) AS properties
        """,
    )
    journals = {}
    for record in records:
        journal = journals.setdefault(record['apply_id'], {
            'applyId': record['apply_id'], 'migrationId': None, 'state': None, 'recordedAt': None,
            'entries': 0, 'bytes': 0,
        })
        journal['entries'] += 1
        journal['bytes'] += len(json.dumps(dict(record['properties']), default=str, ensure_ascii=False))
        if record['kind'] == 'apply':
            journal.update(migrationId=record['migration_id'], state=record['state'],
                           recordedAt=record['recorded_at'])
    return sorted(journals.values(), key=lambda journal: journal['recordedAt'] or '', reverse=True)


async def delete_journal(queries, apply_id) -> None:
    await queries.execute_query(
        f'MATCH (u:{UNDO_LABEL} {{apply_id: $apply_id}}) DETACH DELETE u', apply_id=apply_id,
    )


async def lock_journaled(queries, header, migration) -> None:
    """Takes the write lock of every record the undo may change, before it
    checks them, and keeps it to the commit: a business write meanwhile
    waits and lands after the undo instead of being overwritten or deleted.
    A relationship to a locked node waits too, so a node's degree holds."""
    for index, touch in enumerate(migration.journal.touches):
        await queries.execute_query(
            f'''
            MATCH (u:{UNDO_LABEL} {{apply_id: $apply_id, kind: 'record', touch: $touch}})
            MATCH {_item(touch.target)} WHERE elementId(item) = u.ref
            SET item._fuli_format_lock = true
            REMOVE item._fuli_format_lock
            ''',
            apply_id=header.apply_id, touch=index,
        )
    for target in ('node', 'relationship'):
        await queries.execute_query(
            f'''
            MATCH (u:{UNDO_LABEL} {{apply_id: $apply_id, kind: 'created', target: $target}})
            MATCH {_item(target)} WHERE elementId(item) = u.ref
            SET item._fuli_format_lock = true
            REMOVE item._fuli_format_lock
            ''',
            apply_id=header.apply_id, target=target,
        )


async def changed_since(queries, header, migration) -> int:
    """How many journaled records differ from what the step left, or are gone."""
    changed = 0
    for index, touch in enumerate(migration.journal.touches):
        for row in await _touched_values(queries, header.apply_id, index, touch):
            if row['values'] is None or _hash(row['values']) != row['after_hash']:
                changed += 1
    for target in ('relationship', 'node'):
        entries = await _rows(
            queries,
            f'''
            MATCH (u:{UNDO_LABEL} {{apply_id: $apply_id, kind: 'created', target: $target}})
            RETURN u.ref AS ref, u.after_hash AS after_hash, u.after_degree AS after_degree
            ''',
            apply_id=header.apply_id, target=target,
        )
        expected = {entry['ref']: entry for entry in entries}
        for row in await _created_state(queries, target, sorted(expected)):
            entry = expected[row['ref']]
            if row['properties'] is None or _hash(row['properties']) != entry['after_hash'] \
                    or row['degree'] != entry['after_degree']:
                changed += 1
    return changed


async def undo_journal(queries, header, migration, *, undone_at) -> int:
    """Restores the earlier values and removes what the step created; the
    caller has checked changed_since in the same transaction."""
    restored = 0
    for index, touch in enumerate(migration.journal.touches):
        assignments = ', '.join(f'item.{name} = u.b_{name}' for name in _names(touch.properties))
        records = await _rows(
            queries,
            f'''
            MATCH (u:{UNDO_LABEL} {{apply_id: $apply_id, kind: 'record', touch: $touch}})
            MATCH {_item(touch.target)} WHERE elementId(item) = u.ref
            SET {assignments}
            RETURN count(item) AS restored
            ''',
            apply_id=header.apply_id, touch=index,
        )
        restored += int(records[0]['restored']) if records else 0
    await queries.execute_query(
        f'''
        MATCH (u:{UNDO_LABEL} {{apply_id: $apply_id, kind: 'created', target: 'relationship'}})
        MATCH ()-[item]->() WHERE elementId(item) = u.ref
        DELETE item
        ''',
        apply_id=header.apply_id,
    )
    await queries.execute_query(
        f'''
        MATCH (u:{UNDO_LABEL} {{apply_id: $apply_id, kind: 'created', target: 'node'}})
        MATCH (item) WHERE elementId(item) = u.ref
        DETACH DELETE item
        ''',
        apply_id=header.apply_id,
    )
    await queries.execute_query(
        f'''
        MATCH (u:{UNDO_LABEL} {{apply_id: $apply_id, kind: 'apply'}})
        SET u.state = 'rolled_back', u.rolled_back_at = $undone_at
        ''',
        apply_id=header.apply_id, undone_at=undone_at,
    )
    return restored
