import { createHash } from 'node:crypto';

import { nowIso } from '../models.js';
import { validateLegacySnapshot } from './legacy-snapshot-validation.js';
import { stableJson } from './stable-json.js';

export function importJsonSnapshot(store, snapshot, sourcePath = '<memory>', options = {}) {
  return applyPreparedJsonSnapshot(store, prepareJsonSnapshot(snapshot, sourcePath), options);
}

export function prepareJsonSnapshot(snapshot, sourcePath = '<memory>') {
  validateSourcePath(sourcePath);
  const normalized = validateLegacySnapshot(snapshot);
  const canonicalSnapshot = JSON.parse(stableJson(normalized));
  const contentHash = hashSnapshot(canonicalSnapshot);
  return deepFreeze({ snapshot: deepFreeze(canonicalSnapshot), sourcePath, contentHash });
}

export function applyPreparedJsonSnapshot(store, prepared, { replace = false } = {}) {
  const verified = verifyPreparedSnapshot(prepared);
  let imported = false;

  store.transaction(() => {
    if (store.hasImport(verified.contentHash)) return;
    if (!replace && !isEmptySnapshot(store.exportSnapshot())) {
      throw new Error('Destination snapshot is not empty; pass replace: true to replace it');
    }

    store.importSnapshot(verified.snapshot);
    store.recordImport({
      contentHash: verified.contentHash,
      sourcePath: verified.sourcePath,
      importedAt: nowIso()
    });
    imported = true;
  }, { mode: 'immediate' });

  return { imported, contentHash: verified.contentHash };
}

function verifyPreparedSnapshot(prepared) {
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
    throw new TypeError('Prepared snapshot must be an object');
  }
  const verified = prepareJsonSnapshot(prepared.snapshot, prepared.sourcePath);
  if (prepared.contentHash !== verified.contentHash) {
    throw new Error('Prepared snapshot content hash does not match its snapshot');
  }
  return verified;
}

function hashSnapshot(snapshot) {
  return createHash('sha256').update(stableJson(snapshot)).digest('hex');
}

function validateSourcePath(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw new TypeError('Import source path must be a nonempty string');
  }
}

function isEmptySnapshot(snapshot) {
  return Object.values(snapshot).every((collection) => Array.isArray(collection) && collection.length === 0);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
