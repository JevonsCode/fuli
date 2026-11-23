import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireNeo4jLifecycleLock } from '../src/native-runtime/neo4j-lifecycle-lock.js';
import { applyNativeRecovery, planNativeRecovery } from '../src/native-runtime/neo4j-recovery.js';

const LOCK = '.neo4j-lifecycle.lock';
const NOW = Date.parse('2026-11-23T03:00:00.000Z');
const holderIdentity = async () => ({ pid: 4321, command: 'node /x/cli.js', startedAt: 'Sun Nov 22 01:24:35 2026' });
const gone = { state: () => 'gone', startTime: async () => null, matches: async () => false };

// A made-up data directory with a native runtime in it.
function runtime(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-recover-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const root = join(dataDir, 'native-runtime');
  mkdirSync(join(root, 'neo4j-assets'), { recursive: true });
  const paths = { dataDir, nativeRuntimeDir: root, nativeRuntimeManifestPath: join(root, 'manifest.json'),
    nativeProcessStatePath: join(root, 'processes.json'), graphBackupDir: join(dataDir, 'backups', 'graph'),
    nativePersonalDir: join(root, 'personal'), nativeWorkspaceDir: join(root, 'workspace') };
  mkdirSync(paths.graphBackupDir, { recursive: true });
  return { paths, root };
}

function asset(root, id, version, { receipt = true } = {}) {
  const container = join(root, 'neo4j-assets', `jvs-a-${id}`);
  mkdirSync(join(container, `neo4j-community-${version}`, 'bin'), { recursive: true });
  if (receipt) writeFileSync(join(container, 'fuli-asset-owner.json'), JSON.stringify({ kind: 'fuli-neo4j-assets', id: `jvs-a-${id}`, version }));
  return join(container, `neo4j-community-${version}`);
}

function deps(overrides = {}) {
  const log = [];
  return { log, dependencies: { identity: gone, listProcesses: async () => [], fingerprint: async () => 'fp',
    storeFormats: async () => ({ 'personal:neo4j': 'aligned' }), stopServices: async () => log.push('stop'),
    checkStart: async (descriptor) => log.push(`start ${descriptor.neo4jVersion}`),
    restore: async ({ from }) => log.push(`restore ${from}`), log: () => ({ record: (event) => log.push(`${event.operation} ${event.code}`) }),
    now: () => NOW, ...overrides } };
}

async function recover(paths, d, options = {}) {
  const plan = await planNativeRecovery({ paths, dependencies: d.dependencies, ...options });
  return { plan, result: plan.digest ? await applyNativeRecovery({ paths, digest: plan.digest, dependencies: d.dependencies, ...options }) : plan };
}

// What a step that did not finish says, after its record was kept.
async function stoppedAt(promise) {
  try { await promise; } catch (error) { assert.equal(error.code, 'recover_step_failed'); return error; }
  assert.fail('the recovery did not stop');
}

function switchJournal(root, { previous, next, phase = 'switching', action = 'update', storeFormats = { 'personal:neo4j': 'aligned' } }) {
  writeFileSync(join(root, 'neo4j-transaction.json'), JSON.stringify({ action, phase, previous, next, storeFormats }));
}

const manifestOf = paths => JSON.parse(readFileSync(paths.nativeRuntimeManifestPath, 'utf8'));
const folderOf = root => join(root, 'recovered', readdirSync(join(root, 'recovered')).find(name => !name.endsWith('.json')));

test('nothing to recover says so and changes nothing', async (t) => {
  const { paths } = runtime(t);
  assert.equal((await planNativeRecovery({ paths, dependencies: deps().dependencies })).kind, 'nothing');
});

test('a switch killed before the new descriptor was written is undone: the candidate and the journal move to this recovery\'s folder', async (t) => {
  const { paths, root } = runtime(t);
  const oldHome = join(root, 'neo4j-community-5.26.0');
  const newHome = asset(root, '1111', '5.26.28');
  const previous = { status: 'ready', neo4jVersion: '5.26.0', neo4jHome: oldHome };
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify(previous));
  await acquireNeo4jLifecycleLock(root, { operation: 'update', identify: holderIdentity });
  switchJournal(root, { previous, next: { ...previous, neo4jVersion: '5.26.28', neo4jHome: newHome } });
  const { plan, result } = await recover(paths, deps());
  assert.equal(plan.kind, 'undo_switch');
  assert.deepEqual(plan.steps.map(step => step.do), ['move-aside', 'archive-journal', 'release-lock']);
  assert.equal(typeof plan.steps[0].bytes, 'number', 'the plan says how big what it moves is');
  assert.equal(result.status, 'recovered');
  const folder = folderOf(root);
  assert.ok(existsSync(join(folder, 'neo4j-assets', 'jvs-a-1111', 'neo4j-community-5.26.28')), 'set aside, not deleted');
  assert.ok(existsSync(join(folder, 'neo4j-transaction.json')), 'the journal is kept');
  assert.equal(existsSync(join(root, 'neo4j-transaction.json')), false);
  assert.equal(existsSync(join(root, LOCK)), false);
  assert.ok(existsSync(result.record), 'what was done is recorded');
  assert.equal(JSON.parse(readFileSync(result.record, 'utf8')).outcome, 'recovered');
});

async function newerInPlace(t, { fingerprint = 'fp', storeFormats } = {}) {
  const { paths, root } = runtime(t);
  const previous = { status: 'ready', neo4jVersion: '5.26.0', neo4jHome: join(root, 'neo4j-community-5.26.0'),
    ...(fingerprint ? { neo4jAssetFingerprint: fingerprint } : {}) };
  mkdirSync(previous.neo4jHome);
  const next = { ...previous, neo4jVersion: '5.26.28', neo4jHome: asset(root, '2222', '5.26.28'),
    previousNeo4jAsset: { home: previous.neo4jHome, graphBackup: join(paths.graphBackupDir, 'before-neo4j-5.26.28-x') } };
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify(next));
  const lock = await acquireNeo4jLifecycleLock(root, { operation: 'update', identify: holderIdentity });
  switchJournal(root, { previous, next, ...(storeFormats ? { storeFormats } : {}) });
  return { paths, root, previous, next, lock };
}

test('a switch whose newer descriptor is in place is finished only after the newer Neo4j starts and the store format is unchanged', async (t) => {
  const finished = await newerInPlace(t);
  const tokens = [];
  const d = deps({ checkStart: async (descriptor, owner) => { tokens.push([descriptor.neo4jVersion, owner]); } });
  const { plan, result } = await recover(finished.paths, d);
  assert.deepEqual([plan.kind, plan.fromVersion, plan.toVersion], ['finish_switch', '5.26.0', '5.26.28']);
  assert.deepEqual(plan.steps.map(step => step.do), ['check-start', 'check-formats', 'archive-journal', 'release-lock']);
  assert.equal(plan.backupPath, finished.next.previousNeo4jAsset.graphBackup, 'the backup location is shown');
  assert.equal(result.status, 'recovered');
  assert.deepEqual(tokens, [['5.26.28', finished.lock.token]], 'started under the lock\'s own token');
  assert.deepEqual(manifestOf(finished.paths), finished.next, 'the newer descriptor stays');

  // The newer one does not start: the journal and the lock stay, nothing is written.
  const failed = await newerInPlace(t);
  const failing = deps({ checkStart: async () => { throw new Error('no answer'); } });
  const stopped = await stoppedAt(recover(failed.paths, failing));
  assert.equal(stopped.reason, 'start_failed');
  assert.ok(failing.log.includes('native.recover.check-start start_failed'), 'the failed step is in the diagnostics log');
  assert.equal(JSON.parse(readFileSync(stopped.record, 'utf8')).outcome, 'stopped');
  assert.ok(existsSync(join(failed.root, 'neo4j-transaction.json')) && existsSync(join(failed.root, LOCK)));
  assert.deepEqual(manifestOf(failed.paths), failed.next);

  // A store format that changed: not finished either.
  const changed = await newerInPlace(t);
  let reads = 0;
  const formats = deps({ storeFormats: async () => ({ 'personal:neo4j': reads++ === 0 ? 'aligned' : 'block' }) });
  assert.equal((await stoppedAt(recover(changed.paths, formats))).reason, 'format_changed');
  assert.ok(existsSync(join(changed.root, LOCK)));
});

test('backing out is offered beside finishing, writes the older descriptor back only after its checks, and keeps the newer one when the older does not start', async (t) => {
  const offered = await newerInPlace(t);
  const d = deps();
  const plan = await planNativeRecovery({ paths: offered.paths, dependencies: d.dependencies });
  assert.equal(plan.alternative.kind, 'back_out_switch');
  assert.deepEqual(plan.alternative.steps.map(step => step.do),
    ['check-formats', 'check-fingerprint', 'write-manifest', 'check-start', 'move-aside', 'archive-journal', 'release-lock']);
  // The window confirms the alternative by its own digest.
  const result = await applyNativeRecovery({ paths: offered.paths, digest: plan.alternative.digest, dependencies: d.dependencies });
  assert.equal(result.kind, 'back_out_switch');
  assert.deepEqual(manifestOf(offered.paths), offered.previous);
  assert.deepEqual(d.log, ['start 5.26.0']);
  const folder = folderOf(offered.root);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')), offered.next, 'the descriptor it replaced is kept');
  assert.ok(existsSync(join(folder, 'neo4j-assets', 'jvs-a-2222')));

  const older = await newerInPlace(t);
  const failing = deps({ checkStart: async () => { throw new Error('store too new'); } });
  assert.equal((await stoppedAt(recover(older.paths, failing, { backOut: true }))).reason, 'start_failed');
  assert.deepEqual(manifestOf(older.paths), older.next, 'the newer descriptor is written back');
  assert.ok(existsSync(join(older.root, 'neo4j-assets', 'jvs-a-2222')), 'its programs stay');
  assert.ok(existsSync(join(older.root, LOCK)));

  // Without the older programs' fingerprint, or with programs that changed, it is not offered.
  const unknown = await newerInPlace(t, { fingerprint: null });
  const unchecked = await planNativeRecovery({ paths: unknown.paths, dependencies: deps().dependencies });
  assert.deepEqual([unchecked.alternative, unchecked.alternativeRefused], [null, 'no_fingerprint']);
  assert.equal((await planNativeRecovery({ paths: unknown.paths, backOut: true, dependencies: deps().dependencies })).reason, 'no_fingerprint');
  const altered = await newerInPlace(t);
  assert.equal((await planNativeRecovery({ paths: altered.paths, dependencies: deps({ fingerprint: async () => 'other' }).dependencies })).alternativeRefused,
    'assets_changed');
  const reformatted = await newerInPlace(t);
  assert.equal((await planNativeRecovery({ paths: reformatted.paths,
    dependencies: deps({ storeFormats: async () => ({ 'personal:neo4j': 'block' }) }).dependencies })).alternativeRefused, 'format_changed');
});

test('a descriptor matching neither side of the switch, or a journal that is empty, damaged or partial, is refused', async (t) => {
  const changed = await newerInPlace(t);
  writeFileSync(changed.paths.nativeRuntimeManifestPath, JSON.stringify({ status: 'ready', neo4jVersion: '5.27.0', neo4jHome: '/elsewhere' }));
  assert.equal((await planNativeRecovery({ paths: changed.paths, dependencies: deps().dependencies })).reason, 'manifest_changed');
  for (const text of ['', '{"action":', '[]', JSON.stringify({ action: 'update', phase: 'switching', previous: { neo4jHome: '/x' } })]) {
    const damaged = await newerInPlace(t);
    writeFileSync(join(damaged.root, 'neo4j-transaction.json'), text);
    assert.equal((await planNativeRecovery({ paths: damaged.paths, dependencies: deps().dependencies })).reason, 'unknown_journal', JSON.stringify(text));
    assert.ok(existsSync(join(damaged.root, 'neo4j-transaction.json')));
  }
});

async function uninstalling(t, { manifest = 'uninstalled' } = {}) {
  const { paths, root } = runtime(t);
  const home = join(root, 'neo4j-community-5.26.28');
  mkdirSync(join(home, 'bin'), { recursive: true });
  const kept = asset(root, '8888', '5.26.0');
  mkdirSync(join(root, 'personal', 'data'), { recursive: true });
  const previous = { status: 'ready', neo4jVersion: '5.26.28', neo4jHome: home,
    previousNeo4jAsset: { home: kept, version: '5.26.0', fingerprint: 'fp' } };
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify(manifest === 'uninstalled' ? { ...previous, status: 'uninstalled' } : previous));
  await acquireNeo4jLifecycleLock(root, { operation: 'uninstall', identify: holderIdentity });
  switchJournal(root, { previous, phase: 'removing-assets', action: 'uninstall' });
  return { paths, root, home, kept, previous };
}

test('an uninstall killed while removing programs is finished by moving the rest aside; the knowledge data is not touched', async (t) => {
  const { paths, root, home, kept, previous } = await uninstalling(t, { manifest: 'previous' });
  const { plan, result } = await recover(paths, deps());
  assert.deepEqual(plan.steps.map(step => step.do), ['write-manifest', 'move-aside', 'move-aside', 'archive-journal', 'release-lock']);
  assert.equal(result.status, 'recovered');
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(kept), false);
  const folder = folderOf(root);
  assert.ok(existsSync(join(folder, 'neo4j-community-5.26.28', 'bin')), 'moved, not deleted');
  assert.ok(existsSync(join(folder, 'neo4j-assets', 'jvs-a-8888')));
  assert.deepEqual(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')), previous, 'the descriptor it replaced is kept');
  assert.equal(manifestOf(paths).status, 'uninstalled');
  assert.ok(existsSync(join(root, 'personal', 'data')));
});

test('an uninstall killed part way through removing a directory, or killed again during its recovery, is finished on the next run', async (t) => {
  // The receipt went first (rm removes in name order): only the programs are left.
  const partial = await uninstalling(t);
  rmSync(join(partial.root, 'neo4j-assets', 'jvs-a-8888', 'fuli-asset-owner.json'));
  const first = await planNativeRecovery({ paths: partial.paths, dependencies: deps().dependencies });
  assert.equal(first.kind, 'finish_uninstall');
  assert.ok(first.steps.some(step => step.path?.endsWith('jvs-a-8888')));
  // Killed after the first directory moved: planned again without it, and finished.
  renameSync(partial.home, join(partial.root, 'moved-by-the-killed-run'));
  const { plan, result } = await recover(partial.paths, deps());
  assert.deepEqual(plan.steps.map(step => step.do), ['move-aside', 'archive-journal', 'release-lock']);
  assert.equal(result.status, 'recovered');
  // Killed after the journal was archived, before the lock was released: the lock alone is released.
  const late = await uninstalling(t);
  rmSync(join(late.root, 'neo4j-transaction.json'));
  rmSync(late.home, { recursive: true });
  const after = await recover(late.paths, deps({ fingerprint: async () => { throw new Error('gone'); } }));
  assert.deepEqual([after.plan.kind, after.plan.steps.map(step => step.do)], ['clear_interrupted', ['release-lock']]);
  assert.equal(existsSync(join(late.root, LOCK)), false);
});

test('an uninstall journal naming programs outside the runtime, missing what it removed, or a reinstalled descriptor is refused and nothing moves', async (t) => {
  const outside = await uninstalling(t);
  const elsewhere = join(outside.paths.dataDir, 'elsewhere', 'neo4j-community-5.26.28');
  mkdirSync(elsewhere, { recursive: true });
  const previous = { status: 'ready', neo4jVersion: '5.26.28', neo4jHome: elsewhere };
  writeFileSync(outside.paths.nativeRuntimeManifestPath, JSON.stringify({ ...previous, status: 'uninstalled' }));
  switchJournal(outside.root, { previous, phase: 'removing-assets', action: 'uninstall' });
  assert.equal((await planNativeRecovery({ paths: outside.paths, dependencies: deps().dependencies })).reason, 'unmanaged_path');
  assert.ok(existsSync(elsewhere));

  const missing = await uninstalling(t);
  switchJournal(missing.root, { previous: undefined, phase: 'removing-assets', action: 'uninstall' });
  assert.equal((await planNativeRecovery({ paths: missing.paths, dependencies: deps().dependencies })).reason, 'unknown_journal');

  const reinstalled = await uninstalling(t);
  writeFileSync(reinstalled.paths.nativeRuntimeManifestPath, JSON.stringify({ ...reinstalled.previous, neo4jAssetFingerprint: 'new' }));
  assert.equal((await planNativeRecovery({ paths: reinstalled.paths, dependencies: deps().dependencies })).reason, 'manifest_changed');
  assert.ok(existsSync(reinstalled.home));
});

test('an update killed before its journal sets aside its half-installed programs and unfinished backup, and releases the lock', async (t) => {
  const { paths, root } = runtime(t);
  const home = asset(root, '3333', '5.26.0');
  asset(root, '4444', '5.26.28');
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify({ status: 'ready', neo4jHome: home, neo4jAssetFingerprint: 'fp' }));
  mkdirSync(join(paths.graphBackupDir, 'before-neo4j-5.26.28-2026.partial-0a1b'));
  await acquireNeo4jLifecycleLock(root, { operation: 'update', identify: holderIdentity });
  // Killed between making its directory and writing the receipt in it.
  asset(root, 'abcd', '5.26.28', { receipt: false });
  const { plan, result } = await recover(paths, deps());
  assert.equal(plan.kind, 'clear_interrupted');
  assert.equal(result.status, 'recovered');
  assert.ok(existsSync(home), 'the programs in use stay');
  const folder = folderOf(root);
  assert.ok(existsSync(join(folder, 'neo4j-assets', 'jvs-a-4444')));
  assert.ok(existsSync(join(folder, 'neo4j-assets', 'jvs-a-abcd')));
  assert.ok(existsSync(join(paths.graphBackupDir, 'before-neo4j-5.26.28-2026.incomplete')));
  assert.equal(existsSync(join(root, LOCK)), false);
  // Programs that changed under the descriptor, or a directory FULI cannot recognise, are left for a person.
  const changed = runtime(t);
  writeFileSync(changed.paths.nativeRuntimeManifestPath, JSON.stringify({ neo4jHome: asset(changed.root, '5555', '5.26.0'), neo4jAssetFingerprint: 'other' }));
  await acquireNeo4jLifecycleLock(changed.root, { operation: 'update', identify: holderIdentity });
  assert.equal((await planNativeRecovery({ paths: changed.paths, dependencies: deps().dependencies })).reason, 'assets_changed');
  const foreign = runtime(t);
  mkdirSync(join(foreign.root, 'neo4j-assets', 'jvs-a-6666'));
  writeFileSync(join(foreign.root, 'neo4j-assets', 'jvs-a-6666', 'notes.txt'), 'kept');
  await acquireNeo4jLifecycleLock(foreign.root, { operation: 'update', identify: holderIdentity });
  const refusal = await planNativeRecovery({ paths: foreign.paths, dependencies: deps().dependencies });
  assert.deepEqual([refusal.reason, refusal.path], ['unknown_assets', join(foreign.root, 'neo4j-assets', 'jvs-a-6666')]);
});

async function interruptedLoad(t, restorePoint) {
  const load = runtime(t);
  const copy = join(load.paths.graphBackupDir, 'before-import-2026-11-22T00-00-00-000Z-a');
  mkdirSync(copy);
  writeFileSync(join(copy, 'manifest.json'), JSON.stringify({ format: 'fuli-neo4j-backup', version: 1, createdAt: '2026-11-22T00:00:00.000Z',
    sourceMode: 'native', instances: [{ id: 'personal', file: 'personal.dump', sha256: 'a'.repeat(64) }] }));
  // A newer copy from another import is never the one restored.
  const newer = join(load.paths.graphBackupDir, 'before-import-2026-11-22T09-00-00-000Z-b');
  mkdirSync(newer);
  writeFileSync(join(newer, 'manifest.json'), readFileSync(join(copy, 'manifest.json')));
  for (const store of ['databases', 'transactions']) mkdirSync(join(load.paths.nativeWorkspaceDir, 'data', store, 'neo4j'), { recursive: true });
  const point = restorePoint === undefined ? { path: copy, instances: ['personal'], loading: ['personal', 'workspace'] } : restorePoint;
  const lock = await acquireNeo4jLifecycleLock(load.root, { operation: 'load', identify: holderIdentity,
    details: point ? { restorePoint: typeof point === 'function' ? point(load, copy) : point } : {} });
  return { ...load, copy, lock };
}

test('a load goes back to the copy its own import took, keeps the lock until the restore is done, and empties an instance that was empty before', async (t) => {
  const load = await interruptedLoad(t);
  const seen = [];
  const d = deps({ restore: async ({ from, instances }, owner) => {
    seen.push({ from, instances, owner, locked: existsSync(join(load.root, LOCK)) });
  } });
  const { plan, result } = await recover(load.paths, d);
  assert.equal(plan.kind, 'restore_load');
  assert.deepEqual(plan.steps.map(step => step.do), ['restore', 'move-aside', 'move-aside', 'release-lock']);
  assert.deepEqual(plan.restorePoint, { path: load.copy, createdAt: '2026-11-22T00:00:00.000Z', instances: ['personal'] });
  assert.deepEqual(plan.emptied, ['workspace']);
  assert.deepEqual(seen, [{ from: load.copy, instances: ['personal'], owner: load.lock.token, locked: true }],
    'restored from that copy, under the lock\'s token, while the lock still holds starts back');
  assert.equal(result.status, 'recovered');
  assert.ok(existsSync(join(folderOf(load.root), 'workspace', 'data', 'databases', 'neo4j')), 'the half-written store is set aside');
  assert.equal(existsSync(join(load.root, LOCK)), false);
});

test('a restore that fails keeps the lock, so nothing starts on a half-written graph, and running the recovery again finishes it', async (t) => {
  const load = await interruptedLoad(t);
  const stopped = await stoppedAt(recover(load.paths, deps({ restore: async () => { throw new Error('checksum'); } })));
  assert.equal(stopped.reason, 'restore_failed');
  assert.ok(existsSync(join(load.root, LOCK)), 'the lock still blocks a start');
  const again = await recover(load.paths, deps());
  assert.equal(again.plan.kind, 'restore_load');
  assert.equal(again.result.status, 'recovered');
});

test('a load that cannot say which copy its import took, or whose copy is gone, is refused instead of guessing', async (t) => {
  const plan = async load => planNativeRecovery({ paths: load.paths, dependencies: deps().dependencies });
  assert.equal((await plan(await interruptedLoad(t, null))).reason, 'restore_point_unknown');
  assert.equal((await plan(await interruptedLoad(t, (load) => ({ path: join(load.paths.dataDir, 'elsewhere'), instances: ['personal'], loading: ['personal'] }))))
    .reason, 'restore_point_unknown');
  const gone = await interruptedLoad(t);
  rmSync(gone.copy, { recursive: true });
  assert.equal((await plan(gone)).reason, 'restore_point_damaged');
  assert.ok(existsSync(join(gone.root, LOCK)), 'a half-written load keeps its lock');
  // Everything was empty before (a first import, or `graph migrate` into a new runtime): no copy, the stores go aside.
  const fresh = await plan(await interruptedLoad(t, { path: null, instances: [], loading: ['workspace'] }));
  assert.deepEqual([fresh.kind, fresh.restorePoint, fresh.steps.map(step => step.do)], ['restore_load', null, ['move-aside', 'move-aside', 'release-lock']]);
});

test('a dump releases its lock', async (t) => {
  const dump = runtime(t);
  await acquireNeo4jLifecycleLock(dump.root, { operation: 'dump', identify: holderIdentity });
  assert.equal((await recover(dump.paths, deps())).plan.kind, 'release_dump');
  assert.equal(existsSync(join(dump.root, LOCK)), false);
});

test('a recovery killed part way is planned and finished again', async (t) => {
  const { paths, root } = runtime(t);
  const previous = { status: 'ready', neo4jVersion: '5.26.0', neo4jHome: join(root, 'neo4j-community-5.26.0') };
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify(previous));
  await acquireNeo4jLifecycleLock(root, { operation: 'update', identify: holderIdentity });
  switchJournal(root, { previous, next: { ...previous, neo4jVersion: '5.26.28', neo4jHome: asset(root, '7777', '5.26.28') } });
  // Killed right after the candidate was set aside.
  mkdirSync(join(root, 'recovered', 'killed'), { recursive: true });
  renameSync(join(root, 'neo4j-assets', 'jvs-a-7777'), join(root, 'recovered', 'killed', 'jvs-a-7777'));
  const again = await planNativeRecovery({ paths, dependencies: deps().dependencies });
  assert.deepEqual([again.kind, again.steps.map(step => step.do)], ['undo_switch', ['archive-journal', 'release-lock']]);
  assert.equal((await applyNativeRecovery({ paths, digest: again.digest, dependencies: deps().dependencies })).status, 'recovered');
  assert.equal(existsSync(join(root, LOCK)), false);
});

test('a plan that changed since it was shown is not applied; what still uses the runtime is refused', async (t) => {
  const { paths, root } = runtime(t);
  await acquireNeo4jLifecycleLock(root, { operation: 'dump', identify: holderIdentity });
  assert.equal((await applyNativeRecovery({ paths, digest: 'stale', dependencies: deps().dependencies })).reason, 'plan_changed');
  assert.ok(existsSync(join(root, LOCK)));
  const running = { state: () => 'running', startTime: async () => 'Sun Nov 22 01:24:35 2026', matches: async () => true };
  const reason = async overrides => (await planNativeRecovery({ paths, dependencies: deps(overrides).dependencies })).reason;
  assert.equal(await reason({ identity: running }), 'holder_running');
  assert.equal(await reason({ listProcesses: async () => null }), 'cannot_inspect');
  assert.equal(await reason({ listProcesses: async () => [{ pid: 999999, command: `node /x/src/cli.js start --data-dir ${paths.dataDir}` }] }), 'fuli_running');
  // A journal with no lock left: the services it recorded run, and no token can stop them.
  const orphan = runtime(t);
  const previous = { status: 'ready', neo4jVersion: '5.26.0', neo4jHome: join(orphan.root, 'neo4j-community-5.26.0') };
  writeFileSync(orphan.paths.nativeRuntimeManifestPath, JSON.stringify(previous));
  switchJournal(orphan.root, { previous, next: previous, action: 'rollback' });
  writeFileSync(orphan.paths.nativeProcessStatePath, JSON.stringify({ databases: { personal: { pid: 77, command: 'java' } } }));
  const services = { state: pid => pid === 77 ? 'running' : 'gone', startTime: async () => null, matches: async pid => pid === 77 };
  assert.equal((await planNativeRecovery({ paths: orphan.paths, dependencies: deps({ identity: services }).dependencies })).reason, 'cannot_stop_services');
});

test('a lock that names nobody, with a switch journal, waits the same 90 minutes as a person\'s unlock', async (t) => {
  const { paths, root } = runtime(t);
  const previous = { status: 'ready', neo4jVersion: '5.26.0', neo4jHome: join(root, 'neo4j-community-5.26.0') };
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify(previous));
  mkdirSync(join(root, LOCK));
  writeFileSync(join(root, LOCK, 'owner'), 'token-a');
  switchJournal(root, { previous, next: { ...previous, neo4jVersion: '5.26.28', neo4jHome: asset(root, '9999', '5.26.28') } });
  const young = await planNativeRecovery({ paths, dependencies: deps({ now: () => Date.now() }).dependencies });
  assert.equal(young.reason, 'too_recent');
  assert.ok(young.releasableAt);
  const old = await planNativeRecovery({ paths, dependencies: deps({ now: () => Date.now() + 2 * 60 * 60_000 }).dependencies });
  assert.equal(old.kind, 'undo_switch');
  // Without a journal such a lock is unlock's, not recover's.
  rmSync(join(root, 'neo4j-transaction.json'));
  assert.equal((await planNativeRecovery({ paths, dependencies: deps().dependencies })).reason, 'no_holder');
});

test('the recorded graph services are stopped first, under the lock\'s own token', async (t) => {
  const { paths, root } = runtime(t);
  const lock = await acquireNeo4jLifecycleLock(root, { operation: 'dump', identify: holderIdentity });
  writeFileSync(paths.nativeProcessStatePath, JSON.stringify({ databases: { personal: { pid: 77, command: 'java' } } }));
  const tokens = [];
  const services = { state: pid => pid === 77 ? 'running' : 'gone', startTime: async () => null, matches: async pid => pid === 77 };
  const d = deps({ identity: services, stopServices: async (owner) => { tokens.push(owner); } });
  const plan = await planNativeRecovery({ paths, dependencies: d.dependencies });
  assert.deepEqual(plan.steps.map(step => step.do), ['stop-services', 'release-lock']);
  await applyNativeRecovery({ paths, digest: plan.digest, dependencies: d.dependencies });
  assert.deepEqual(tokens, [lock.token]);
});

test('old recovery folders are cleared only past the clean-up rule, and only after the plan lists them', async (t) => {
  const { paths, root } = runtime(t);
  const stamps = ['2026-09-01T00-00-00-000Z', '2026-09-02T00-00-00-000Z', '2026-10-01T00-00-00-000Z', '2026-11-20T00-00-00-000Z', '2026-11-21T00-00-00-000Z'];
  for (const stamp of stamps) mkdirSync(join(root, 'recovered', stamp, 'neo4j-assets'), { recursive: true });
  mkdirSync(join(root, 'recovered', 'kept-by-a-person'));
  await acquireNeo4jLifecycleLock(root, { operation: 'dump', identify: holderIdentity });
  const { plan } = await recover(paths, deps());
  assert.deepEqual(plan.steps.filter(step => step.do === 'prune').map(step => step.path),
    [join(root, 'recovered', stamps[0]), join(root, 'recovered', stamps[1])], 'beyond the 3 newest and over 30 days old');
  const left = readdirSync(join(root, 'recovered'));
  for (const stamp of stamps.slice(2)) assert.ok(left.includes(stamp));
  assert.ok(left.includes('kept-by-a-person'), 'nothing else is touched');
  assert.equal(left.includes(stamps[0]), false);
});

test('fuli graph runtime recover shows the plan, recovers only for a person at a terminal, and says why it will not', async () => {
  const { runNativeRuntimeCommand } = await import('../src/cli/native-runtime-command.js');
  const { readStartupFailure, startupFailureLine } = await import('../src/local-runtime/startup-failure-line.js');
  const written = [];
  const plan = { kind: 'release_dump', operation: 'dump', steps: [{ do: 'release-lock' }], digest: '0123456789abcdef' };
  const applied = [];
  const run = (args, { planned = plan, interactive = true, apply } = {}) => runNativeRuntimeCommand(args, { platform: 'darwin',
    write: line => written.push(line), interactive,
    resolvePaths: () => ({ dataDir: '/x/fuli-data', nativeRuntimeDir: '/x/fuli-data/native-runtime' }),
    planRecovery: async () => planned,
    applyRecovery: apply ?? (async ({ digest }) => { applied.push(digest); return { ...planned, status: 'recovered', record: '/x/r/recovery-1.json' }; }) });
  const reasonOf = error => readStartupFailure(startupFailureLine(error)).failure.reason;
  assert.deepEqual(await run(['recover', '--preview', '--json'], { interactive: false }), { status: 'preview', exitCode: 0 });
  assert.deepEqual(JSON.parse(written.at(-1)), plan);
  // Without a terminal (an Agent's shell, a script) it never recovers.
  await assert.rejects(run(['recover', '--yes', '--expect', '0123456789abcdef'], { interactive: false }), (error) => reasonOf(error) === 'needs_person');
  assert.deepEqual(applied, []);
  assert.equal((await run(['recover', '--yes', '--expect', '0123456789abcdef'])).status, 'recovered');
  assert.deepEqual(applied, ['0123456789abcdef']);
  assert.match(written.join('\n'), /1\. 解除数据库维护锁 \/ Release the database maintenance lock/);
  assert.match(written.at(-1), /recovery-1\.json/, 'the success points to the record');
  // A digest from a plan that has since changed does nothing.
  await assert.rejects(run(['recover', '--yes', '--expect', 'ffffffffffffffff']), (error) => reasonOf(error) === 'plan_changed');
  assert.deepEqual(applied, ['0123456789abcdef']);
  await assert.rejects(run(['recover', '--yes', '--expect', '0123456789abcdef'], { planned: { kind: 'refused', reason: 'restore_point_damaged', backupPath: '/x/b' } }),
    /不见了或不完整/);
  // A step that did not finish: its reason, the record, and that running it again continues.
  const failed = Object.assign(new Error('stopped'), { code: 'recover_step_failed', step: 'restore', reason: 'restore_failed', record: '/x/r/recovery-2.json' });
  await assert.rejects(run(['recover', '--yes', '--expect', '0123456789abcdef'], { apply: async () => { throw failed; } }), (error) => {
    assert.equal(reasonOf(error), 'restore_failed');
    assert.match(error.message, /recovery-2\.json/);
    return true;
  });
});

test('every reason a recovery gives is said in both languages, with a next step', async () => {
  const { formatRecoveryPlan } = await import('../src/cli/recovery-plan-text.js');
  for (const reason of ['holder_running', 'fuli_running', 'cannot_inspect', 'no_holder', 'too_recent', 'cannot_stop_services', 'manifest_changed',
    'unknown_journal', 'unmanaged_path', 'assets_changed', 'unknown_assets', 'no_fingerprint', 'format_changed', 'format_unreadable', 'start_failed',
    'restore_failed', 'restore_point_unknown', 'restore_point_damaged', 'lock_changed', 'step_failed', 'plan_changed', 'needs_person']) {
    const text = formatRecoveryPlan({ kind: 'refused', reason, pid: 7, path: '/x/native-runtime/neo4j-assets/jvs-a-1', directory: 'neo4j-assets/jvs-a-1' });
    assert.match(text, /^没有恢复：.+ \/ Not recovered: .+/s, reason);
    assert.doesNotMatch(text, new RegExp(`：${reason} /`), reason);
  }
  const load = formatRecoveryPlan({ kind: 'restore_load', restorePoint: { path: '/x/b/before-import-1', createdAt: '2026-11-22T00:00:00.000Z', instances: ['personal'] },
    emptied: ['workspace'], steps: [{ do: 'restore', from: '/x/b/before-import-1', instances: ['personal'] },
      { do: 'move-aside', path: '/x/native-runtime/workspace/data/databases/neo4j', bytes: 5 * 1024 * 1024 }] });
  assert.match(load, /这次想导入的内容不会保留，之后需要重新导入/);
  assert.match(load, /用这次导入开始前（.+）自动留下的备份恢复 personal/);
  assert.match(load, /workspace 在导入前是空的，恢复后也是空的/);
  assert.match(load, /5\.0 MB/);
  assert.doesNotMatch(load, /(?<!不)删除/);
});

test('the window\'s 恢复并启动 previews the plan, then recovers with the chosen plan\'s digest and starts', async () => {
  const { runTrayAction } = await import('../src/desktop/desktop-controller.js');
  const context = { packageRoot: '/x/pkg', dataDir: '/x/fuli-test-data-that-does-not-exist', nodePath: '/x/node', cliPath: '/x/cli.js' };
  const calls = [];
  const runCli = async (_context, args) => {
    calls.push(args.slice(0, args.indexOf('--data-dir')).join(' '));
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ status: calls.some(call => call.startsWith('setup')) ? 'running' : 'stopped' }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const recovery = { plan: async () => ({ kind: 'release_dump', steps: [], digest: '0123456789abcdef' }),
    apply: async (_paths, digest) => { calls.push(`recover ${digest}`); return { kind: 'release_dump', status: 'recovered', record: '/x/r.json' }; } };
  const preview = await runTrayAction('recover-preview', context, { runCli, recovery });
  assert.equal(preview.recoveryPlan.digest, '0123456789abcdef');
  const started = await runTrayAction('recover-start', context, { runCli, recovery, recoveryDigest: '0123456789abcdef', otherConsole: () => null,
    holdAdoption: () => null, portBlocked: async () => false });
  assert.ok(calls.indexOf('recover 0123456789abcdef') < calls.findIndex(call => call.startsWith('setup')), 'it starts only after the recovery');
  assert.equal(started.recoveryRecord, '/x/r.json');
  assert.equal(calls.some(call => call.startsWith('graph runtime recover')), false, 'never through the CLI');
  const refusing = { ...recovery, apply: async () => ({ kind: 'refused', reason: 'plan_changed' }) };
  const refused = await runTrayAction('recover-start', context, { runCli, recovery: refusing, recoveryDigest: '0123456789abcdef' });
  assert.deepEqual([refused.ok, refused.failure.code, refused.failure.reason], [false, 'recovery_refused', 'plan_changed']);
  await assert.rejects(runTrayAction('recover-start', context, { runCli, recovery }), /needs the digest/);
});
