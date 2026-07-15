import { readFileSync } from 'node:fs';

import {
  applyPreparedJsonSnapshot,
  prepareJsonSnapshot
} from '../storage/import-json.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import {
  cleanupMigrationDestination,
  planMigrationDestination,
  publishMigrationDestination
} from './migration-destination.js';

export function migrateLegacyJson(args, { createStore = (path) => new SqliteStore(path) } = {}) {
  const sourcePath = option(args, '--from');
  const destinationPath = option(args, '--to');
  if (!sourcePath || !destinationPath) throw new Error('migrate requires --from and --to');

  const snapshot = readSnapshot(sourcePath);
  const prepared = prepareJsonSnapshot(snapshot, sourcePath);
  const destination = planMigrationDestination(destinationPath);
  const replace = args.includes('--replace');
  let store;
  let result;
  let failure;
  try {
    store = createStore(destination.storePath);
    result = applyPreparedJsonSnapshot(store, prepared, { replace });
  } catch (error) {
    failure = error;
  } finally {
    try {
      store?.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (!failure) {
    try {
      publishMigrationDestination(destination);
    } catch (error) {
      failure = error;
    }
  }
  try {
    cleanupMigrationDestination(destination);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return result;
}

function readSnapshot(sourcePath) {
  let source;
  try {
    source = readFileSync(sourcePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${sourcePath}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${sourcePath}: ${error.message}`);
  }
}

function option(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
}
