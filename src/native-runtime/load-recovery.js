import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readGraphBackupManifest, readVerifiedGraphBackup } from '../backup/graph-backup.js';
import { lockStartedAt } from './neo4j-lifecycle-lock.js';
import { diskSize, GRAPH_STORE_DIRS, listNames, recoveryFolder, recoveryStamp } from './recovered-dir.js';
import { inside, moveAside, planned, readJsonOrNull, readManifest, refused } from './recovery-plan.js';

// The recovery of a load (an import) killed part way (neo4j-recovery.js plans
// the rest): going back to the copy that import took before it, or — asked for
// on its own — abandoning the import.

// File times may be truncated to the second (and a little more on some disks):
// a store counts as written by an import when anything in it changed this
// close to the import's lock, or later.
const WRITE_SLACK_MS = 2000;
const INSTANCES = new Set(['personal', 'workspace']);

// A load overwrites a database, so a killed one may have left it half written.
// The lock names the copy that import took right before it (graph-backup.js);
// the whole graph goes back to it, and an instance that was empty before the
// import is made empty again by moving its half-written store aside. Neo4j
// then starts once; the lock goes either way, since the graph is already back
// (a start that fails is then an ordinary failed start, and the result says
// why it failed). A load whose copy cannot
// be used is refused: FULI does not guess which copy is the right one, and
// abandoning the import is the person's own choice ([abandonImport]).
export async function planLoad(context, abandonImport) {
  const { paths, lock, stop, end } = context;
  const point = lock.holder.restorePoint;
  const facts = { operation: 'load' };
  // The copy is already back (mark-restored): the lock protects nothing any
  // more; what is left is emptying, the start check and the lock.
  if (lock.holder.restored === true) {
    if (abandonImport) return refused('restore_point_usable', facts);
    const steps = [...stop, ...emptiedStores(paths, point), { do: 'check-start', version: readManifest(paths)?.neo4jVersion ?? null, afterRestore: true }];
    return planned('restore_load', [...steps, ...end], { ...facts, restored: true, backupPath: typeof point?.path === 'string' ? point.path : null,
      restorePoint: null, emptied: emptiedOf(point) });
  }
  // Abandoning is only for a copy that cannot be used, so its checksums are checked first.
  const copy = await restoreCopy(paths, point, { verify: abandonImport });
  if (abandonImport) return copy.unusable ? planAbandon(context, point, copy.unusable) : refused('restore_point_usable', { ...facts, backupPath: copy.path ?? null });
  if (copy.unusable) return refused(copy.unusable.reason, { ...facts, ...copy.unusable });
  const steps = [...stop];
  // Once the copy is back, the lock records it (mark-restored): a recovery run
  // again does not import it again, and a start check that fails no longer
  // keeps the lock.
  if (copy.path) steps.push({ do: 'restore', from: copy.path, instances: copy.instances });
  steps.push({ do: 'mark-restored' }, ...emptiedStores(paths, point));
  steps.push({ do: 'check-start', version: readManifest(paths)?.neo4jVersion ?? null, afterRestore: true });
  return planned('restore_load', [...steps, ...end], { ...facts, backupPath: copy.path ?? null,
    restorePoint: copy.path ? { path: copy.path, createdAt: copy.createdAt, instances: copy.instances } : null, emptied: emptiedOf(point) });
}

// The instances that were empty before the import, and their stores still to set aside.
const emptiedOf = point => Array.isArray(point?.loading) && Array.isArray(point.instances) ? point.loading.filter(id => !point.instances.includes(id)) : [];
const emptiedStores = (paths, point) => emptiedOf(point).flatMap(id => storesOf(paths, id).filter(store => existsSync(store)).map(moveAside));

// The copy a load's lock names: { path, createdAt, instances }, { path: null }
// when every instance was empty before, or { unusable: { reason, why, backupPath } }.
// why: 'unrecorded' (the lock names none it can read), 'missing' or 'damaged'.
async function restoreCopy(paths, point, { verify }) {
  if (!point || !Array.isArray(point.loading) || !Array.isArray(point.instances)
    || ![...point.loading, ...point.instances].every(id => INSTANCES.has(id))) return { unusable: { reason: 'restore_point_unknown', why: 'unrecorded' } };
  if (point.path === null) return { path: null };
  if (typeof point.path !== 'string' || !inside(paths.graphBackupDir, point.path) || !basename(point.path).startsWith('before-import-')) {
    return { unusable: { reason: 'restore_point_unknown', why: 'unrecorded' } };
  }
  const damaged = why => ({ unusable: { reason: 'restore_point_damaged', why, backupPath: point.path } });
  if (!existsSync(point.path)) return damaged('missing');
  let manifest;
  try { manifest = await (verify ? readVerifiedGraphBackup : readGraphBackupManifest)(point.path); }
  catch { return damaged('damaged'); }
  const ids = manifest.instances.map(({ id }) => id);
  if (!isDeepStrictEqual([...ids].sort(), [...point.instances].sort())) return damaged('damaged');
  return { path: point.path, createdAt: manifest.createdAt, instances: ids };
}

// Giving up an interrupted load whose own copy cannot be used. Neo4j is
// stopped while an import loads, so a store with anything changed since that
// load took its lock (WRITE_SLACK_MS) was written by it: those instances'
// databases and transaction logs move aside whole (nothing is deleted) and
// those graphs start empty; the others stay as they are. When that cannot be
// told (a file time that cannot be read), the instance moves aside too and the
// plan says so ([unsure]): an older FULI's lock that names no instances means
// every one is looked at. The lock goes. The plan says where each store goes
// and the command that moves it back, and lists the before-import copies an
// import can bring back.
function planAbandon({ paths, lock, stop, end }, point, unusable) {
  const named = Array.isArray(point?.loading) && point.loading.length > 0 && point.loading.every(id => INSTANCES.has(id));
  const since = lockStartedAt(lock) - WRITE_SLACK_MS;
  const written = [], unsure = [], untouched = [], moved = [];
  for (const id of named ? [...new Set(point.loading)] : [...INSTANCES]) {
    const stores = storesOf(paths, id).filter(store => existsSync(store));
    if (!stores.length) continue;
    const touched = Number.isFinite(since) ? writtenSince(stores, since) : null;
    if (touched === false) { untouched.push(id); continue; }
    (touched ? written : unsure).push(id);
    moved.push(...stores);
  }
  const folder = recoveryFolder(paths.nativeRuntimeDir, recoveryStamp(lockStartedAt(lock)));
  return planned('abandon_load', [...stop, ...moved.map(moveAside), ...end], { operation: 'load', copyProblem: unusable.why,
    backupPath: unusable.backupPath ?? null, instances: [...written, ...unsure], written, unsure, untouched, allInstances: !named,
    dataDir: paths.dataDir, folder, moveBack: moved.map(store => ({ from: join(folder, relative(paths.nativeRuntimeDir, store)), to: store })),
    copies: importCopies(paths, unusable.backupPath) });
}

// Whether anything under [paths] changed at [since] or later; null when a time cannot be read.
function writtenSince(paths, since) {
  let unknown = false;
  const visit = (path) => {
    let stat;
    try { stat = lstatSync(path); } catch { unknown = true; return false; }
    if (stat.mtimeMs >= since) return true;
    if (!stat.isDirectory()) return false;
    let names;
    try { names = readdirSync(path); } catch { unknown = true; return false; }
    return names.some(name => visit(join(path, name)));
  };
  if (paths.some(visit)) return true;
  return unknown ? null : false;
}

// An instance's database and its transaction logs (recovered-dir.js GRAPH_STORE_DIRS).
function storesOf(paths, id) {
  const instance = id === 'personal' ? paths.nativePersonalDir : paths.nativeWorkspaceDir;
  return GRAPH_STORE_DIRS.map(parts => join(instance, ...parts, 'neo4j'));
}

// The copies earlier imports took before they started (backups/graph/before-import-*),
// newest first, except [unusable]; each one `fuli graph import` can load back.
function importCopies(paths, unusable) {
  const copies = [];
  for (const name of listNames(paths.graphBackupDir).filter(name => name.startsWith('before-import-')).sort().reverse()) {
    const path = join(paths.graphBackupDir, name);
    const manifest = path === unusable ? null : readJsonOrNull(join(path, 'manifest.json'));
    if (!Array.isArray(manifest?.instances)) continue;
    copies.push({ path, createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null, bytes: diskSize(path),
      instances: manifest.instances.map(({ id }) => id) });
  }
  return copies;
}
