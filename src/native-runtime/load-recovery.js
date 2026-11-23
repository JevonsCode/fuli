import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readGraphBackupManifest, readVerifiedGraphBackup } from '../backup/graph-backup.js';
import { lockStartedAt, processList } from './neo4j-lifecycle-lock.js';
import { diskSize, GRAPH_STORE_DIRS, listNames, recoveryFolder, recoveryStamp } from './recovered-dir.js';
import { inside, moveAside, planned, readJsonOrNull, readManifest, refused } from './recovery-plan.js';

// The recovery of a load (an import) killed part way (neo4j-recovery.js plans
// the rest): going back to the copy that import took before it, or — asked for
// on its own — abandoning the import.
//
// What the lock records for it: the import's own copy and the instances it
// loads (restorePoint), the instance being written now (loadingInstance) and
// whether that is the import's own rollback (rollingBack); a recovery adds
// that the copy is back (restored), why bringing it back failed
// (restoreFailed), and how abandoning judged each graph (abandoning).

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
  // Abandoning was confirmed and recorded before anything moved: a run killed
  // part way is finished the same way, whichever recovery is asked for.
  if (lock.holder.abandoning) return planAbandon(context, point, null);
  // The copy is already back (mark-restored): the lock protects nothing any
  // more; what is left is emptying, the start check and the lock.
  if (lock.holder.restored === true) {
    if (abandonImport) return refused('restore_point_usable', facts);
    const steps = [...stop, ...emptiedStores(paths, point), { do: 'check-start', version: readManifest(paths)?.neo4jVersion ?? null, afterRestore: true }];
    return planned('restore_load', [...steps, ...end], { ...facts, restored: true, backupPath: typeof point?.path === 'string' ? point.path : null,
      restorePoint: null, emptied: emptiedOf(point) });
  }
  // Abandoning is for a copy that cannot be used (its checksums are checked
  // first), or one that could not be brought back (restoreFailed): that copy
  // stays good, and the plan says so and how to bring it back later.
  const copy = await restoreCopy(paths, point, { verify: abandonImport });
  const failed = lock.holder.restoreFailed ?? null;
  if (abandonImport) {
    if (copy.unusable) return planAbandon(context, point, copy.unusable);
    if (failed && copy.path) return planAbandon(context, point, { why: 'restore_failed', backupPath: copy.path, restoreFailed: failed });
    return refused('restore_point_usable', { ...facts, backupPath: copy.path ?? null });
  }
  if (copy.unusable) return refused(copy.unusable.reason, { ...facts, ...copy.unusable });
  const steps = [...stop];
  // Once the copy is back, the lock records it (mark-restored): a recovery run
  // again does not import it again, and a start check that fails no longer
  // keeps the lock.
  if (copy.path) steps.push({ do: 'restore', from: copy.path, instances: copy.instances });
  steps.push({ do: 'mark-restored' }, ...emptiedStores(paths, point));
  steps.push({ do: 'check-start', version: readManifest(paths)?.neo4jVersion ?? null, afterRestore: true });
  return planned('restore_load', [...steps, ...end], { ...facts, backupPath: copy.path ?? null,
    restorePoint: copy.path ? { path: copy.path, createdAt: copy.createdAt, instances: copy.instances } : null, emptied: emptiedOf(point),
    ...(failed ? { restoreFailed: failed } : {}) });
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

// Giving up an interrupted load whose own copy cannot be used, or could not
// be brought back. Only a graph that may be half written moves aside (its
// database and transaction logs, whole; nothing is deleted) and starts empty;
// the others stay as they are, and the plan says what each one holds (judge).
// How each graph was judged is recorded in the lock before anything moves
// (mark-abandoning): a run killed part way finishes the same plan and is not
// judged again. The lock goes. The plan says where each store goes and the
// command that moves it back, and lists the before-import copies an import
// can bring back — this import's own among them when it is good.
function planAbandon({ paths, lock, stop, end }, point, problem) {
  const recorded = lock.holder.abandoning;
  const judged = recorded ?? judge(paths, lock, point, problem);
  const moving = [...judged.halfWritten ?? [], ...judged.written ?? [], ...judged.unsure ?? []];
  const moved = moving.flatMap(id => storesOf(paths, id).filter(store => existsSync(store)));
  const folder = abandonFolder(paths, lock);
  return planned('abandon_load', [...stop, ...(recorded ? [] : [{ do: 'mark-abandoning', abandoning: judged }]), ...moved.map(moveAside), ...end],
    { operation: 'load', ...judged, instances: moving, dataDir: paths.dataDir, folder,
      moveBack: moved.map(store => ({ from: join(folder, relative(paths.nativeRuntimeDir, store)), to: store })),
      copies: importCopies(paths, judged.copyProblem === 'restore_failed' ? null : judged.backupPath) });
}

const abandonFolder = (paths, lock) => recoveryFolder(paths.nativeRuntimeDir, recoveryStamp(lockStartedAt(lock)));

// What each graph holds when the import is abandoned, from what the lock
// recorded: the instance being written when it stopped (or the one a failed
// restore was writing) is half written; one the import finished before it
// holds this import's new data ([imported]); one it had not reached yet, or
// one a rollback or a restore brought back, holds the data from before the
// import ([beforeImport]); during the import's own rollback, one it had not
// reached may hold either ([unclear]). Instances with no store are left out.
// A lock from before FULI recorded the instance (an older FULI's) is judged by
// file times instead (judgeByTimes).
function judge(paths, lock, point, problem) {
  const { holder } = lock;
  const base = { copyProblem: problem.why, backupPath: problem.backupPath ?? null, ...(problem.restoreFailed ? { restoreFailed: problem.restoreFailed } : {}) };
  const named = Array.isArray(point?.loading) && point.loading.length > 0 && point.loading.every(id => INSTANCES.has(id));
  const current = holder.loadingInstance;
  if (!named || !point.loading.includes(current)) return { ...base, ...judgeByTimes(paths, lock, point, named) };
  const failed = holder.restoreFailed;
  const before = (list, id) => list.includes(id) && list.indexOf(id) < list.indexOf(current);
  const judged = { halfWritten: [], imported: [], beforeImport: [], unclear: [] };
  for (const id of [...new Set(point.loading)]) {
    if (!storesOf(paths, id).some(store => existsSync(store))) continue;
    const kind = failed?.instance === id ? 'halfWritten'
      : failed?.restored?.includes(id) ? 'beforeImport'
        : id === current ? 'halfWritten'
          : holder.rollingBack === true ? (before(point.instances ?? [], id) ? 'beforeImport' : 'unclear')
            : before(point.loading, id) ? 'imported' : 'beforeImport';
    judged[kind].push(id);
  }
  return { ...base, ...judged, inCopy: [...point.instances ?? []] };
}

// An older FULI's load lock: Neo4j is stopped while an import loads, so a
// store with anything changed since that load took its lock (WRITE_SLACK_MS)
// was written by it ([written]); when that cannot be told (a file time that
// cannot be read) the instance moves aside too ([unsure]); the others stay
// ([untouched]). A lock that names no instances means every one is looked at.
// An instance with a store already in this recovery's folder counts as
// written: the rest of it follows.
function judgeByTimes(paths, lock, point, named) {
  const since = lockStartedAt(lock) - WRITE_SLACK_MS;
  const folder = abandonFolder(paths, lock);
  const written = [], unsure = [], untouched = [];
  for (const id of named ? [...new Set(point.loading)] : [...INSTANCES]) {
    const all = storesOf(paths, id);
    const stores = all.filter(store => existsSync(store));
    if (!stores.length) continue;
    const partly = all.some(store => existsSync(join(folder, relative(paths.nativeRuntimeDir, store))));
    const touched = partly ? true : Number.isFinite(since) ? writtenSince(stores, since) : null;
    (touched === false ? untouched : touched ? written : unsure).push(id);
  }
  return { written, unsure, untouched, allInstances: !named };
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

// Why bringing the import's copy back failed, as far as FULI can see, for the
// lock (restoreFailed) and the words: the error, the free space beside the
// space a restore needs (it copies each dump to a staging folder and writes
// the database from it: about twice the copy), the processes still naming a
// graph instance's directory (an orphaned Neo4j holding the store), and which
// instance it was writing and which it brought back before (recovery-services.js).
export async function restoreFailure(paths, from, error, { diskFree, listProcesses = processList } = {}) {
  let freeBytes = null;
  try { freeBytes = await diskFree(paths.dataDir); } catch { /* unknown */ }
  const dirs = [paths.nativePersonalDir, paths.nativeWorkspaceDir].filter(Boolean);
  const processes = await listProcesses().catch(() => null) ?? [];
  const holders = processes.filter(({ pid, command }) => pid !== process.pid && dirs.some(dir => command.includes(dir)))
    .map(({ pid, command }) => ({ pid, command: command.length > 160 ? `${command.slice(0, 157)}...` : command }));
  return { detail: String(error?.message ?? error), freeBytes, neededBytes: 2 * diskSize(from), holders,
    ...(typeof error?.instance === 'string' ? { instance: error.instance, restored: [...error.restored ?? []] } : {}) };
}
