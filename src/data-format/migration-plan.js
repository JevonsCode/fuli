import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import {
  applyConfirmedSqliteMigration, describeSqliteRestore, previewSqliteMigration, restoreSqliteStore,
  rollbackSqliteMigration, sqliteBackupFiles, undoableSqliteMigrations
} from '../../packages/roundtable/src/storage/database-migration.js';
import {
  applyConfirmedJsonMigration, describeJsonRestore, jsonBackupFiles, previewJsonMigration, recoverJsonFile,
  restoreJsonFile, rollbackJsonMigration, undoableJsonMigrations
} from '../storage/json-format-migration.js';
import { localStoreFiles } from './local-stores.js';

// What a person is asked to confirm for one data directory (rec#17 D-09 part
// 2): every store with a step that waits for a person, by store, step ID,
// record count and sample IDs, never record content. Each store's plan
// carries its own digest, computed by the engine that will apply it; the
// plan's digest binds those. It is not an authorization: applying checks it
// again, store by store, under each store's lock.

export const GRAPH_LABEL = 'graph (personal)';

const ENGINES = Object.freeze({
  sqlite: Object.freeze({ preview: previewSqliteMigration, apply: applyConfirmedSqliteMigration,
    undoable: undoableSqliteMigrations, rollback: rollbackSqliteMigration, describeRestore: describeSqliteRestore,
    restore: restoreSqliteStore, backups: sqliteBackupFiles,
    // A SQLite change commits in one transaction: nothing is left to resolve.
    recover: () => null }),
  json: Object.freeze({ preview: previewJsonMigration, apply: applyConfirmedJsonMigration,
    undoable: undoableJsonMigrations, rollback: rollbackJsonMigration, describeRestore: describeJsonRestore,
    restore: restoreJsonFile, backups: jsonBackupFiles, recover: recoverJsonFile })
});

// The local stores with their engines.
export function localStoresWithEngines(dataDir) {
  return localStoreFiles(dataDir).map((store) => ({ ...store, engine: ENGINES[store.kind] }));
}

// The engine and file of a local store by its label, or null.
export function localStore(dataDir, label) {
  const store = localStoreFiles(dataDir).find((candidate) => candidate.label === label);
  return store ? { ...store, engine: ENGINES[store.kind] } : null;
}

export async function previewMigrations({ dataDir, graph }) {
  const plans = [];
  const undoable = [];
  for (const store of localStoreFiles(dataDir)) {
    const engine = ENGINES[store.kind];
    try {
      const plan = engine.preview(store.path, store.format);
      if (plan) plans.push({ label: store.label, ...plan });
      undoable.push(...engine.undoable(store.path, store.format).map((entry) => ({ label: store.label, ...entry })));
    } catch (error) {
      plans.push({ label: store.label, store: store.format.store, kind: store.kind, action: 'blocked', steps: [],
        reason: `cannot be read for a preview (${error.code ?? error.message})` });
    }
  }
  const remote = graph ? await graph.preview() : { plan: null, undoable: [] };
  if (remote.plan) plans.push({ label: GRAPH_LABEL, ...remote.plan });
  undoable.push(...(remote.undoable ?? []).map((entry) => ({ label: GRAPH_LABEL, ...entry })));
  const stores = plans.filter((plan) => plan.action === 'apply');
  return {
    digest: stores.length ? contentHash(stores.map(({ label, store, digest }) => ({ label, store, digest }))) : null,
    stores,
    blocked: plans.filter((plan) => plan.action !== 'apply'),
    undoable
  };
}
