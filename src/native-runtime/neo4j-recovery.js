import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readGraphBackupManifest, readVerifiedGraphBackup } from '../backup/graph-backup.js';
import { diagnosticEventLog } from '../diagnostics/event-log.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { assertManagedNeo4jHome, neo4jAssetFingerprint, uninstallContainers } from './neo4j-asset-state.js';
import {
  acquireNeo4jLifecycleLock, lockTooRecent, readLock, runningGraphServices, runtimeInUse, takeOver
} from './neo4j-lifecycle-lock.js';
import { readNeo4jStoreFormats } from './neo4j-store-formats.js';
import {
  diskSize, expiredRecoveryFolders, isRecoveryFolder, listNames, recoveryFolder, recoveryRecordPath, recoveryStamp
} from './recovered-dir.js';

// `fuli graph runtime recover`: brings a native runtime back from an operation
// that was killed part way — a Neo4j switch that left its journal, or an
// update, rollback, uninstall, dump or load that left its lock. It first says
// what it would do (a plan, with a digest); it does it only when asked again
// with that digest, after checking again that nothing uses the runtime and
// that the plan is still the same.
//
// The lock stays until its step, near the end: a start is refused while it is
// there, and a recovery killed part way is planned and finished again. What is
// set aside moves to native-runtime/recovered/<time>/, the descriptor is copied
// there before it is written, an unfinished export is renamed `.incomplete`.
// Two things overwrite or delete: a load is restored over (the whole graph,
// from the copy that very import took before it), and after the lock is
// released old recovered/<time>/ folders are permanently deleted by the
// clean-up rule (recovered-dir.js), each one listed in the plan first.
// Abandoning an import whose copy cannot be used (abandonImport) is asked for
// on its own and moves the half-written databases aside.

const JOURNAL = 'neo4j-transaction.json';
const ASSET_OPERATIONS = new Set(['update', 'rollback', 'uninstall']);
const INSTANCES = new Set(['personal', 'workspace']);

// What a recovery would do, or why it will not: { kind, steps, digest, … } or
// { kind: 'refused', reason, … }. An unfinished switch whose newer descriptor
// is in place can be finished or backed out: the plan is one of them ([backOut]
// picks which) and carries the other as [alternative] when it is possible, or
// why not as [alternativeRefused]. [abandonImport]: plan giving up an
// interrupted load whose copy cannot be used instead (planAbandon).
export async function planNativeRecovery({ paths, backOut = false, abandonImport = false, dependencies = {} }) {
  const deps = recoveryDependencies(dependencies);
  const root = paths.nativeRuntimeDir;
  const lock = readLock(root);
  const journal = readJournal(root);
  if (!lock && !journal) return planned('nothing', []);
  if (journal && !journal.value) return refused('unknown_journal');
  const busy = await runtimeInUse({ paths, lock, identity: deps.identity, listProcesses: deps.listProcesses, services: false });
  if (busy) return refused(busy.reason, { pid: busy.pid });
  if (lock && !lock.holder) {
    if (!journal) return refused('no_holder');
    // An older lock that names nobody may still be held: the age a person's unlock waits for.
    const young = lockTooRecent(lock, deps.now());
    if (young) return refused(young.reason, young);
  }
  // The recorded graph services are stopped first, under the lock's own token,
  // the way a stop would (only processes that are still this runtime's).
  const running = await runningGraphServices(paths, deps.identity);
  if (running.length && !lock?.owner) return refused('cannot_stop_services', { pid: running[0] });
  // Old recovery folders are deleted only once the lock is released: one that
  // cannot be deleted never keeps FULI from starting.
  const context = { paths, deps, lock, stop: running.length ? [{ do: 'stop-services' }] : [],
    end: [{ do: 'release-lock' }, ...expiredRecoveryFolders(root, deps.now()).map(folder => ({ do: 'prune', ...folder }))] };
  const operation = journal ? null : lock.holder.operation;
  if (abandonImport && operation !== 'load') return refused('no_import', { operation });
  if (journal) return planJournal(context, journal.value, backOut);
  if (ASSET_OPERATIONS.has(operation)) return planInterruptedAssets(context);
  if (operation === 'dump') return planned('release_dump', [...context.stop, ...context.end], { operation });
  if (operation === 'load') return planLoad(context, abandonImport);
  // A recovery's own lock (applyNativeRecovery) whose journal is already archived: only the lock is left.
  if (operation === 'recover') return planned('finish_recovery', [...context.stop, ...context.end], { operation });
  // A start's or stop's lock is taken over by the next start by itself.
  return planned('nothing', []);
}

// null without a journal; { value: null } when it is there but empty or unreadable.
function readJournal(root) {
  let text;
  try { text = readFileSync(join(root, JOURNAL), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; return { value: null }; }
  try {
    const value = JSON.parse(text);
    return { value: value && typeof value === 'object' && !Array.isArray(value) ? value : null };
  } catch { return { value: null }; }
}

async function planJournal(context, journal, backOut) {
  const { paths, stop, end } = context;
  const manifest = readManifest(paths);
  const facts = { operation: journal.action ?? null, phase: journal.phase ?? null,
    fromVersion: journal.previous?.neo4jVersion ?? null, toVersion: journal.next?.neo4jVersion ?? null,
    backupPath: journal.next?.previousNeo4jAsset?.graphBackup ?? null };
  if (manifest === undefined) return refused('manifest_changed', facts);
  const archive = { do: 'archive-journal' };
  if (journal.phase === 'removing-assets') return planUninstall(context, journal, manifest, facts);
  if (journal.phase !== 'switching' || !isDescriptor(journal.previous) || !isDescriptor(journal.next) || !journal.storeFormats) {
    return refused('unknown_journal', facts);
  }
  const candidate = await candidateOf(paths, journal);
  if (candidate === null) return refused('unmanaged_path', facts);
  if (isDeepStrictEqual(manifest, journal.previous) && journal.backingOut === true) {
    // A back-out killed after it wrote the older descriptor back: the newer
    // Neo4j already opened the store, so whether the older one still opens it
    // is checked now, and the newer descriptor is written back if it does not.
    return planned('continue_back_out', [...stop, { do: 'check-start', version: journal.previous.neo4jVersion, revert: journal.next },
      ...candidate, archive, ...end], facts);
  }
  if (isDeepStrictEqual(manifest, journal.previous)) {
    // The newer descriptor was never written, so the newer Neo4j never ran:
    // undo, as the switch's own rollback would.
    return planned('undo_switch', [...stop, ...candidate, archive, ...end], facts);
  }
  if (!isDeepStrictEqual(manifest, journal.next)) return refused('manifest_changed', facts);
  // Finishing keeps the newer version once it starts, answers its health check
  // and leaves the store format as it was — what the switch itself checked
  // after it wrote the descriptor (neo4j-lifecycle.js).
  const finish = planned('finish_switch', [...stop, { do: 'check-start', version: journal.next.neo4jVersion },
    { do: 'check-formats', formats: journal.storeFormats }, archive, ...end], facts);
  const blocked = await backOutBlocked(context, journal);
  const back = blocked ? null : planned('back_out_switch', [...stop,
    { do: 'check-formats', formats: journal.storeFormats },
    { do: 'check-fingerprint', home: journal.previous.neo4jHome, fingerprint: journal.previous.neo4jAssetFingerprint },
    // Recorded before the older descriptor is written: a back-out killed after
    // that is continued, never mistaken for a switch that never took effect.
    { do: 'mark-backing-out' },
    { do: 'write-manifest', value: journal.previous },
    // The older version must start on this store, or the newer descriptor is written back.
    { do: 'check-start', version: journal.previous.neo4jVersion, revert: journal.next },
    ...candidate, archive, ...end], facts);
  if (backOut) return back ? { ...back, alternative: finish } : refused(blocked, facts);
  return back ? { ...finish, alternative: back } : { ...finish, alternative: null, alternativeRefused: blocked };
}

// Why going back to the older version is not offered, or null: the checks a
// rollback makes (neo4j-lifecycle.js) need the older programs' fingerprint and
// still-intact programs, and a store format that did not change.
async function backOutBlocked({ paths, deps, stop }, journal) {
  const { neo4jHome, neo4jVersion, neo4jAssetFingerprint } = journal.previous;
  if (!neo4jAssetFingerprint) return 'no_fingerprint';
  try { await assertManagedNeo4jHome(paths, neo4jHome, neo4jVersion); } catch { return 'unmanaged_path'; }
  try { if (await deps.fingerprint(neo4jHome) !== neo4jAssetFingerprint) return 'assets_changed'; } catch { return 'assets_changed'; }
  // Read now when nothing runs; the step reads it again either way.
  if (!stop.length) {
    try { if (JSON.stringify(await deps.storeFormats(paths, journal.next)) !== JSON.stringify(journal.storeFormats)) return 'format_changed'; }
    catch { /* unreadable now: the step decides */ }
  }
  return null;
}

// An update's candidate programs (its own neo4j-assets/jvs-a-* directory),
// which the older descriptor does not use; a rollback's target is the kept
// older asset, never moved. null when the journal names a directory FULI does not manage.
async function candidateOf(paths, journal) {
  if (journal.action !== 'update') return [];
  try { await assertManagedNeo4jHome(paths, journal.next.neo4jHome, journal.next.neo4jVersion); } catch { return null; }
  const container = dirname(journal.next.neo4jHome);
  const used = [journal.previous.neo4jHome, journal.previous.previousNeo4jAsset?.home].filter(home => typeof home === 'string');
  if (basename(dirname(container)) !== 'neo4j-assets' || used.some(home => home === container || home.startsWith(`${container}${sep}`))) return [];
  return existsSync(container) ? [moveAside(container)] : [];
}

// An uninstall killed while it removed the programs: the rest are moved aside,
// each one checked to be a directory FULI manages; a descriptor someone changed
// since (a reinstall) is left alone.
async function planUninstall({ paths, stop, end }, journal, manifest, facts) {
  const { previous } = journal;
  if (!isDescriptor(previous)) return refused('unknown_journal', facts);
  const uninstalled = { ...previous, status: 'uninstalled' };
  if (!isDeepStrictEqual(manifest, previous) && !isDeepStrictEqual(manifest, uninstalled)) return refused('manifest_changed', facts);
  let containers;
  try { containers = await uninstallContainers(paths, previous, { leftovers: true }); }
  catch { return refused('unmanaged_path', facts); }
  const steps = [...stop];
  if (isDeepStrictEqual(manifest, previous)) steps.push({ do: 'write-manifest', value: uninstalled });
  for (const container of containers.filter(path => existsSync(path)).sort()) steps.push(moveAside(container));
  return planned('finish_uninstall', [...steps, { do: 'archive-journal' }, ...end], facts);
}

// An update, rollback or uninstall stopped before its journal: it changed no
// descriptor. Its half-installed programs and unfinished backup are set aside.
async function planInterruptedAssets({ paths, deps, lock, stop, end }) {
  const operation = lock.holder.operation;
  const manifest = readManifest(paths);
  if (manifest === undefined) return refused('manifest_changed', { operation });
  // An uninstall that finished everything but releasing its lock: its programs are gone.
  if (manifest?.status === 'uninstalled') return planned('clear_interrupted', [...stop, ...end], { operation });
  if (manifest?.neo4jHome && manifest.neo4jAssetFingerprint) {
    let same = false;
    try { same = await deps.fingerprint(manifest.neo4jHome) === manifest.neo4jAssetFingerprint; } catch { /* unreadable: changed */ }
    if (!same) return refused('assets_changed', { operation });
  }
  const steps = [...stop];
  const assets = join(paths.nativeRuntimeDir, 'neo4j-assets');
  const used = [manifest?.neo4jHome, manifest?.previousNeo4jAsset?.home].filter(home => typeof home === 'string');
  for (const name of listNames(assets).filter(name => name.startsWith('jvs-a-'))) {
    const container = join(assets, name);
    if (used.some(home => home === container || home.startsWith(`${container}${sep}`))) continue;
    // Only FULI's own asset directories are set aside; anything else is the person's.
    const receipt = readJsonOrNull(join(container, 'fuli-asset-owner.json'));
    const own = receipt?.kind === 'fuli-neo4j-assets' && receipt.id === name;
    if (!own && !(operation === 'update' && interruptedCandidate(container, name, lock))) {
      return refused('unknown_assets', { operation, directory: join('neo4j-assets', name), path: container });
    }
    steps.push(moveAside(container));
  }
  for (const name of listNames(paths.graphBackupDir).filter(name => /^before-neo4j-.+\.partial-[0-9a-f-]+$/.test(name))) {
    steps.push({ do: 'rename', path: join(paths.graphBackupDir, name), to: join(paths.graphBackupDir, `${name.replace(/\.partial-[0-9a-f-]+$/, '')}.incomplete`) });
  }
  return planned('clear_interrupted', [...steps, ...end], { operation });
}

// An update killed between making its candidate directory and writing the
// receipt in it: made while this update held the lock, and holding nothing but
// the programs it was installing (neo4j-lifecycle.js).
function interruptedCandidate(container, name, lock) {
  if (!/^jvs-a-[a-f0-9-]+$/.test(name)) return false;
  let stat;
  try { stat = statSync(container); } catch { return false; }
  const made = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  return made >= lock.since.getTime() - 1000
    && listNames(container).every(entry => /^neo4j-community-[0-9.]+$/.test(entry) || /^\.fuli-asset-owner\.json\..+\.tmp$/.test(entry));
}

// A load overwrites a database, so a killed one may have left it half written.
// The lock names the copy that import took right before it (graph-backup.js);
// the whole graph goes back to it, and an instance that was empty before the
// import is made empty again by moving its half-written store aside. Neo4j
// then starts once and answers before the lock goes. A load whose copy cannot
// be used is refused: FULI does not guess which copy is the right one, and
// abandoning the import is the person's own choice ([abandonImport]).
async function planLoad(context, abandonImport) {
  const { paths, lock, stop, end } = context;
  const point = lock.holder.restorePoint;
  const facts = { operation: 'load' };
  // Abandoning is only for a copy that cannot be used, so its checksums are checked first.
  const copy = await restoreCopy(paths, point, { verify: abandonImport });
  if (abandonImport) return copy.unusable ? planAbandon(context, point, copy.unusable) : refused('restore_point_usable', { ...facts, backupPath: copy.path ?? null });
  if (copy.unusable) return refused(copy.unusable.reason, { ...facts, ...copy.unusable });
  const emptied = point.loading.filter(id => !point.instances.includes(id));
  const steps = [...stop];
  if (copy.path) steps.push({ do: 'restore', from: copy.path, instances: copy.instances });
  for (const id of emptied) for (const store of storesOf(paths, id)) if (existsSync(store)) steps.push(moveAside(store));
  steps.push({ do: 'check-start', version: readManifest(paths)?.neo4jVersion ?? null });
  return planned('restore_load', [...steps, ...end], { ...facts, backupPath: copy.path ?? null,
    restorePoint: copy.path ? { path: copy.path, createdAt: copy.createdAt, instances: copy.instances } : null, emptied });
}

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

// Giving up an interrupted load whose own copy cannot be used: the databases
// it was writing — every instance when an older lock does not say which — move
// aside whole (nothing is deleted), so those graphs start empty, and the lock
// goes. The plan lists the before-import copies an import can bring back.
function planAbandon({ paths, stop, end }, point, unusable) {
  const named = Array.isArray(point?.loading) && point.loading.length > 0 && point.loading.every(id => INSTANCES.has(id));
  const instances = named ? [...new Set(point.loading)] : [...INSTANCES];
  const steps = [...stop];
  for (const id of instances) for (const store of storesOf(paths, id)) if (existsSync(store)) steps.push(moveAside(store));
  return planned('abandon_load', [...steps, ...end], { operation: 'load', copyProblem: unusable.why, backupPath: unusable.backupPath ?? null,
    instances, allInstances: !named, dataDir: paths.dataDir, copies: importCopies(paths, unusable.backupPath) });
}

// An instance's database and its transaction logs.
function storesOf(paths, id) {
  const instance = id === 'personal' ? paths.nativePersonalDir : paths.nativeWorkspaceDir;
  return [join(instance, 'data', 'databases', 'neo4j'), join(instance, 'data', 'transactions', 'neo4j')];
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

const moveAside = path => ({ do: 'move-aside', path, bytes: diskSize(path) });
const isDescriptor = value => typeof value?.neo4jHome === 'string' && typeof value.neo4jVersion === 'string';

// The descriptor; undefined when it cannot be read (it is then changed, not absent).
function readManifest(paths) {
  try { return readJsonFile(paths.nativeRuntimeManifestPath, null); } catch { return undefined; }
}

function readJsonOrNull(path) {
  try { return readJsonFile(path, null); } catch { return null; }
}

function inside(parent, path) {
  const rel = relative(parent, path);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

function planned(kind, steps, facts = {}) {
  return { kind, ...facts, steps, digest: createHash('sha256').update(JSON.stringify({ kind, steps })).digest('hex').slice(0, 16) };
}

function refused(reason, facts = {}) {
  return { kind: 'refused', reason, ...facts };
}

// Does what the plan with [digest] said — the plan shown, or the alternative
// shown beside it — once nothing has changed since. The lock's token re-enters
// the operations it holds back (stop, start, load); a switch journal whose lock
// is gone, or names no token, gets a lock of the recovery's own first. The
// lock goes near the end; deleting old recovery folders after it never fails
// the recovery (what was not deleted is in the result and the record).
export async function applyNativeRecovery({ paths, digest, backOut = false, abandonImport = false, dependencies = {} }) {
  const deps = recoveryDependencies(dependencies);
  const shown = await planNativeRecovery({ paths, backOut, abandonImport, dependencies });
  if (shown.kind === 'refused' || shown.kind === 'nothing') return shown;
  const plan = [shown, shown.alternative].find(candidate => candidate?.digest === digest);
  if (!plan) return refused('plan_changed', { digest: shown.digest });
  const root = paths.nativeRuntimeDir;
  const stamp = recoveryStamp(deps.now());
  const owner = await lockToken(root, deps);
  if (!owner) return refused('lock_changed');
  const context = { paths, root, deps, owner, folder: recoveryFolder(root, stamp) };
  const done = [], notDeleted = [];
  for (const step of plan.steps) {
    try {
      await runStep(step, context);
      done.push({ ...step, at: new Date(deps.now()).toISOString() });
    } catch (error) {
      if (step.do === 'prune') { notDeleted.push({ path: step.path, error: error?.message ?? String(error) }); continue; }
      const reason = error?.reason ?? 'step_failed';
      deps.log(paths).record({ component: 'provider', operation: `native.recover.${step.do}`, outcome: 'failed',
        code: reason, reason: `the recovery step ${step.do} did not finish` });
      const record = keepRecord(root, stamp, plan, done, { stoppedAt: step.do, reason });
      throw Object.assign(new Error(`The recovery stopped at ${step.do} (${reason}); what was done is in ${record}, the lock is kept, and running the recovery again continues it.`),
        { cause: error, code: 'recover_step_failed', step: step.do, reason, record, planKind: plan.kind, facts: error?.facts ?? {} });
    }
  }
  const { alternative, alternativeRefused, ...result } = plan;
  return { ...result, status: 'recovered', ...(notDeleted.length ? { notDeleted } : {}),
    record: keepRecord(root, stamp, plan, done, null, notDeleted) };
}

// The token the steps run under: the lock's own, or — when a switch journal
// outlived its lock (a switch whose own rollback failed before FULI kept the
// lock, or a lock a person removed) or the lock names no token — one this
// recovery takes. null when the lock changed meanwhile.
async function lockToken(root, deps) {
  const lock = readLock(root);
  if (lock?.owner) return lock.owner;
  if (lock && !await takeOver(root, null, deps.identity)) return null;
  try { return (await acquireNeo4jLifecycleLock(root, { operation: 'recover' })).token; }
  catch { return null; }
}

function stepFailed(reason, message, cause, facts) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { reason, ...(facts ? { facts } : {}) });
}

async function runStep(step, context) {
  const { paths, root, owner, deps, folder } = context;
  switch (step.do) {
    case 'stop-services': return deps.stopServices(owner);
    case 'check-formats': {
      let now;
      try { now = await deps.storeFormats(paths, readJsonFile(paths.nativeRuntimeManifestPath, null)); }
      catch (error) { throw stepFailed('format_unreadable', 'The store format could not be read.', error); }
      if (JSON.stringify(now) !== JSON.stringify(step.formats)) throw stepFailed('format_changed', 'The store format is not the one from before the switch.');
      return;
    }
    case 'check-fingerprint': {
      let same = false;
      try { same = await deps.fingerprint(step.home) === step.fingerprint; } catch { /* unreadable: changed */ }
      if (!same) throw stepFailed('assets_changed', 'The older Neo4j programs changed; backing out is unsafe.');
      return;
    }
    case 'check-start':
      try { return await deps.checkStart(readJsonFile(paths.nativeRuntimeManifestPath, null), owner); }
      catch (error) {
        if (step.revert) writeManifest(context, step.revert);
        throw stepFailed('start_failed', `Neo4j ${step.version} did not start and answer its health check.`, error);
      }
    case 'mark-backing-out': {
      const journal = readJsonFile(join(root, JOURNAL), null);
      if (!journal) throw stepFailed('unknown_journal', 'The switch journal is gone.');
      return writeJsonFileAtomic(join(root, JOURNAL), { ...journal, backingOut: true });
    }
    case 'write-manifest': return writeManifest(context, step.value);
    case 'move-aside': {
      if (!inside(root, step.path)) throw stepFailed('unmanaged_path', 'Only what is inside the native runtime is set aside.');
      if (!existsSync(step.path)) return; // moved by an earlier run
      const to = join(folder, relative(root, step.path));
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      return rename(step.path, to);
    }
    case 'rename':
      if (!existsSync(step.path)) return;
      return rename(step.path, existsSync(step.to) ? `${step.to}-${Date.now()}` : step.to);
    case 'archive-journal': {
      if (!existsSync(join(root, JOURNAL))) return;
      await mkdir(folder, { recursive: true, mode: 0o700 });
      return rename(join(root, JOURNAL), join(folder, JOURNAL));
    }
    case 'restore':
      try { return await deps.restore({ from: step.from, instances: step.instances }, owner); }
      catch (error) {
        // A copy whose checksums do not match can never be restored: abandoning the import is the way on.
        if (error?.copyDamaged) throw stepFailed('restore_point_damaged', `The copy ${step.from} is damaged.`, error, { why: 'damaged', backupPath: step.from });
        throw stepFailed('restore_failed', `The graph could not be restored from ${step.from}.`, error);
      }
    case 'prune':
      if (!isRecoveryFolder(root, step.path)) throw stepFailed('unmanaged_path', 'Only an old recovery folder is deleted.');
      return rm(step.path, { recursive: true, force: true });
    case 'release-lock': {
      if (!readLock(root)) return;
      if (!await takeOver(root, owner, deps.identity)) throw stepFailed('lock_changed', 'The lock changed while it was being released.');
      return;
    }
    default: throw new TypeError(`Unknown recovery step: ${step.do}`);
  }
}

// The descriptor as it was is kept in this recovery's folder before it is first written.
function writeManifest({ paths, folder }, value) {
  const kept = join(folder, 'manifest.json');
  if (existsSync(paths.nativeRuntimeManifestPath) && !existsSync(kept)) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    copyFileSync(paths.nativeRuntimeManifestPath, kept);
  }
  writeJsonFileAtomic(paths.nativeRuntimeManifestPath, value);
}

// What this recovery did, step by step, beside what it set aside: the record
// of a step that worked (the diagnostics log keeps only what failed), and the
// old folders that could not be deleted. Answers its path.
function keepRecord(root, stamp, plan, done, stopped = null, notDeleted = []) {
  const path = recoveryRecordPath(root, stamp);
  writeJsonFileAtomic(path, { version: 1, kind: plan.kind, digest: plan.digest, folder: recoveryFolder(root, stamp),
    outcome: stopped ? 'stopped' : 'recovered', ...(stopped ?? {}), steps: done, ...(notDeleted.length ? { notDeleted } : {}) });
  return path;
}

function recoveryDependencies(overrides) {
  return {
    // undefined: the lock module's own check of a holder (PID, start time, command).
    identity: undefined,
    listProcesses: undefined,
    fingerprint: neo4jAssetFingerprint,
    storeFormats: readNeo4jStoreFormats,
    // The native runtime's own (recovery-services.js), given by the CLI and the desktop controller.
    stopServices: async () => { throw new Error('Stopping the recorded services needs the native runtime.'); },
    checkStart: async () => { throw new Error('Starting Neo4j needs the native runtime.'); },
    restore: async () => { throw new Error('A restore needs the native runtime.'); },
    log: (paths) => diagnosticEventLog(paths.dataDir),
    now: Date.now,
    ...overrides
  };
}
