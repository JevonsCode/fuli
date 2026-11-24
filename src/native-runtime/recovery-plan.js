import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';

import { readJsonFile } from '../storage/json-file.js';
import { diskSize } from './recovered-dir.js';

// The pieces every recovery plan is made of (neo4j-recovery.js for a switch or
// an asset operation, load-recovery.js for a load): a plan or a refusal, the
// step that sets a directory aside, and the reads they all make first.

export const moveAside = path => ({ do: 'move-aside', path, bytes: diskSize(path) });

// The descriptor; undefined when it cannot be read (it is then changed, not absent).
export function readManifest(paths) {
  try { return readJsonFile(paths.nativeRuntimeManifestPath, null); } catch { return undefined; }
}

export function readJsonOrNull(path) {
  try { return readJsonFile(path, null); } catch { return null; }
}

export function inside(parent, path) {
  const rel = relative(parent, path);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

export function planned(kind, steps, facts = {}) {
  return { kind, ...facts, steps, digest: createHash('sha256').update(JSON.stringify({ kind, steps })).digest('hex').slice(0, 16) };
}

export function refused(reason, facts = {}) {
  return { kind: 'refused', reason, ...facts };
}
