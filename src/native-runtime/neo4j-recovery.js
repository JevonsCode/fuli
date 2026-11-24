import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { diagnosticEventLog } from '../diagnostics/event-log.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { planLoad, restoreFailure } from './load-recovery.js';
import { assertManagedNeo4jHome, neo4jAssetFingerprint, uninstallContainers } from './neo4j-asset-state.js';
import {
  acquireNeo4jLifecycleLock, claimLock, lockStartedAt, lockTooRecent, ownIdentity, readLock, runningGraphServices, runtimeInUse, takeOver
} from './neo4j-lifecycle-lock.js';
import { readNeo4jStoreFormats } from './neo4j-store-formats.js';
import {
  diskFree, expiredRecoveryFolders, graphDataFolders, isRecoveryFolder, listNames, recoveryFolder, recoveryRecordPath, recoveryStamp, setAsideInto
} from './recovered-dir.js';
import { inside, moveAside, planned, readJsonOrNull, readManifest, refused } from './recovery-plan.js';

// `fuli graph runtime recover`: brings a native runtime back from an operation
// that was killed part way — a Neo4j switch that left its journal, or an
// update, rollback, uninstall, dump or load that left its lock. It first says
// what it would do (a plan, with a digest); it does it only when asked again
// with that digest, after checking again that nothing uses the runtime and
// that the plan is still the same.
//
// The lock stays until its step, near the end: a start is refused while it is
// there, and a recovery killed part way is planned and finished again. Before
// its first step a recovery makes itself the lock's holder, so a second one is
// refused while it works. What is set aside moves to
// native-runtime/recovered/<time>/ (<time>: when the interrupted operation took
// its lock, so a recovery run again uses the same folder), the descriptor is
// copied there before it is written, an unfinished export is renamed
// `.incomplete`. Two things overwrite or delete: a load is restored over (the
// whole graph, from the copy that very import took before it), and after the
// lock is released old recovered/<time>/ folders that hold no graph data are
// permanently deleted by the clean-up rule (recovered-dir.js), each one listed
// in the plan first. Folders that hold graph data are a person's to delete.
// Abandoning an import whose copy cannot be used (abandonImport) is asked for
// on its own and moves aside only the databases that import wrote. Keeping the
// newer version of an unfinished switch without starting it (keepNewer) is
// asked for on its own too: the way out when neither finishing nor backing out
// gets Neo4j to start.

const JOURNAL = 'neo4j-transaction.json';
const ASSET_OPERATIONS = new Set(['update', 'rollback', 'uninstall']);

// What a recovery would do, or why it will not: { kind, steps, digest, … } or
// { kind: 'refused', reason, … }. An unfinished switch whose newer descriptor
// is in place can be finished or backed out: the plan is one of them ([backOut]
// picks which) and carries the other as [alternative] when it is possible, or
// why not as [alternativeRefused]. [abandonImport]: plan giving up an
// interrupted load whose copy cannot be used instead (planAbandon).
// [keepNewer]: plan keeping the newer version of such a switch as it is.
// A refusal names the runtime directory, for the manual way out its words give.
export async function planNativeRecovery(options) {
  const plan = await planRecovery(options);
  return plan.kind === 'refused' ? { ...plan, runtimeDir: options.paths.nativeRuntimeDir } : plan;
}

async function planRecovery({ paths, backOut = false, abandonImport = false, keepNewer = false, dependencies = {} }) {
  const deps = recoveryDependencies(dependencies);
  const root = paths.nativeRuntimeDir;
  const lock = readLock(root);
  const journal = readJournal(root);
  if (!lock && !journal) return planned('nothing', []);
  if (journal && !journal.value) return refused('unknown_journal');
  const busy = await runtimeInUse({ paths, lock, identity: deps.identity, listProcesses: deps.listProcesses, services: false });
  // A recovery that claimed the lock (applyNativeRecovery) and still runs: the person started another.
  if (busy) return refused(busy.reason === 'holder_running' && recovering(lock) ? 'recovery_running' : busy.reason, { pid: busy.pid });
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
  if (keepNewer && !journal) return refused('keep_newer_unavailable', { operation });
  if (journal) return planJournal(context, journal.value, { backOut, keepNewer });
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

const recovering = lock => lock?.holder?.recovering === true || lock?.holder?.operation === 'recover';

async function planJournal(context, journal, { backOut, keepNewer }) {
  const { paths, stop, end } = context;
  const manifest = readManifest(paths);
  // [operation] says which way the switch went (an update, or a rollback to
  // the kept older programs): the words name the versions and that, never
  // "newer" and "older". A rollback keeps the version number, so a label adds
  // where each side's programs are when the numbers are the same.
  const facts = { operation: journal.action ?? null, phase: journal.phase ?? null,
    fromVersion: journal.previous?.neo4jVersion ?? null, toVersion: journal.next?.neo4jVersion ?? null,
    ...sideLabels(paths.nativeRuntimeDir, journal),
    backupPath: journal.next?.previousNeo4jAsset?.graphBackup ?? null };
  if (manifest === undefined) return refused('manifest_changed', facts);
  const archive = { do: 'archive-journal' };
  if (journal.phase === 'removing-assets') return keepNewer ? refused('keep_newer_unavailable', facts) : planUninstall(context, journal, manifest, facts);
  if (journal.phase !== 'switching' || !isDescriptor(journal.previous) || !isDescriptor(journal.next) || !journal.storeFormats) {
    return refused('unknown_journal', facts);
  }
  const candidate = await candidateOf(paths, journal);
  if (candidate === null) return refused('unmanaged_path', facts);
  // Keeping the newer version is for a switch whose newer descriptor is in place.
  if (keepNewer && !isDeepStrictEqual(manifest, journal.next)) return refused('keep_newer_unavailable', facts);
  if (isDeepStrictEqual(manifest, journal.previous) && journal.backingOut === true) {
    // A back-out killed after it wrote the older descriptor back: the newer
    // Neo4j already opened the store, so whether the older one still opens it
    // is checked now, and the newer descriptor is written back if it does not.
    // An update's programs already in this recovery's folder mean that check
    // passed (they move only after it): it is not made again, and nothing is
    // ever written back that names programs no longer in place.
    const checked = candidateMoved(context, journal);
    return planned('continue_back_out', [...stop, ...(checked ? [] : [{ do: 'check-start', version: journal.previous.neo4jVersion, revert: journal.next }]),
      ...candidate, archive, ...end], facts);
  }
  if (isDeepStrictEqual(manifest, journal.previous)) {
    // The newer descriptor was never written, so the newer Neo4j never ran:
    // undo, as the switch's own rollback would.
    return planned('undo_switch', [...stop, ...candidate, archive, ...end], facts);
  }
  if (!isDeepStrictEqual(manifest, journal.next)) return refused('manifest_changed', facts);
  const blocked = await backOutBlocked(context, journal);
  // Keeping the descriptor in place without a start check archives the
  // journal, and with it any way back to the other side: it is only for when
  // going back is not possible, or was tried and wrote this descriptor back,
  // or was tried and stopped at the store format or the programs' fingerprint
  // (backOutFailed, recorded in the journal by that step) ([keepable]).
  // Otherwise going back comes first. That record no longer counts once the
  // check it failed passes now (backOutBlocked): the programs' fingerprint is
  // checked here always, the store format only when nothing runs.
  const recorded = BACK_OUT_CHECKS.has(journal.backOutFailed) ? journal.backOutFailed : null;
  const checkedNow = !blocked && (recorded === 'assets_changed' || !stop.length);
  const backOutFailed = recorded && !checkedNow ? recorded : null;
  const keepable = Boolean(blocked) || journal.backingOut === true || Boolean(backOutFailed);
  if (backOutFailed) facts.backOutFailed = backOutFailed;
  // The way out when it does not start and going back does not work either:
  // the descriptor and the programs it names agree, so the lock and the
  // journal go and nothing is started; a start that fails afterwards is an
  // ordinary failed start (a new update, or importing the backup from before
  // the upgrade, are open again).
  if (keepNewer) return keepable ? planned('keep_newer', [...stop, archive, ...end], facts) : refused('back_out_available', facts);
  // Finishing keeps the newer version once it starts, answers its health check
  // and leaves the store format as it was — what the switch itself checked
  // after it wrote the descriptor (neo4j-lifecycle.js).
  const finish = planned('finish_switch', [...stop, { do: 'check-start', version: journal.next.neo4jVersion },
    { do: 'check-formats', formats: journal.storeFormats }, archive, ...end], { ...facts, keepable });
  // A back-out stopped by either check records it in the journal (backOutFailed).
  const back = blocked ? null : planned('back_out_switch', [...stop,
    { do: 'check-formats', formats: journal.storeFormats, backOut: true },
    { do: 'check-fingerprint', home: journal.previous.neo4jHome, fingerprint: journal.previous.neo4jAssetFingerprint, backOut: true },
    // Recorded before the older descriptor is written: a back-out killed after
    // that is continued, never mistaken for a switch that never took effect.
    { do: 'mark-backing-out' },
    { do: 'write-manifest', value: journal.previous },
    // The older version must start on this store, or the newer descriptor is written back.
    { do: 'check-start', version: journal.previous.neo4jVersion, revert: journal.next },
    ...candidate, archive, ...end], { ...facts, keepable });
  if (backOut) return back ? { ...back, alternative: finish } : refused(blocked, facts);
  return back ? { ...finish, alternative: back } : { ...finish, alternative: null, alternativeRefused: blocked };
}

// Each side's version, or with the same number on both sides (a rollback to
// the kept programs) its programs' directory ("neo4j-assets/jvs-a-…/neo4j-community-5.26.28")
// and when they were installed: the words say which copy of the programs each
// side is, and when it was installed, or only without that time its directory
// (recovery-plan-text.js, strings.dart).
function sideLabels(root, journal) {
  const { previous, next } = journal;
  if (!isDescriptor(previous) || !isDescriptor(next)) return {};
  const same = previous.neo4jVersion === next.neo4jVersion;
  const label = side => same ? relative(root, side.neo4jHome) : side.neo4jVersion;
  return { fromLabel: label(previous), toLabel: label(next),
    ...(same ? { fromInstalledAt: installedAt(previous.neo4jHome), toInstalledAt: installedAt(next.neo4jHome) } : {}) };
}

// When FULI installed the programs at [home]: when it wrote the receipt in
// their jvs-a-* directory (neo4j-lifecycle.js), else when that directory was
// made; null when neither can be read.
function installedAt(home) {
  const container = dirname(home);
  for (const [path, time] of [[join(container, 'fuli-asset-owner.json'), 'mtimeMs'], [container, 'birthtimeMs']]) {
    try {
      const ms = statSync(path)[time];
      if (ms > 0) return new Date(ms).toISOString();
    } catch { /* not there */ }
  }
  return null;
}

// Whether an update's programs are already in this recovery's folder: a
// back-out moves them only after the older version started on the store.
function candidateMoved({ paths, lock }, journal) {
  if (journal.action !== 'update' || !lock) return false;
  const root = paths.nativeRuntimeDir, container = dirname(journal.next.neo4jHome);
  const folder = recoveryFolder(root, recoveryStamp(lockStartedAt(lock)));
  return !existsSync(container) && existsSync(join(folder, relative(root, container)));
}

// Why going back to the older version is not offered, or null: the checks a
// rollback makes (neo4j-lifecycle.js) need the older programs' fingerprint and
// still-intact programs, and a store format that did not change.
async function backOutBlocked({ paths, deps, stop }, journal) {
  const { neo4jHome, neo4jVersion, neo4jAssetFingerprint } = journal.previous;
  if (!neo4jAssetFingerprint) return 'no_fingerprint';
  try { await assertManagedNeo4jHome(paths, neo4jHome, neo4jVersion); } catch { return 'unmanaged_path'; }
  try { if (await deps.fingerprint(neo4jHome) !== neo4jAssetFingerprint) return 'assets_changed'; } catch { return 'assets_changed'; }
  // Read now when nothing runs; the step reads it again either way. It is read
  // with the programs the descriptor names (neo4j-store-formats.js): when they
  // cannot read it, going back cannot be checked, so it is not offered.
  if (!stop.length) {
    try { if (JSON.stringify(await deps.storeFormats(paths, journal.next)) !== JSON.stringify(journal.storeFormats)) return 'format_changed'; }
    catch { return 'format_unreadable'; }
  }
  return null;
}

// The back-out checks whose failure the journal records (backOutFailed): each
// leaves going back unproven, so keeping the descriptor opens.
const BACK_OUT_CHECKS = new Set(['format_unreadable', 'format_changed', 'assets_changed']);

// An update's candidate programs (its own neo4j-assets/jvs-a-* directory),
// which the older descriptor does not use; a rollback's target is the kept
// older asset, never moved. null when the journal names a directory FULI does not manage.
async function candidateOf(paths, journal) {
  if (journal.action !== 'update') return [];
  try { await assertManagedNeo4jHome(paths, journal.next.neo4jHome, journal.next.neo4jVersion); } catch { return null; }
  const container = dirname(journal.next.neo4jHome);
  const used = [journal.previous.neo4jHome, journal.previous.previousNeo4jAsset?.home].filter(home => typeof home === 'string');
  if (basename(dirname(container)) !== 'neo4j-assets' || used.some(home => holds(container, home))) return [];
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
    if (used.some(home => holds(container, home))) continue;
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
  return made >= lockStartedAt(lock) - 1000
    && listNames(container).every(entry => /^neo4j-community-[0-9.]+$/.test(entry) || /^\.fuli-asset-owner\.json\..+\.tmp$/.test(entry));
}

// Whether the programs at [home] are [container] or inside it. relative()
// compares as the platform does, so on Windows a descriptor recorded with
// another letter case or with forward slashes still counts as in use.
const holds = (container, home) => !relative(container, home) || inside(container, home);

const isDescriptor = value => typeof value?.neo4jHome === 'string' && typeof value.neo4jVersion === 'string';

// Does what the plan with [digest] said — the plan shown, or the alternative
// shown beside it — once nothing has changed since. The lock's token re-enters
// the operations it holds back (stop, start, load); a switch journal whose lock
// is gone, or names no token, gets a lock of the recovery's own first. The
// lock goes near the end; deleting old recovery folders after it never fails
// the recovery (what was not deleted is in the result and the record).
export async function applyNativeRecovery({ paths, digest, backOut = false, abandonImport = false, keepNewer = false, dependencies = {} }) {
  const deps = recoveryDependencies(dependencies);
  const shown = await planNativeRecovery({ paths, backOut, abandonImport, keepNewer, dependencies });
  if (shown.kind === 'refused' || shown.kind === 'nothing') return shown;
  const plan = [shown, shown.alternative].find(candidate => candidate?.digest === digest);
  if (!plan) return refused('plan_changed', { digest: shown.digest });
  const root = paths.nativeRuntimeDir;
  const stamp = recoveryStamp(deps.now());
  const owner = await lockToken(root, deps, { journal: existsSync(join(root, JOURNAL)) });
  if (owner === 'recovery_running') return refused('recovery_running', { pid: readLock(root)?.holder?.pid ?? null });
  if (!owner) return refused('lock_changed');
  const folder = recoveryFolder(root, recoveryStamp(lockStartedAt(readLock(root))));
  const context = { paths, root, deps, owner, folder, startFailure: null };
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
      const record = keepRecord(root, stamp, folder, plan, done, { stoppedAt: step.do, reason });
      throw Object.assign(new Error(`The recovery stopped at ${step.do} (${reason}); what was done is in ${record}, the lock is kept, and running the recovery again continues it.`),
        { cause: error, code: 'recover_step_failed', step: step.do, reason, record, planKind: plan.kind,
          facts: { runtimeDir: root, ...choicesBeside(shown, plan, root, step.backOut === true && BACK_OUT_CHECKS.has(reason) ? reason : null), ...error?.facts } });
    }
  }
  const { alternative, alternativeRefused, ...result } = plan;
  const kept = graphDataFolders(root);
  return { ...result, status: 'recovered', ...(notDeleted.length ? { notDeleted } : {}),
    ...(context.startFailure ? { startFailure: context.startFailure } : {}), ...(kept.length ? { keptGraphData: kept } : {}),
    record: keepRecord(root, stamp, folder, plan, done, null, notDeleted, context.startFailure) };
}

// What else the person can do about the same unfinished switch once [plan]
// stopped, for the words of the refusal: the other way (finish or back out)
// when it is possible, why not when it is not, the versions and the backup.
// [backOutFailed]: the back-out check that failed just now, if that is where it stopped.
function choicesBeside(shown, plan, root, backOutFailed) {
  if (!['finish_switch', 'back_out_switch', 'continue_back_out'].includes(plan.kind)) return {};
  const other = plan === shown ? shown.alternative : shown;
  // A back-out that got as far as recording backingOut (and then wrote the
  // switched-to descriptor back), or that a check stopped just now: keeping
  // that descriptor is open from then on. An older record of a failed check
  // counts only as far as the plan let it (planJournal).
  const journal = readJournal(root)?.value;
  const keepable = plan.keepable === true || journal?.backingOut === true || Boolean(backOutFailed);
  return { operation: plan.operation ?? null, fromVersion: plan.fromVersion, toVersion: plan.toVersion, fromLabel: plan.fromLabel ?? null,
    toLabel: plan.toLabel ?? null, fromInstalledAt: plan.fromInstalledAt ?? null, toInstalledAt: plan.toInstalledAt ?? null,
    backupPath: plan.backupPath ?? null, keepable, backOutFailed: backOutFailed ?? plan.backOutFailed ?? null,
    alternative: other?.kind ?? null, alternativeRefused: plan === shown ? shown.alternativeRefused ?? null : null };
}

// The token the steps run under: the lock's own, which this recovery claims
// first (it becomes the holder, so a second recovery is refused while it runs;
// with a switch journal the lock says `recover` from then on, so one killed
// after the journal was archived is told as the recovery it is), or — when a
// switch journal outlived its lock (a switch whose own rollback failed before
// FULI kept the lock, or a lock a person removed) or the lock names no token —
// one this recovery takes. null when the lock changed meanwhile;
// 'recovery_running' when another recovery claimed it first.
async function lockToken(root, deps, { journal }) {
  const lock = readLock(root);
  if (lock?.owner) {
    const patch = { recovering: true, ...(journal ? { operation: 'recover' } : {}) };
    if (await claimLock(root, lock.owner, { identity: deps.identity, identify: deps.whoami, patch })) return lock.owner;
    return readLock(root)?.owner === lock.owner ? 'recovery_running' : null;
  }
  if (lock && !await takeOver(root, null, deps.identity)) return null;
  try { return (await acquireNeo4jLifecycleLock(root, { operation: 'recover', identify: deps.whoami, details: { recovering: true } })).token; }
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
      catch (error) { throw backOutStopped(step, root, stepFailed('format_unreadable', 'The store format could not be read.', error)); }
      if (JSON.stringify(now) !== JSON.stringify(step.formats)) throw backOutStopped(step, root, stepFailed('format_changed', 'The store format is not the one from before the switch.'));
      return;
    }
    case 'check-fingerprint': {
      let same = false;
      try { same = await deps.fingerprint(step.home) === step.fingerprint; } catch { /* unreadable: changed */ }
      if (!same) throw backOutStopped(step, root, stepFailed('assets_changed', 'The older Neo4j programs changed; backing out is unsafe.'));
      return;
    }
    case 'check-start':
      try { return await deps.checkStart(readJsonFile(paths.nativeRuntimeManifestPath, null), owner); }
      catch (error) {
        // After a restore the graph is back to before the import, and the lock
        // protects nothing: the lock goes, and why Neo4j did not start is in
        // the result for the ordinary failed start that follows.
        // So too after an import that finished: every graph holds its new data.
        if (step.afterRestore || step.afterImport) { context.startFailure = startFailureOf(error, paths); return; }
        // Never a descriptor whose programs are gone.
        if (step.revert && existsSync(step.revert.neo4jHome)) writeManifest(context, step.revert);
        throw stepFailed('start_failed', `Neo4j ${step.version} did not start and answer its health check.`, error, { startFailure: startFailureOf(error, paths) });
      }
    case 'mark-restored': return markLock(context, { restored: true });
    // How abandoning the import judged each graph, before anything moves: a run killed part way finishes the same plan.
    case 'mark-abandoning': return markLock(context, { abandoning: step.abandoning });
    case 'mark-backing-out': {
      const journal = readJsonFile(join(root, JOURNAL), null);
      if (!journal) throw stepFailed('unknown_journal', 'The switch journal is gone.');
      return writeJsonFileAtomic(join(root, JOURNAL), { ...journal, backingOut: true });
    }
    case 'write-manifest': return writeManifest(context, step.value);
    case 'move-aside': {
      if (!inside(root, step.path)) throw stepFailed('unmanaged_path', 'Only what is inside the native runtime is set aside.');
      // Gone when an earlier run moved it.
      return setAsideInto(root, folder, step.path);
    }
    case 'rename':
      if (!existsSync(step.path)) return;
      return rename(step.path, existsSync(step.to) ? `${step.to}-${Date.now()}` : step.to);
    case 'archive-journal': {
      if (!existsSync(join(root, JOURNAL))) return;
      await mkdir(folder, { recursive: true, mode: 0o700 });
      return rename(join(root, JOURNAL), join(folder, JOURNAL));
    }
    case 'restore': {
      // Each graph's state goes into the lock before it is written (graph-import-states.js):
      // a restore killed part way, or failed, is never judged by an earlier attempt's record.
      const mark = (id, state) => markLock(context, { graphStates: { ...readLock(root)?.holder?.graphStates, [id]: state } });
      try { return await deps.restore({ from: step.from, instances: step.instances }, owner, mark); }
      catch (error) {
        // A copy whose checksums do not match can never be restored: abandoning the import is the way on.
        if (error?.copyDamaged) throw stepFailed('restore_point_damaged', `The copy ${step.from} is damaged.`, error, { why: 'damaged', backupPath: step.from });
        // A good copy that would not go back: why, as far as FULI can see, is
        // recorded in the lock, and abandoning the import is open from then on.
        const failure = await restoreFailure(paths, step.from, error, deps);
        await claimLock(root, owner, { identity: deps.identity, identify: deps.whoami, patch: { restoreFailed: failure } }).catch(() => false);
        throw stepFailed('restore_failed', `The graph could not be restored from ${step.from}.`, error, { ...failure, backupPath: step.from });
      }
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

// A back-out's check that failed is recorded in the switch journal
// (backOutFailed, written whole or not at all), so the next plan opens keeping
// the switched-to descriptor: going back cannot be proven, and finishing may
// not start either. Answers [error] to throw.
function backOutStopped(step, root, error) {
  if (!step.backOut) return error;
  const journal = readJsonFile(join(root, JOURNAL), null);
  if (journal) writeJsonFileAtomic(join(root, JOURNAL), { ...journal, backOutFailed: error.reason });
  return error;
}

// Records [patch] in the lock this recovery holds (holder.json).
async function markLock({ root, owner, deps }, patch) {
  if (!await claimLock(root, owner, { identity: deps.identity, identify: deps.whoami, patch })) {
    throw stepFailed('lock_changed', 'The lock changed before this step could be recorded in it.');
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
// of a step that worked (the diagnostics log keeps only what failed), the old
// folders that could not be deleted, and why Neo4j did not start after a
// restore. Answers its path.
function keepRecord(root, stamp, folder, plan, done, stopped = null, notDeleted = [], startFailure = null) {
  const path = recoveryRecordPath(root, stamp);
  writeJsonFileAtomic(path, { version: 1, kind: plan.kind, digest: plan.digest, folder,
    outcome: stopped ? 'stopped' : 'recovered', ...(stopped ?? {}), steps: done, ...(notDeleted.length ? { notDeleted } : {}),
    ...(startFailure ? { startFailure } : {}) });
  return path;
}

// Why a start check failed, for the words: the start's own reason when it
// gave one (a port in use, startup-failure.js), its message, and where the
// databases' logs are.
function startFailureOf(error, paths) {
  const cause = [error, error?.cause, ...(Array.isArray(error?.errors) ? error.errors : [])].find(item => item?.startupFailure);
  return { message: String(error?.message ?? error), ...(cause ? { failure: cause.startupFailure } : {}),
    logs: [paths.nativePersonalDir, paths.nativeWorkspaceDir].filter(Boolean).map(dir => join(dir, 'logs')) };
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
    diskFree,
    log: (paths) => diagnosticEventLog(paths.dataDir),
    now: Date.now,
    // Who this recovery is, as the lock records its holder.
    whoami: ownIdentity,
    ...overrides
  };
}
