import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readGraphBackupManifest } from '../backup/graph-backup.js';
import { diagnosticEventLog } from '../diagnostics/event-log.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { assetContainer, managedNeo4jContainers, neo4jAssetFingerprint } from './neo4j-asset-state.js';
import { lifecycleLockOf, releaseLifecycleLock, runtimeInUse } from './neo4j-lifecycle-lock.js';
import { readNeo4jStoreFormats } from './neo4j-store-formats.js';
import { processMatchesCommand } from './process-identity.js';
import { processState } from '../local-runtime/processes.js';

// `fuli graph runtime recover`: brings a native runtime back from an operation
// that was killed part way — a Neo4j switch that left its journal, or an
// update, rollback, uninstall, dump or load that left its lock. It first says
// what it would do (a plan, with a digest); it does it only when asked again
// with that digest, after checking again that nothing uses the runtime and
// that the plan is still the same. Every step can run twice: a recovery killed
// part way is planned and finished again. Nothing is deleted that can be moved
// aside instead: half-installed programs and the journal go to
// native-runtime/recovered/, an unfinished export is renamed `.incomplete`.
// Only an uninstall's program files are removed, which is what it was doing.

const JOURNAL = 'neo4j-transaction.json';
const RECOVERED = 'recovered';
const ASSET_OPERATIONS = new Set(['update', 'rollback', 'uninstall']);

// What a recovery would do, or why it will not: { kind, steps, digest, … } or { kind: 'refused', reason, … }.
export async function planNativeRecovery({ paths, backOut = false, dependencies = {} }) {
  const deps = recoveryDependencies(dependencies);
  const root = paths.nativeRuntimeDir;
  const lock = lifecycleLockOf(root);
  const journal = existsSync(join(root, JOURNAL)) ? readJsonFile(join(root, JOURNAL), null) : null;
  if (!lock && !journal) return planned('nothing', []);
  const busy = await runtimeInUse({ paths, lock, identity: deps.identity, listProcesses: deps.listProcesses, services: false });
  if (busy) return refused(busy.reason, { pid: busy.pid });
  if (lock && !lock.holder && !journal) return refused('no_holder');
  // The recorded graph services are stopped first, under the lock's own token,
  // the way a stop would (only processes that are still this runtime's).
  const running = await recordedServicesRunning(paths, deps);
  if (running.length && !lock?.owner) return refused('cannot_stop_services', { pid: running[0] });
  const stop = running.length ? [{ do: 'stop-services' }] : [];
  if (journal) return planJournal({ paths, journal, stop, backOut, deps });
  const operation = lock.holder.operation;
  if (ASSET_OPERATIONS.has(operation)) return planInterruptedAssets({ paths, lock, stop, deps });
  if (operation === 'dump') return planned('release_dump', [...stop, { do: 'release-lock' }], { operation });
  if (operation === 'load') return planLoad({ paths, lock, stop });
  // A start's or stop's lock is taken over by the next start by itself.
  return planned('nothing', []);
}

async function planJournal({ paths, journal, stop, backOut, deps }) {
  const root = paths.nativeRuntimeDir;
  const manifest = readJsonFile(paths.nativeRuntimeManifestPath, null);
  const archive = { do: 'archive-journal', to: join(RECOVERED, `neo4j-transaction-${Math.trunc(statSync(join(root, JOURNAL)).mtimeMs)}.json`) };
  const facts = { operation: journal.action ?? null, phase: journal.phase ?? null,
    fromVersion: journal.previous?.neo4jVersion ?? null, toVersion: journal.next?.neo4jVersion ?? null,
    backupPath: journal.next?.previousNeo4jAsset?.graphBackup ?? null };
  if (journal.phase === 'removing-assets') {
    const previous = journal.previous ?? {};
    const steps = [...stop];
    if (manifest?.status !== 'uninstalled') steps.push({ do: 'write-manifest', value: { ...previous, status: 'uninstalled' } });
    for (const container of await uninstallContainers(paths, previous)) steps.push({ do: 'remove', path: container });
    return planned('finish_uninstall', [...steps, archive, { do: 'release-lock' }], facts);
  }
  if (journal.phase !== 'switching' || !journal.previous || !journal.next) return refused('unknown_journal', facts);
  const candidate = candidateOf(paths, journal);
  if (isDeepStrictEqual(manifest, journal.previous)) {
    // The newer descriptor was never written: undo, as the switch's own rollback would.
    return planned('undo_switch', [...stop, ...candidate, archive, { do: 'release-lock' }], facts);
  }
  if (!isDeepStrictEqual(manifest, journal.next)) return refused('manifest_changed', facts);
  if (!backOut) return planned('finish_switch', [...stop, archive, { do: 'release-lock' }], facts);
  // Backing out writes the older descriptor back: only when the store format is
  // still the one the switch started from and the older programs are intact,
  // the checks a rollback makes (neo4j-lifecycle.js).
  return planned('back_out_switch', [...stop, { do: 'check-formats', descriptor: journal.next, formats: journal.storeFormats ?? null },
    { do: 'check-fingerprint', home: journal.previous.neo4jHome, fingerprint: journal.previous.neo4jAssetFingerprint ?? null },
    { do: 'write-manifest', value: journal.previous }, ...candidate, archive, { do: 'release-lock' }], facts);
}

// An update's candidate programs (its own neo4j-assets/jvs-a-* directory),
// which the older descriptor does not use; a rollback's target is the kept
// older asset, never moved.
function candidateOf(paths, journal) {
  if (journal.action !== 'update' || typeof journal.next?.neo4jHome !== 'string') return [];
  const container = assetContainer(paths, journal.next.neo4jHome);
  const assets = join(paths.nativeRuntimeDir, 'neo4j-assets');
  const used = [journal.previous.neo4jHome, journal.previous.previousNeo4jAsset?.home].filter(home => typeof home === 'string');
  if (!container.startsWith(`${assets}${sep}`) || used.some(home => home === container || home.startsWith(`${container}${sep}`))) return [];
  return [{ do: 'move-aside', path: container, to: join(RECOVERED, basename(container)) }];
}

async function uninstallContainers(paths, previous) {
  const assets = [{ home: previous.neo4jHome, version: previous.neo4jVersion }, previous.previousNeo4jAsset]
    .filter(asset => typeof asset?.home === 'string' && typeof asset.version === 'string');
  const versions = [...new Set(assets.map(({ version }) => version))];
  const containers = new Set([...versions.map(version => join(paths.nativeRuntimeDir, `neo4j-community-${version}`)),
    ...await managedNeo4jContainers(paths, versions), ...assets.map(({ home }) => assetContainer(paths, home))]);
  return [...containers].filter(container => existsSync(container)).sort();
}

// An update, rollback or uninstall stopped before its journal: it changed no
// descriptor. Its half-installed programs and unfinished backup are set aside.
async function planInterruptedAssets({ paths, lock, stop, deps }) {
  const manifest = readJsonFile(paths.nativeRuntimeManifestPath, null);
  if (manifest?.neo4jHome && manifest.neo4jAssetFingerprint
      && await deps.fingerprint(manifest.neo4jHome) !== manifest.neo4jAssetFingerprint) {
    return refused('assets_changed', { operation: lock.holder.operation });
  }
  const steps = [...stop];
  const assets = join(paths.nativeRuntimeDir, 'neo4j-assets');
  const used = [manifest?.neo4jHome, manifest?.previousNeo4jAsset?.home].filter(home => typeof home === 'string');
  for (const name of listNames(assets).filter(name => name.startsWith('jvs-a-'))) {
    const container = join(assets, name);
    if (used.some(home => home === container || home.startsWith(`${container}${sep}`))) continue;
    // Only FULI's own asset directories are set aside; anything else is the person's.
    const receipt = readJsonFile(join(container, 'fuli-asset-owner.json'), null);
    if (receipt?.kind !== 'fuli-neo4j-assets' || receipt.id !== name) return refused('unknown_assets', { directory: join('neo4j-assets', name) });
    steps.push({ do: 'move-aside', path: container, to: join(RECOVERED, name) });
  }
  for (const name of listNames(paths.graphBackupDir).filter(name => /^before-neo4j-.+\.partial-[0-9a-f-]+$/.test(name))) {
    steps.push({ do: 'rename', path: join(paths.graphBackupDir, name), to: join(paths.graphBackupDir, `${name.replace(/\.partial-[0-9a-f-]+$/, '')}.incomplete`) });
  }
  return planned('clear_interrupted', [...steps, { do: 'release-lock' }], { operation: lock.holder.operation });
}

// A load overwrites the database, so a killed one may have left it half
// written: the lock is released only to restore the whole graph at once from
// the rollback copy the import took right before (backups/graph/before-import-*).
async function planLoad({ paths, lock, stop }) {
  const candidates = listNames(paths.graphBackupDir).filter(name => name.startsWith('before-import-')).sort().reverse();
  for (const name of candidates) {
    const from = join(paths.graphBackupDir, name);
    let manifest;
    try { manifest = await readGraphBackupManifest(from); } catch { continue; }
    if (Date.parse(manifest.createdAt) <= lock.since.getTime()) {
      return planned('restore_load', [...stop, { do: 'release-lock' }, { do: 'restore', from }], { operation: 'load', backupPath: from });
    }
  }
  return refused('no_restore_point', { operation: 'load' });
}

async function recordedServicesRunning(paths, deps) {
  const identity = deps.identity ?? { state: processState, matches: processMatchesCommand };
  const recorded = readJsonFile(paths.nativeProcessStatePath, {}) ?? {};
  const running = [];
  for (const entry of [...Object.values(recorded.databases ?? {}), ...Object.values(recorded.providers ?? {})]) {
    if (Number.isInteger(entry?.pid) && typeof entry.command === 'string' && identity.state(entry.pid) !== 'gone'
      && await identity.matches(entry.pid, entry.command)) running.push(entry.pid);
  }
  return running;
}

function listNames(directory) {
  try { return readdirSync(directory); } catch { return []; }
}

function planned(kind, steps, facts = {}) {
  return { kind, ...facts, steps, digest: createHash('sha256').update(JSON.stringify({ kind, steps })).digest('hex').slice(0, 16) };
}

function refused(reason, facts = {}) {
  return { kind: 'refused', reason, ...facts };
}

// Does what the plan with [digest] said, once nothing has changed since. The
// lock's token re-enters the operations it holds back (stop), and a restore
// runs through [restore] after the lock is released.
export async function applyNativeRecovery({ paths, digest, backOut = false, dependencies = {} }) {
  const deps = recoveryDependencies(dependencies);
  const plan = await planNativeRecovery({ paths, backOut, dependencies });
  if (plan.kind === 'refused' || plan.kind === 'nothing') return plan;
  if (plan.digest !== digest) return refused('plan_changed', { digest: plan.digest });
  const root = paths.nativeRuntimeDir;
  const owner = lifecycleLockOf(root)?.owner ?? null;
  const done = [];
  for (const step of plan.steps) {
    try {
      await runStep(step, { paths, root, owner, deps });
      done.push({ ...step, at: new Date(deps.now()).toISOString() });
    } catch (error) {
      deps.log(paths).record({ component: 'provider', operation: `native.recover.${step.do}`, outcome: 'failed',
        code: error?.code ?? 'recover_step_failed', reason: `the recovery step ${step.do} did not finish` });
      await keepRecord(root, plan, done, deps);
      throw Object.assign(new Error(`The recovery stopped at ${step.do}; what was done is kept, and running the recovery again finishes it.`),
        { cause: error, code: 'recover_step_failed', step: step.do });
    }
  }
  await keepRecord(root, plan, done, deps);
  return { ...plan, kind: plan.kind, status: 'recovered' };
}

async function runStep(step, { paths, root, owner, deps }) {
  switch (step.do) {
    case 'stop-services': return deps.stopServices(paths, owner);
    case 'check-formats': {
      const now = await deps.storeFormats(paths, step.descriptor);
      if (!step.formats || JSON.stringify(now) !== JSON.stringify(step.formats)) {
        throw Object.assign(new Error('The store format changed after the switch; it can only be finished.'), { code: 'format_changed' });
      }
      return;
    }
    case 'check-fingerprint':
      if (step.fingerprint && await deps.fingerprint(step.home) !== step.fingerprint) {
        throw Object.assign(new Error('The older Neo4j programs changed; backing out is unsafe.'), { code: 'assets_changed' });
      }
      return;
    case 'write-manifest': return writeJsonFileAtomic(paths.nativeRuntimeManifestPath, step.value);
    case 'move-aside': case 'rename': {
      const to = step.to.startsWith(RECOVERED) ? join(root, step.to) : step.to;
      if (!existsSync(step.path)) return; // moved by an earlier run
      await mkdir(join(to, '..'), { recursive: true, mode: 0o700 });
      return rename(step.path, existsSync(to) ? `${to}-${Date.now()}` : to);
    }
    case 'remove': return rm(step.path, { recursive: true, force: true });
    case 'archive-journal': {
      if (!existsSync(join(root, JOURNAL))) return;
      await mkdir(join(root, RECOVERED), { recursive: true, mode: 0o700 });
      return rename(join(root, JOURNAL), join(root, step.to));
    }
    case 'release-lock': {
      if (!lifecycleLockOf(root)) return;
      if (!await releaseLifecycleLock(root, owner, deps.identity)) {
        throw Object.assign(new Error('The lock changed while it was being released.'), { code: 'lock_changed' });
      }
      return;
    }
    case 'restore': return deps.restore(step.from);
    default: throw new TypeError(`Unknown recovery step: ${step.do}`);
  }
}

// What this recovery did, step by step, beside what it set aside: the record
// of a step that worked (the diagnostics log keeps only what failed).
async function keepRecord(root, plan, done, deps) {
  await mkdir(join(root, RECOVERED), { recursive: true, mode: 0o700 });
  writeJsonFileAtomic(join(root, RECOVERED, `recovery-${new Date(deps.now()).toISOString().replace(/[:.]/g, '-')}.json`),
    { version: 1, kind: plan.kind, digest: plan.digest, steps: done });
}

function recoveryDependencies(overrides) {
  return {
    // undefined: the lock module's own check of a holder (PID, start time, command).
    identity: undefined,
    listProcesses: undefined,
    fingerprint: neo4jAssetFingerprint,
    storeFormats: readNeo4jStoreFormats,
    stopServices: async () => { throw new Error('Stopping the recorded services needs the native runtime.'); },
    restore: async () => { throw new Error('A restore needs the graph import command.'); },
    log: (paths) => diagnosticEventLog(paths.dataDir),
    now: Date.now,
    ...overrides
  };
}

