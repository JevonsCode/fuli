import { DataFormatError } from '../../packages/roundtable/src/storage/data-format-error.js';
import { pruneFormatBackups } from './backup-retention.js';
import { GRAPH_LABEL, localStore, localStoresWithEngines, previewMigrations } from './migration-plan.js';
import { readFormatOperations, recordFormatOperations } from './operations-log.js';

// A person's confirmed data format operations on one data directory (rec#17
// D-09 part 2). Callers are `fuli migrate` at an interactive terminal and the
// local console's loopback routes; no MCP or Agent tool reaches this module.
// actor says which ({ entrypoint: 'cli' | 'http' }); presence is not verified.
// - Every operation first resolves a JSON change an interruption left behind
//   (json-format-migration.js), so nothing stays half-committed.
// - apply: the plan is computed again and must have the confirmed digest;
//   the stores' own digests are logged before anything runs, then each store
//   applies its part under its own lock, checking its digest again. There is
//   no transaction across stores: a store that fails stops the rest and keeps
//   its previous state, and what already applied is reported and stays.
//   Confirming the same digest again (an answer that never arrived) runs the
//   logged parts again, which each store answers as already applied, so the
//   retry returns the result instead of a stale preview.
// - rollback undoes one migration; restore replaces a whole store and is
//   never part of apply or rollback.
// Backups are pruned by the retention policy after each change.

export async function applyMigrations({ dataDir, digest, actor, graph, now = () => new Date(), prune = pruneFormatBackups }) {
  recoverInterrupted(dataDir, now);
  const plan = await previewMigrations({ dataDir, graph });
  let stores = plan.stores.map(({ label, store, digest: storeDigest, step }) => ({ label, store,
    digest: storeDigest, migrationId: step.id }));
  if (!plan.digest || plan.digest !== digest) {
    const started = readFormatOperations(dataDir).findLast((event) => event.kind === 'apply_started'
      && event.planDigest === digest);
    if (!started) {
      throw new DataFormatError('data-format', 'data_format_stale_preview', plan.digest
        ? 'The stores no longer match the preview that was confirmed. Nothing was changed; run the preview again '
          + 'and confirm what it shows.'
        : 'Nothing waits for a confirmation now. Nothing was changed.');
    }
    stores = started.stores;
  } else {
    recordFormatOperations(dataDir, [{ kind: 'apply_started', planDigest: digest, stores,
      entrypoint: actor.entrypoint, at: now().toISOString() }]);
  }
  const results = [];
  for (const store of stores) {
    try {
      results.push({ label: store.label, ...await applyStore(dataDir, store, actor, graph) });
    } catch (error) {
      results.push({ label: store.label, store: store.store, status: 'failed', code: error.code ?? 'error',
        message: error.message, migrationId: store.migrationId });
      break;
    }
  }
  const at = now().toISOString();
  recordFormatOperations(dataDir, results.filter((result) => result.status === 'applied').map((result) => ({
    kind: 'applied', store: result.store, label: result.label, migrationId: result.migrationId,
    fromVersion: result.fromVersion, toVersion: result.toVersion, count: result.count,
    backupRef: result.backupRef ?? null, entrypoint: actor.entrypoint, at })));
  const failed = results.some((result) => result.status === 'failed');
  return { status: failed ? (results.length > 1 ? 'partial' : 'failed') : 'applied', results,
    skipped: stores.slice(results.length).map(({ label, migrationId }) => ({ label, migrationId })),
    pruned: pruneQuietly(prune, dataDir) };
}

async function applyStore(dataDir, store, actor, graph) {
  if (store.label === GRAPH_LABEL) {
    const { data_format: _state, ...result } = await graph.apply(store.digest, actor.entrypoint);
    return result;
  }
  const local = localStore(dataDir, store.label);
  return local.engine.apply(local.path, local.format, { digest: store.digest, actor });
}

export async function rollbackMigration({ dataDir, label, migrationId, actor, graph, now = () => new Date(),
  prune = pruneFormatBackups }) {
  recoverInterrupted(dataDir, now);
  let result;
  if (label === GRAPH_LABEL) {
    const { data_format: _state, ...graphResult } = await graph.rollback(migrationId, actor.entrypoint);
    result = graphResult;
  } else {
    const local = requiredStore(dataDir, label);
    result = local.engine.rollback(local.path, local.format, { migrationId, actor });
  }
  recordFormatOperations(dataDir, [{ kind: 'rolled_back', store: result.store, label, migrationId,
    toVersion: result.version, backupRef: result.backupRef ?? null, entrypoint: actor.entrypoint,
    at: now().toISOString() }]);
  return { ...result, label, pruned: pruneQuietly(prune, dataDir) };
}

// What restoring label from backupRef would discard, and the backups to choose from.
export function describeRestore({ dataDir, label, backupRef = null }) {
  const local = requiredStore(dataDir, label);
  return { label, backups: local.engine.backups(local.path),
    impact: backupRef ? local.engine.describeRestore(local.path, local.format, backupRef) : null };
}

// expected: the impact describeRestore showed the person; the store must still match it.
export function restoreStore({ dataDir, label, backupRef, expected, actor, now = () => new Date(),
  prune = pruneFormatBackups }) {
  recoverInterrupted(dataDir, now);
  const local = requiredStore(dataDir, label);
  const result = local.engine.restore(local.path, local.format, { backupRef, expected, actor });
  recordFormatOperations(dataDir, [{ kind: 'restored', store: result.store, label, backupRef,
    toVersion: result.version, safetyBackupRef: result.safetyBackupRef, entrypoint: actor.entrypoint,
    at: now().toISOString() }]);
  return { ...result, label, pruned: pruneQuietly(prune, dataDir) };
}

// Resolves what an interrupted change left behind, store by store; a store
// that cannot be resolved stays as it is and refuses its own changes.
function recoverInterrupted(dataDir, now) {
  const events = [];
  for (const store of localStoresWithEngines(dataDir)) {
    try {
      const resolution = store.engine.recover(store.path, store.format);
      if (resolution) {
        events.push({ kind: 'recovered', store: store.format.store, label: store.label, resolution,
          at: now().toISOString() });
      }
    } catch (error) {
      if (error?.code !== 'data_format_interrupted') throw error;
    }
  }
  recordFormatOperations(dataDir, events);
  return events;
}

function requiredStore(dataDir, label) {
  if (label === GRAPH_LABEL) {
    throw new DataFormatError('graph', 'data_format_graph_restore', 'The graph is restored as a whole from a graph '
      + 'export, offline: fuli graph import. It discards every change made after that export.');
  }
  const local = localStore(dataDir, label);
  if (!local) throw new TypeError(`No FULI store is labelled ${label}`);
  return local;
}

// A retention problem never undoes or hides the operation that preceded it.
function pruneQuietly(prune, dataDir) {
  try {
    return prune(dataDir).pruned;
  } catch (error) {
    return [{ kind: 'prune_failed', reason: error.message }];
  }
}

// The console's port: the same plan and operations `fuli migrate` uses, for
// one data directory and its personal graph.
export function dataFormatMigrations(dataDir, { graph, prune = pruneFormatBackups, now = () => new Date() } = {}) {
  return {
    preview: () => previewMigrations({ dataDir, graph }),
    apply: ({ digest, actor }) => applyMigrations({ dataDir, digest, actor, graph, prune }),
    rollback: ({ label, migrationId, actor }) => rollbackMigration({ dataDir, label, migrationId, actor, graph, prune }),
    // When the console starts: resolve interrupted changes, keep backups within the policy.
    prune: () => {
      try {
        recoverInterrupted(dataDir, now);
      } catch (error) {
        return [{ kind: 'prune_failed', reason: error.message }];
      }
      return pruneQuietly(prune, dataDir);
    }
  };
}
