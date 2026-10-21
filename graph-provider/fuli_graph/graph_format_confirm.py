"""A person's confirmation of a graph migration (rec#17 D-09 part 2).

- preview: the first step that waits for a person, the records it changes by
  ID only, and a digest of exactly that plan. The digest binds the plan; it is
  not an authorization. Read-only.
- apply: under the graph's migration lock, in one transaction, the plan is
  computed again (a different digest stops it: preview again), the undo
  journal records what the step may change, the step runs, and the ledger
  event and the new version are written. An interruption changes nothing.
- rollback: undoes the latest confirmed step from its journal, only while
  every record it changed is still what it left, and moves the version back.
  A whole-graph restore is a separate, offline operation (fuli graph import).

The provider exposes apply and rollback only to the human-review channel;
no Agent tool reaches them.

Every provider's business writes and the lead-occupation CLI pass the graph
writer fence (graph_format.writer_fence), so none of them commits while an
apply or undo runs. Writers outside FULI (a raw Neo4j client, cypher-shell,
another tool on the same database) do not: keep them stopped while a
migration is applied or undone. The scope re-check before the step only
catches what they added before it, not writes during it.
"""

import asyncio
from contextlib import asynccontextmanager
import json
from uuid import uuid4

from .graph_format import (
    LOCK_WAIT_SECONDS,
    GraphFormatUnavailable,
    MigrationRun,
    decide_graph_step,
    ledger_step,
)
from .graph_format_journal import (
    applied_journals,
    changed_since,
    close_journal,
    delete_journal,
    journal_inventory,
    lock_journaled,
    open_journal,
    undo_journal,
)
from .graph_format_ledger import (
    hold_graph_identity,
    lower_graph_version,
    read_graph_ledger,
    record_graph_event,
    stamp_graph_version,
)
from .graph_format_migrations import GRAPH_FORMAT_VERSION, GRAPH_MIGRATIONS
from .provider_values import now_utc, sha256_text

SAMPLE_SIZE = 5
_MIGRATIONS = {migration.id: migration for migration in GRAPH_MIGRATIONS}


def _scope_digest(keys) -> str:
    return sha256_text(json.dumps(list(keys), ensure_ascii=False, separators=(',', ':')))


def _digest(plan: dict) -> str:
    return sha256_text(json.dumps(plan, sort_keys=True, ensure_ascii=False, separators=(',', ':')))


async def preview_graph_migration(driver, settings) -> dict | None:
    """driver reads only (the read-only handle, or the apply transaction)."""
    ledger = await read_graph_ledger(driver)
    base = {'store': 'graph', 'kind': 'neo4j', 'version': ledger.version,
            'target': GRAPH_FORMAT_VERSION}
    if ledger.version is not None and ledger.version > GRAPH_FORMAT_VERSION:
        return {**base, 'action': 'blocked', 'steps': [],
                'reason': f'written by a newer FULI (format {ledger.version}); upgrade FULI or '
                          'restore a graph backup'}
    started = [mid for mid, status in ledger.latest.items() if status == 'started']
    if started:
        return {**base, 'action': 'blocked', 'steps': started,
                'reason': 'a migration started and did not finish; restore a graph backup'}
    automatic = []
    for migration in GRAPH_MIGRATIONS:
        if migration.to_version <= (ledger.version or 0):
            continue
        decision = await decide_graph_step(driver, settings, migration)
        if decision.state == 'automatic':
            automatic.append(migration.id)
            continue
        if decision.state == 'detected':
            continue
        if migration.automatic:
            return {**base, 'action': 'blocked', 'steps': [migration.id],
                    'reason': f'{decision.detail}; FULI cannot apply this itself: repair the graph '
                              'or restore a graph backup'}
        keys = list(decision.keys)
        plan = {**base, 'action': 'apply', 'automatic': automatic, 'step': {
            'id': migration.id, 'summary': migration.summary, 'kind': migration.kind,
            'fromVersion': migration.from_version, 'toVersion': migration.to_version,
            'count': len(keys), 'sampleIds': keys[:SAMPLE_SIZE],
            'scopeDigest': _scope_digest(keys),
        }, 'undo': 'available' if migration.journal.reversible else 'restore_only'}
        if not migration.journal.reversible:
            deleted = sum(1 for key in keys if key.startswith('delete:'))
            plan['warning'] = f'{migration.journal.irreversible} ({deleted} records deleted)'
        return {**plan, 'digest': _digest(plan)}
    return None


class _InTransaction:
    """The execute_query/transaction surface the format code uses, bound to
    one open transaction, so a confirmed step is one unit of work."""

    def __init__(self, transaction):
        self._transaction = transaction

    async def execute_query(self, query, routing_=None, **parameters):
        result = await self._transaction.run(query, **parameters)
        return [record async for record in result], None, None

    @asynccontextmanager
    async def transaction(self):
        yield self

    async def run(self, query, **parameters):
        return await self._transaction.run(query, **parameters)


def _unavailable(code, message, steps=()):
    return GraphFormatUnavailable(code, message, tuple(steps))


async def _locked(driver, settings, now, lock_wait_seconds, sleep, operation):
    run = MigrationRun.start(driver, settings, now)
    if not await run.acquire(lock_wait_seconds, sleep):
        raise _unavailable('data_format_locked', 'Another FULI process is migrating this graph. '
                           'Nothing was changed; try again once it has finished.')
    try:
        async with driver.transaction() as transaction:
            return await operation(run, _InTransaction(transaction))
    finally:
        await run.release()


async def apply_graph_migration(
    driver, settings, *, digest: str, actor: dict, now=now_utc,
    lock_wait_seconds=LOCK_WAIT_SECONDS, sleep=asyncio.sleep, apply_id: str | None = None,
    barrier=None,
) -> dict:
    """driver is the unguarded maintenance handle. barrier: awaited after the
    snapshot, before the step runs (a test seam for other writers)."""
    apply_id = apply_id or str(uuid4())

    async def operation(run, queries):
        # No provider's business write commits from here to this commit.
        await hold_graph_identity(queries)
        plan = await preview_graph_migration(queries, settings)
        if not plan or plan.get('action') != 'apply' or plan['digest'] != digest:
            journals = await applied_journals(queries)
            earlier = next((j for j in journals if j.plan_digest == digest), None)
            if earlier:
                return {'status': 'already_applied', 'store': 'graph',
                        'migrationId': earlier.migration_id, 'applyId': earlier.apply_id}
            raise _unavailable(
                'data_format_stale_preview',
                'The graph no longer matches the preview that was confirmed. Nothing was changed; '
                'run the preview again and confirm what it shows.',
                [plan['step']['id']] if plan and plan.get('step') else [],
            )
        if plan['automatic']:
            raise _unavailable(
                'data_format_blocked', 'Automatic steps must run first; restart the FULI provider, '
                'then preview again. Nothing was changed.', plan['automatic'],
            )
        migration = _MIGRATIONS[plan['step']['id']]
        await open_journal(queries, migration, apply_id=apply_id, plan_digest=digest,
                           recorded_at=now())
        if barrier:
            await barrier()
        # The step runs on exactly the records the person confirmed and the
        # journal holds: anything new since the snapshot (a writer outside
        # FULI's fence) makes the whole transaction roll back.
        if _scope_digest(await migration.pending(queries, settings)) != plan['step']['scopeDigest']:
            raise _unavailable(
                'data_format_stale_preview',
                'The graph changed while the migration was starting. Nothing was changed; run the '
                'preview again and confirm what it shows.', [migration.id],
            )
        await migration.apply(queries, settings, apply_id=apply_id)
        if await migration.pending(queries, settings):
            raise RuntimeError(f'{migration.id} left records it should have changed')
        journaled = await close_journal(queries, migration, apply_id=apply_id)
        undo = (f'undo journal {apply_id}' if migration.journal.reversible
                else 'not reversible: restore a graph export (fuli graph import)')
        await record_graph_event(
            queries, ledger_step(migration), 'applied', owner=run.owner, now=now,
            backup_ref=f'undo journal {apply_id}' if migration.journal.reversible else None,
            detail=(f'confirmed locally ({actor["entrypoint"]}, presence unverified): '
                    f'{plan["step"]["count"]} records; {journaled["records"]} journaled, '
                    f'{journaled["created"]} created; {undo}'),
        )
        await stamp_graph_version(queries, migration.to_version, owner=run.owner, now=now,
                                  until=run.until())
        return {'status': 'applied', 'store': 'graph', 'migrationId': migration.id,
                'applyId': apply_id, 'count': plan['step']['count'],
                'fromVersion': migration.from_version, 'toVersion': migration.to_version,
                'backupRef': f'undo journal {apply_id}' if migration.journal.reversible else None}

    return await _locked(driver, settings, now, lock_wait_seconds, sleep, operation)


async def prune_graph_journals(
    driver, settings, *, keep: int, max_bytes: int, dry_run: bool = False, now=now_utc,
    lock_wait_seconds=LOCK_WAIT_SECONDS, sleep=asyncio.sleep,
) -> dict:
    """Keeps undo journals within the same soft target as the file backups:
    the newest `keep` and at most `max_bytes` in all. The journal of the
    confirmed step that can be undone now is never pruned, whatever the
    target; journals of undone steps go first. Under the migration lock, so
    no apply or undo runs meanwhile; a journal still being written belongs
    to an uncommitted apply and is not seen. Returns what was (or would be)
    pruned: apply ID, step, size and reason only."""

    async def operation(_run, queries):
        journals = await journal_inventory(queries)
        undoable = next((j['applyId'] for j in journals if j['state'] == 'applied'), None)
        others = [j for j in journals if j['applyId'] != undoable]
        # Undone or unfinished journals first, then the oldest applied ones.
        others.sort(key=lambda j: (j['state'] == 'applied', j['recordedAt'] or ''), reverse=True)
        over = others[keep:]
        pruned = [{**j, 'reason': f'more than {keep} undo journals'} for j in over]
        kept = [j for j in journals if j not in over]
        total = sum(j['bytes'] for j in kept)
        for journal in sorted((j for j in kept if j['applyId'] != undoable),
                              key=lambda j: (j['state'] == 'applied', j['recordedAt'] or '')):
            if total <= max_bytes:
                break
            pruned.append({**journal, 'reason': f'undo journals use more than {max_bytes} bytes'})
            total -= journal['bytes']
        if not dry_run:
            for journal in pruned:
                await delete_journal(queries, journal['applyId'])
        return {'pruned': [{'store': 'graph', 'applyId': j['applyId'], 'migrationId': j['migrationId'],
                            'state': j['state'], 'bytes': j['bytes'], 'reason': j['reason']} for j in pruned],
                'kept': len(journals) - len(pruned), 'protected': undoable}

    return await _locked(driver, settings, now, lock_wait_seconds, sleep, operation)


async def undoable_graph_migrations(driver) -> list[dict]:
    return [{'store': 'graph', 'kind': 'neo4j', 'applyId': j.apply_id,
             'migrationId': j.migration_id, 'fromVersion': j.from_version,
             'toVersion': j.to_version, 'reversible': j.reversible}
            for j in await applied_journals(driver)][:1]


async def rollback_graph_migration(
    driver, settings, *, migration_id: str, actor: dict, now=now_utc,
    lock_wait_seconds=LOCK_WAIT_SECONDS, sleep=asyncio.sleep, barrier=None,
) -> dict:
    """barrier: awaited once the records are locked, before they are checked
    (a test seam for concurrent business writes)."""
    async def operation(run, queries):
        journals = await applied_journals(queries)
        header = journals[0] if journals else None
        if not header or header.migration_id != migration_id:
            raise _unavailable(
                'data_format_nothing_to_undo',
                f'The graph has no confirmed migration {migration_id} left to undo'
                + (f'; the latest is {header.migration_id}.' if header else '.'),
            )
        migration = _MIGRATIONS[migration_id]
        if not header.reversible:
            raise _unavailable(
                'data_format_undo_blocked',
                f'{migration_id} deleted records it could not keep, so it cannot be undone. '
                'Only restoring a whole graph export (fuli graph import) brings them back, '
                'and that discards every later change. Nothing was changed.', [migration_id],
            )
        ledger = await read_graph_ledger(queries)
        version = ledger.version or 0
        if version > GRAPH_FORMAT_VERSION:
            # A newer FULI moved the graph on; moving it back is not this FULI's call.
            raise _unavailable(
                'data_format_blocked',
                f'The graph uses data format {version}, newer than this FULI supports '
                f'({GRAPH_FORMAT_VERSION}). Nothing was changed.', [migration_id],
            )
        # Later schema steps and record steps found already in effect changed
        # no record; a later confirmed step did, and is undone first.
        later = [m for m in GRAPH_MIGRATIONS if header.to_version < m.to_version <= version]
        if version < header.to_version or any(
            not m.automatic and ledger.latest.get(m.id) != 'baseline_detected' for m in later
        ):
            raise _unavailable(
                'data_format_undo_blocked',
                f'A later graph migration changed records after {migration_id}; undo that one '
                'first. Nothing was changed.', [migration_id],
            )
        await lock_journaled(queries, header, migration)
        # Records first, then the identity: a writer holds its records before
        # it reaches the fence, so the two never wait on each other in turn.
        await hold_graph_identity(queries)
        if barrier:
            await barrier()
        changed = await changed_since(queries, header, migration)
        if changed:
            raise _unavailable(
                'data_format_changed_since',
                f'{changed} records changed after migration {migration_id}, so undoing it would '
                'overwrite those changes. Nothing was changed. Restoring a whole graph export '
                '(fuli graph import) would discard every change made since; that is a '
                'separate operation.', [migration_id],
            )
        restored = await undo_journal(queries, header, migration, undone_at=now())
        await record_graph_event(
            queries, ledger_step(migration), 'rolled_back', owner=run.owner, now=now,
            detail=(f'undone locally ({actor["entrypoint"]}, presence unverified): {restored} '
                    f'records restored from undo journal {header.apply_id}'),
        )
        await lower_graph_version(queries, header.from_version, owner=run.owner, now=now,
                                  current=version)
        return {'status': 'rolled_back', 'store': 'graph', 'migrationId': migration_id,
                'applyId': header.apply_id, 'rows': restored, 'version': header.from_version}

    return await _locked(driver, settings, now, lock_wait_seconds, sleep, operation)
