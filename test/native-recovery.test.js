import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { withNativeAssetOperation } from '../src/native-runtime/neo4j-asset-state.js';
import { createHash } from 'node:crypto';
import { acquireNeo4jLifecycleLock, lockTooRecent, readLock } from '../src/native-runtime/neo4j-lifecycle-lock.js';
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
    checkStart: async (descriptor) => log.push(`start ${descriptor?.neo4jVersion}`),
    restore: async ({ from }) => log.push(`restore ${from}`), log: () => ({ record: (event) => log.push(`${event.operation} ${event.code}`) }),
    now: () => NOW, ...overrides } };
}

async function recover(paths, d, options = {}) {
  const plan = await planNativeRecovery({ paths, dependencies: d.dependencies, ...options });
  return { plan, result: plan.digest ? await applyNativeRecovery({ paths, digest: plan.digest, dependencies: d.dependencies, ...options }) : plan };
}

// The recovery killed right after its [k]th step finished, before that step was
// recorded. now() is read once for the plan, once for the folder's name, then
// after each step; failing there leaves exactly what those k steps did, as a
// kill would (no step's own clean-up runs).
function killedAfter(k, overrides = {}) {
  let calls = 0;
  return deps({ ...overrides, now: () => { calls += 1; if (calls > 1 + k) throw new Error('killed'); return NOW; } });
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
    ['check-formats', 'check-fingerprint', 'mark-backing-out', 'write-manifest', 'check-start', 'move-aside', 'archive-journal', 'release-lock']);
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

test('a switch journal whose lock is gone is finished or backed out under a lock the recovery takes, through the services\' real lock check', async (t) => {
  // The services' own gate (neo4j-asset-state.js): with a switch journal, only the lock's token gets through.
  const gate = (paths, started) => (descriptor, owner) => withNativeAssetOperation(paths, owner ? { FULI_NATIVE_ASSET_OPERATION: owner } : {},
    async () => { started.push(descriptor.neo4jVersion); }, { operation: 'start', identity: gone });
  for (const backOut of [false, true]) {
    // The switch's own failed rollback released the lock (before FULI kept it), or a person removed it.
    const orphan = await newerInPlace(t);
    await orphan.lock.release();
    const started = [];
    const { plan, result } = await recover(orphan.paths, deps({ checkStart: gate(orphan.paths, started) }), { backOut });
    assert.equal(plan.kind, backOut ? 'back_out_switch' : 'finish_switch');
    assert.equal(result.status, 'recovered');
    assert.deepEqual(started, [backOut ? '5.26.0' : '5.26.28']);
    assert.equal(existsSync(join(orphan.root, LOCK)), false);
    assert.deepEqual(manifestOf(orphan.paths), backOut ? orphan.previous : orphan.next);
  }
  // Without a token the same gate refuses: what a recovery that took no lock would have run into.
  const bare = await newerInPlace(t);
  await bare.lock.release();
  await assert.rejects(withNativeAssetOperation(bare.paths, {}, async () => {}, { operation: 'start', identity: gone }), /needs recovery/);
  // A check that fails keeps the recovery's own lock; running again plans the same and finishes.
  const stopped = await stoppedAt(recover(bare.paths, deps({ checkStart: async () => { throw new Error('no answer'); } })));
  assert.equal(stopped.reason, 'start_failed');
  assert.equal(JSON.parse(readFileSync(join(bare.root, LOCK, 'holder.json'), 'utf8')).operation, 'recover');
  const started = [];
  assert.equal((await recover(bare.paths, deps({ checkStart: gate(bare.paths, started) }))).result.status, 'recovered');
  assert.deepEqual(started, ['5.26.28']);
  assert.equal(existsSync(join(bare.root, LOCK)), false);
  // Killed after the journal went but before its lock did: only that lock is left to release.
  const late = runtime(t);
  await acquireNeo4jLifecycleLock(late.root, { operation: 'recover', identify: holderIdentity });
  const left = await recover(late.paths, deps());
  assert.deepEqual([left.plan.kind, left.plan.steps.map(step => step.do)], ['finish_recovery', ['release-lock']]);
  assert.equal(existsSync(join(late.root, LOCK)), false);
});

test('a back-out killed after any of its steps continues when run again: never taken for an undo, and the older version is still checked', async (t) => {
  const order = ['check-formats', 'check-fingerprint', 'mark-backing-out', 'write-manifest', 'check-start', 'move-aside', 'archive-journal', 'release-lock'];
  // Killed after the journal was archived: the lock already says `recover`, so it is told as the recovery it was.
  const expected = ['back_out_switch', 'back_out_switch', 'back_out_switch', 'continue_back_out', 'continue_back_out', 'continue_back_out', 'finish_recovery', 'nothing'];
  for (let k = 1; k <= order.length; k += 1) {
    const s = await newerInPlace(t);
    const shown = await planNativeRecovery({ paths: s.paths, backOut: true, dependencies: deps().dependencies });
    assert.deepEqual(shown.steps.map(step => step.do), order);
    const killed = await stoppedAt(applyNativeRecovery({ paths: s.paths, digest: shown.digest, backOut: true, dependencies: killedAfter(k).dependencies }));
    assert.equal(JSON.parse(readFileSync(killed.record, 'utf8')).steps.length, k - 1, `killed after ${order[k - 1]}`);
    // Once the newer programs moved aside, the older version had started (they move only after that):
    // it is not checked again, and a check that would fail now never writes back a descriptor naming moved programs.
    const moved = k > order.indexOf('move-aside');
    const d = moved ? deps({ checkStart: async () => { throw new Error('would not start now'); } }) : deps();
    const { plan, result } = await recover(s.paths, d, { backOut: true });
    assert.equal(plan.kind, expected[k - 1], `killed after ${order[k - 1]}`);
    if (plan.kind === 'continue_back_out' && !moved) {
      assert.equal(plan.steps[0].do, 'check-start');
      assert.deepEqual(d.log, ['start 5.26.0'], 'the older version is checked on the store the newer one opened');
    }
    if (plan.kind === 'continue_back_out' && moved) {
      assert.deepEqual(plan.steps.map(step => step.do), ['archive-journal', 'release-lock'], 'killed after the newer programs moved: the check already passed');
    }
    if (result.status) assert.equal(result.status, 'recovered');
    assert.deepEqual(manifestOf(s.paths), s.previous);
    assert.equal(existsSync(join(s.root, 'neo4j-transaction.json')), false);
    assert.equal(existsSync(join(s.root, 'neo4j-assets', 'jvs-a-2222')), false, 'the newer programs are set aside');
    assert.equal(existsSync(join(s.root, LOCK)), false);
  }
  // Continued, and the older version does not start: the newer descriptor is written back and finishing is offered again.
  const s = await newerInPlace(t);
  const shown = await planNativeRecovery({ paths: s.paths, backOut: true, dependencies: deps().dependencies });
  await stoppedAt(applyNativeRecovery({ paths: s.paths, digest: shown.digest, backOut: true, dependencies: killedAfter(order.indexOf('write-manifest') + 1).dependencies }));
  assert.equal((await stoppedAt(recover(s.paths, deps({ checkStart: async () => { throw new Error('store too new'); } })))).reason, 'start_failed');
  assert.deepEqual(manifestOf(s.paths), s.next);
  const again = await planNativeRecovery({ paths: s.paths, dependencies: deps().dependencies });
  assert.deepEqual([again.kind, again.alternative?.kind], ['finish_switch', 'back_out_switch']);
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

test('the programs in use stay when the descriptor spells their directory another way', async (t) => {
  const { paths, root } = runtime(t);
  const home = asset(root, '3333', '5.26.0');
  // Not normalised everywhere; on Windows also in another letter case and with forward slashes, as another --data-dir may have written it.
  const spelled = process.platform === 'win32'
    ? home.toUpperCase().replaceAll('\\', '/')
    : `${join(root, 'neo4j-assets', 'elsewhere')}/../jvs-a-3333/neo4j-community-5.26.0`;
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify({ status: 'ready', neo4jHome: spelled, neo4jAssetFingerprint: 'fp' }));
  await acquireNeo4jLifecycleLock(root, { operation: 'update', identify: holderIdentity });
  const plan = await planNativeRecovery({ paths, dependencies: deps().dependencies });
  assert.equal(plan.kind, 'clear_interrupted');
  assert.deepEqual(plan.steps.filter(step => step.do === 'move-aside'), [], 'nothing in use moves aside');
});

test('the commands a person types by hand work in PowerShell on Windows', async () => {
  const { killCommand, moveIntoCommand } = await import('../src/cli/recovery-plan-text.js');
  assert.equal(moveIntoCommand('/x/recovered/by-hand', '/x/.neo4j-lifecycle.lock', 'darwin'),
    'mkdir -p "/x/recovered/by-hand" && mv "/x/.neo4j-lifecycle.lock" "/x/recovered/by-hand/"');
  const windows = moveIntoCommand('C:\\x\\recovered\\by-hand', 'C:\\x\\.neo4j-lifecycle.lock', 'win32');
  assert.equal(windows, 'New-Item -ItemType Directory -Force -Path "C:\\x\\recovered\\by-hand" | Out-Null; Move-Item -LiteralPath "C:\\x\\.neo4j-lifecycle.lock" -Destination "C:\\x\\recovered\\by-hand"');
  assert.doesNotMatch(windows, /&&|mkdir -p/, 'Windows PowerShell 5.1 has neither');
  assert.equal(killCommand([66, 67], 'linux'), 'kill 66 67');
  assert.equal(killCommand([66, 67], 'win32'), 'Stop-Process -Id 66,67');
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

async function interruptedLoad(t, restorePoint, holder = {}) {
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
    details: point ? { restorePoint: typeof point === 'function' ? point(load, copy) : point, ...holder } : {} });
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
  assert.deepEqual(plan.steps.map(step => step.do), ['restore', 'mark-restored', 'move-aside', 'move-aside', 'check-start', 'release-lock']);
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
  assert.deepEqual([fresh.kind, fresh.restorePoint, fresh.steps.map(step => step.do)], ['restore_load', null, ['mark-restored', 'move-aside', 'move-aside', 'check-start', 'release-lock']]);
});

test('a load whose graph is back releases its lock even when Neo4j does not start, says why, and never imports twice; a copy that fails its checks says so', async (t) => {
  const load = await interruptedLoad(t);
  const port = Object.assign(new Error('port 7687 in use'), { startupFailure: { code: 'port_taken', port: 7687, pid: 55 } });
  const failing = deps({ checkStart: async () => { throw new Error('Neo4j did not start', { cause: port }); } });
  const { result } = await recover(load.paths, failing);
  assert.equal(result.status, 'recovered');
  assert.equal(existsSync(join(load.root, LOCK)), false, 'the graph is back, so the lock protects nothing any more');
  assert.deepEqual(result.startFailure.failure, { code: 'port_taken', port: 7687, pid: 55 }, 'why it did not start is in the result');
  assert.deepEqual(result.startFailure.logs, [join(load.paths.nativePersonalDir, 'logs'), join(load.paths.nativeWorkspaceDir, 'logs')]);
  assert.equal(failing.log.filter(entry => entry.startsWith('restore')).length, 1, 'imported once');
  assert.equal(JSON.parse(readFileSync(result.record, 'utf8')).startFailure.failure.code, 'port_taken');
  const { recoveredLine } = await import('../src/cli/recovery-plan-text.js');
  assert.match(recoveredLine(result), /锁已解除.+端口 7687 被进程 55 占着.+运行 fuli start/s);

  // Killed after the restore was recorded: running again only checks the start and releases the lock.
  for (const k of [2, 3]) {
    const killed = await interruptedLoad(t);
    const shown = await planNativeRecovery({ paths: killed.paths, dependencies: deps().dependencies });
    await stoppedAt(applyNativeRecovery({ paths: killed.paths, digest: shown.digest, dependencies: killedAfter(k).dependencies }));
    const again = deps({ checkStart: async () => { throw new Error('no answer'); } });
    const rerun = await recover(killed.paths, again);
    assert.deepEqual(rerun.plan.steps.map(step => step.do), [...(k === 2 ? ['move-aside', 'move-aside'] : ['move-aside']), 'check-start', 'release-lock'], `killed after step ${k}`);
    assert.equal(rerun.plan.restored, true);
    assert.equal(again.log.some(entry => entry.startsWith('restore')), false, 'not imported a second time');
    assert.equal(rerun.result.status, 'recovered');
    assert.equal(existsSync(join(killed.root, LOCK)), false);
  }
  const damaged = await interruptedLoad(t);
  const bad = await stoppedAt(recover(damaged.paths, deps({ restore: async () => { throw Object.assign(new Error('checksum'), { copyDamaged: true }); } })));
  assert.deepEqual([bad.reason, bad.facts.why, bad.facts.backupPath], ['restore_point_damaged', 'damaged', damaged.copy]);
  assert.ok(existsSync(join(damaged.root, LOCK)));
});

// A load whose stores were being written in both instances.
function bothStores(load) {
  for (const instance of [load.paths.nativePersonalDir, load.paths.nativeWorkspaceDir]) {
    for (const store of ['databases', 'transactions']) mkdirSync(join(instance, 'data', store, 'neo4j'), { recursive: true });
  }
  return load;
}

test('an import whose copy is unknown, gone or damaged is abandoned only on request: its half-written databases move aside and the copies left are listed', async (t) => {
  const abandon = paths => planNativeRecovery({ paths, abandonImport: true, dependencies: deps().dependencies });
  // An older FULI's lock that names no copy: every graph counts, and says so.
  const unknown = await interruptedLoad(t, null);
  assert.equal((await planNativeRecovery({ paths: unknown.paths, dependencies: deps().dependencies })).reason, 'restore_point_unknown');
  const plan = await abandon(unknown.paths);
  // personal holds no store at all: nothing of it is there to move.
  assert.deepEqual([plan.kind, plan.copyProblem, plan.allInstances, plan.instances], ['abandon_load', 'unrecorded', true, ['workspace']]);
  assert.deepEqual(plan.steps.map(step => step.do), ['mark-abandoning', 'move-aside', 'move-aside', 'release-lock']);
  assert.deepEqual(plan.copies.map(copy => copy.path), [join(unknown.paths.graphBackupDir, 'before-import-2026-11-22T09-00-00-000Z-b'), unknown.copy],
    'the copies an import can bring back, newest first');
  assert.equal(plan.copies[0].createdAt, '2026-11-22T00:00:00.000Z');
  const { result } = await recover(unknown.paths, deps(), { abandonImport: true });
  assert.equal(result.status, 'recovered');
  assert.ok(existsSync(join(folderOf(unknown.root), 'workspace', 'data', 'databases', 'neo4j')), 'moved aside, not deleted');
  assert.equal(existsSync(join(unknown.paths.nativeWorkspaceDir, 'data', 'databases', 'neo4j')), false);
  assert.equal(existsSync(join(unknown.root, LOCK)), false);

  // Its own copy is gone: that copy is not offered back.
  const gone = bothStores(await interruptedLoad(t));
  rmSync(gone.copy, { recursive: true });
  const missing = await abandon(gone.paths);
  assert.deepEqual([missing.copyProblem, missing.backupPath, missing.allInstances, missing.instances], ['missing', gone.copy, false, ['personal', 'workspace']]);
  assert.deepEqual(missing.copies.map(copy => copy.path), [join(gone.paths.graphBackupDir, 'before-import-2026-11-22T09-00-00-000Z-b')]);

  // Its checksums do not match: the ordinary plan would restore it, abandoning checks it first.
  const corrupt = await interruptedLoad(t);
  writeFileSync(join(corrupt.copy, 'personal.dump'), 'not the dump that was taken');
  assert.equal((await planNativeRecovery({ paths: corrupt.paths, dependencies: deps().dependencies })).kind, 'restore_load');
  assert.equal((await abandon(corrupt.paths)).copyProblem, 'damaged');

  // A copy that can be used, or no import at all: nothing to abandon.
  assert.equal((await abandon((await interruptedLoad(t, { path: null, instances: [], loading: ['workspace'] })).paths)).reason, 'restore_point_usable');
  const dump = runtime(t);
  await acquireNeo4jLifecycleLock(dump.root, { operation: 'dump', identify: holderIdentity });
  assert.equal((await abandon(dump.paths)).reason, 'no_import');
});

test('abandoning an import killed after any of its steps is finished by running it again', async (t) => {
  for (let k = 1; k <= 6; k += 1) {
    const load = bothStores(await interruptedLoad(t));
    rmSync(load.copy, { recursive: true });
    const shown = await planNativeRecovery({ paths: load.paths, abandonImport: true, dependencies: deps().dependencies });
    assert.deepEqual(shown.steps.map(step => step.do), ['mark-abandoning', 'move-aside', 'move-aside', 'move-aside', 'move-aside', 'release-lock']);
    await stoppedAt(applyNativeRecovery({ paths: load.paths, digest: shown.digest, abandonImport: true, dependencies: killedAfter(k).dependencies }));
    const { plan, result } = await recover(load.paths, deps(), { abandonImport: true });
    if (k === 6) assert.equal(plan.kind, 'nothing', 'killed after its lock went: nothing is left');
    else assert.deepEqual([plan.kind, plan.steps.length, result.status], ['abandon_load', 6 - k, 'recovered']);
    if (k > 1 && k < 6) assert.equal(plan.steps.some(step => step.do === 'mark-abandoning'), false, `${k}: the judgement recorded before is used, not made again`);
    assert.equal(readdirSync(join(load.root, 'recovered')).filter(name => !name.endsWith('.json')).length, 1, `${k}: one folder, not split across runs`);
    for (const instance of ['personal', 'workspace']) {
      for (const store of ['databases', 'transactions']) assert.ok(existsSync(join(folderOf(load.root), instance, 'data', store, 'neo4j')), `${k}: ${instance} ${store}`);
    }
    assert.equal(existsSync(join(load.root, LOCK)), false);
  }
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
  // As old as the oldest, with as many newer recoveries after it, but holding graph data: never deleted by the rule.
  const graphs = ['2026-08-01T00-00-00-000Z', '2026-08-02T00-00-00-000Z'];
  mkdirSync(join(root, 'recovered', graphs[0], 'personal', 'data', 'databases', 'neo4j'), { recursive: true });
  mkdirSync(join(root, 'recovered', graphs[1], 'workspace', 'transactions', 'neo4j'), { recursive: true });
  await acquireNeo4jLifecycleLock(root, { operation: 'dump', identify: holderIdentity });
  // The oldest cannot be deleted: the recovery still counts, and says what stayed.
  // Windows ignores a directory's read-only bit when deleting it, so there the
  // oldest goes like the other (what stays is reported the same way on every platform).
  const undeletable = process.platform !== 'win32';
  if (undeletable) chmodSync(join(root, 'recovered', stamps[0]), 0o500);
  const { plan, result } = await recover(paths, deps());
  if (undeletable) chmodSync(join(root, 'recovered', stamps[0]), 0o700);
  assert.deepEqual(plan.steps.map(step => step.do), ['release-lock', 'prune', 'prune'], 'deleted only once the lock is released');
  assert.deepEqual(plan.steps.filter(step => step.do === 'prune').map(step => [step.path, step.keepRuns, step.keepDays]),
    [[join(root, 'recovered', stamps[0]), 3, 30], [join(root, 'recovered', stamps[1]), 3, 30]], 'beyond the 3 newest and over 30 days old');
  assert.equal(result.status, 'recovered');
  assert.deepEqual((result.notDeleted ?? []).map(({ path }) => path), undeletable ? [join(root, 'recovered', stamps[0])] : []);
  assert.equal(readdirSync(join(root, 'recovered')).includes(stamps[0]), undeletable);
  assert.equal(existsSync(join(root, LOCK)), false, 'a folder that stays never keeps the lock');
  const left = readdirSync(join(root, 'recovered'));
  for (const stamp of stamps.slice(2)) assert.ok(left.includes(stamp));
  assert.ok(left.includes('kept-by-a-person'), 'nothing else is touched');
  assert.equal(left.includes(stamps[1]), false);
  for (const stamp of graphs) assert.ok(left.includes(stamp), `${stamp}: a folder with graph data stays for a person to delete`);
  assert.deepEqual(result.keptGraphData.map(folder => [folder.path, folder.instances]),
    [[join(root, 'recovered', graphs[0]), ['personal']], [join(root, 'recovered', graphs[1]), ['workspace']]]);
  assert.deepEqual(result.keptGraphData[0].stores.map(({ from, to }) => [from, to]),
    [[join(root, 'recovered', graphs[0], 'personal', 'data', 'databases', 'neo4j'), join(root, 'personal', 'data', 'databases', 'neo4j')]], 'and where it goes back');
});

test('fuli graph runtime recover shows the plan, recovers only for a person at a terminal, and says why it will not', async () => {
  const { parseNativeRuntimeOptions, runNativeRuntimeCommand } = await import('../src/cli/native-runtime-command.js');
  const { readStartupFailure, startupFailureLine } = await import('../src/local-runtime/startup-failure-line.js');
  const written = [];
  const plan = { kind: 'release_dump', operation: 'dump', steps: [{ do: 'release-lock' }], digest: '0123456789abcdef' };
  const applied = [];
  const run = (args, { planned = plan, interactive = true, apply, typed = '' } = {}) => runNativeRuntimeCommand(args, { platform: 'darwin',
    write: line => written.push(line), interactive, confirmAbandon: async () => typed === 'abandon',
    resolvePaths: () => ({ dataDir: '/x/fuli-data', nativeRuntimeDir: '/x/fuli-data/native-runtime' }),
    planRecovery: async () => planned,
    applyRecovery: apply ?? (async ({ digest, abandonImport }) => { applied.push(abandonImport ? `abandon ${digest}` : digest); return { ...planned, status: 'recovered', record: '/x/r/recovery-1.json' }; }) });
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
    /已损坏.+--abandon-import/);
  // Abandoning an import takes the typed word in a terminal: never --yes, never without a terminal.
  const abandon = { kind: 'abandon_load', copyProblem: 'missing', backupPath: '/x/b', instances: ['personal'], allInstances: false,
    dataDir: '/x/fuli-data', copies: [], steps: [{ do: 'release-lock' }], digest: 'aaaaaaaaaaaaaaaa' };
  await assert.rejects(run(['recover', '--abandon-import', '--yes', '--expect', 'aaaaaaaaaaaaaaaa'], { planned: abandon }), (error) => reasonOf(error) === 'abandon_needs_typing');
  await assert.rejects(run(['recover', '--abandon-import'], { planned: abandon, interactive: false, typed: 'abandon' }), (error) => reasonOf(error) === 'needs_person');
  assert.equal((await run(['recover', '--abandon-import'], { planned: abandon, typed: 'y' })).status, 'cancelled');
  assert.equal((await run(['recover', '--abandon-import'], { planned: abandon, typed: 'abandon' })).status, 'recovered');
  assert.match(written.at(-1), /运行 fuli start 检查能不能启动.+Run `fuli start` to check it starts/s, 'after abandoning, it says to check the start');
  assert.deepEqual(applied, ['0123456789abcdef', 'abandon aaaaaaaaaaaaaaaa']);
  assert.throws(() => parseNativeRuntimeOptions(['recover', '--back-out', '--abandon-import']), /choose one/);
  assert.throws(() => parseNativeRuntimeOptions(['recover', '--keep-newer', '--back-out']), /choose one/);
  assert.equal(parseNativeRuntimeOptions(['recover', '--keep-newer']).keepNewer, true);
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
    'restore_failed', 'restore_point_unknown', 'restore_point_damaged', 'restore_point_usable', 'no_import', 'abandon_needs_typing',
    'lock_changed', 'step_failed', 'plan_changed', 'needs_person', 'recovery_running', 'keep_newer_unavailable', 'back_out_available']) {
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
  // Giving up an import says why the copy cannot be used, which graphs end up empty, where the databases go, and how to import back.
  const abandon = formatRecoveryPlan({ kind: 'abandon_load', copyProblem: 'damaged', backupPath: '/x/b/before-import-1', instances: ['personal', 'workspace'],
    written: ['personal'], unsure: ['workspace'], untouched: [], folder: '/x/fuli-data/native-runtime/recovered/2026-11-22T00-00-00-000Z',
    moveBack: [{ from: '/x/fuli-data/native-runtime/recovered/2026-11-22T00-00-00-000Z/personal/data/databases/neo4j', to: '/x/fuli-data/native-runtime/personal/data/databases/neo4j' }],
    allInstances: true, dataDir: '/x/fuli-data', copies: [{ path: '/x/fuli-data/backups/graph/before-import-0', createdAt: '2026-11-20T00:00:00.000Z', bytes: 2048, instances: ['personal'] }],
    steps: [{ do: 'move-aside', path: '/x/fuli-data/native-runtime/personal/data/databases/neo4j', bytes: 1024 }, { do: 'release-lock' },
      { do: 'prune', path: '/x/fuli-data/native-runtime/recovered/2026-09-01T00-00-00-000Z', bytes: 1024, keepRuns: 4, keepDays: 40 }] });
  assert.match(abandon, /已损坏（读不出或校验和不对）：\/x\/b\/before-import-1/);
  assert.match(abandon, /没有记下导入的是哪些图谱，所以每个图谱都按文件的修改时间判断/);
  assert.match(abandon, /fuli graph import --input "\/x\/fuli-data\/backups\/graph\/before-import-0" --data-dir "\/x\/fuli-data" --yes/);
  assert.match(abandon, /永久删除旧的恢复文件夹 .+超过 40 天，之后又有至少 4 次恢复/, 'the clean-up says it deletes, by the rule the plan carries');
  assert.match(abandon, /personal：看文件的修改时间，导入开始后它的库被写过，可能只写了一半/);
  assert.match(abandon, /workspace：判断不了它有没有被这次导入写过.+为安全起见一起挪开，不删除.+怎么搬回来见下面/);
  assert.match(abandon, /确认之后，再运行恢复只会接着把放弃做完，不会再自动导回；想回到导入前，请用下面列出的导回命令/);
  assert.match(abandon, /Abandon .+whether this import wrote it cannot be told/s);
  assert.match(abandon, /先退出 FULI（fuli stop）.+\n  mv "\/x\/fuli-data\/native-runtime\/recovered\/2026-11-22T00-00-00-000Z\/personal\/data\/databases\/neo4j" "\/x\/fuli-data\/native-runtime\/personal\/data\/databases\/neo4j"/s,
    'how to move it back, with the paths filled in');
  assert.match(formatRecoveryPlan({ ...JSON.parse(JSON.stringify({ kind: 'abandon_load', copyProblem: 'missing', backupPath: '/x/b', instances: ['personal'], dataDir: '/x/d', copies: [], steps: [] })) }),
    /里没有可以导回的导入前副本/);
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
  // The state it reports is the one FULI is in, not assumed.
  const degraded = async (_context, args) => ({ code: 0, stdout: JSON.stringify({ status: args[0] === 'status' ? 'degraded' : 'x' }), stderr: '' });
  assert.equal((await runTrayAction('recover-preview', context, { runCli: degraded, recovery })).status, 'degraded');
  const started = await runTrayAction('recover-start', context, { runCli, recovery, recoveryDigest: '0123456789abcdef', otherConsole: () => null,
    holdAdoption: () => null, portBlocked: async () => false });
  assert.ok(calls.indexOf('recover 0123456789abcdef') < calls.findIndex(call => call.startsWith('setup')), 'it starts only after the recovery');
  assert.equal(started.recoveryRecord, '/x/r.json');
  assert.equal(calls.some(call => call.startsWith('graph runtime recover')), false, 'never through the CLI');
  const refusing = { ...recovery, apply: async () => ({ kind: 'refused', reason: 'plan_changed' }) };
  const refused = await runTrayAction('recover-start', context, { runCli, recovery: refusing, recoveryDigest: '0123456789abcdef' });
  assert.deepEqual([refused.ok, refused.failure.code, refused.failure.reason], [false, 'recovery_refused', 'plan_changed']);
  await assert.rejects(runTrayAction('recover-start', context, { runCli, recovery }), /needs the digest/);
  // 「放弃这次导入…」 asks for the abandoning plan and applies it by its own digest.
  const choices = [];
  const abandoning = { plan: async (_paths, choice) => { choices.push(['plan', choice]); return { kind: 'abandon_load', steps: [], digest: 'aaaaaaaaaaaaaaaa' }; },
    apply: async (_paths, digest, choice) => { choices.push([digest, choice]); return { kind: 'abandon_load', status: 'recovered', record: '/x/r.json' }; } };
  await runTrayAction('abandon-import-preview', context, { runCli, recovery: abandoning });
  await runTrayAction('abandon-import-start', context, { runCli, recovery: abandoning, recoveryDigest: 'aaaaaaaaaaaaaaaa', otherConsole: () => null,
    holdAdoption: () => null, portBlocked: async () => false });
  assert.deepEqual(choices, [['plan', { abandonImport: true }], ['aaaaaaaaaaaaaaaa', { abandonImport: true }]]);
});

test('abandoning an import moves aside only the instance written since its lock; the other stays where it is', async (t) => {
  const load = await interruptedLoad(t, { path: join('nowhere'), instances: ['personal'], loading: ['personal', 'workspace'] });
  // personal was last written an hour before this load took its lock; workspace (made before the lock in interruptedLoad) is touched now.
  for (const store of ['data/databases/neo4j', 'transactions/neo4j']) {
    const dir = join(load.paths.nativePersonalDir, store);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'store'), 'intact');
    const hourAgo = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(join(dir, 'store'), hourAgo, hourAgo);
    utimesSync(dir, hourAgo, hourAgo);
  }
  mkdirSync(join(load.paths.nativeWorkspaceDir, 'transactions', 'neo4j'), { recursive: true });
  writeFileSync(join(load.paths.nativeWorkspaceDir, 'data', 'databases', 'neo4j', 'half'), 'written');
  const plan = await planNativeRecovery({ paths: load.paths, abandonImport: true, dependencies: deps().dependencies });
  assert.deepEqual([plan.kind, plan.written, plan.unsure, plan.untouched], ['abandon_load', ['workspace'], [], ['personal']]);
  assert.deepEqual(plan.steps.filter(step => step.do === 'move-aside').map(step => step.path).sort(),
    [join(load.paths.nativeWorkspaceDir, 'data', 'databases', 'neo4j'), join(load.paths.nativeWorkspaceDir, 'data', 'transactions', 'neo4j'),
      join(load.paths.nativeWorkspaceDir, 'transactions', 'neo4j')].sort(), 'the transaction logs FULI keeps in <instance>/transactions go too');
  const { result } = await recover(load.paths, deps(), { abandonImport: true });
  assert.equal(result.status, 'recovered');
  assert.equal(readFileSync(join(load.paths.nativePersonalDir, 'data', 'databases', 'neo4j', 'store'), 'utf8'), 'intact', 'not written, not moved');
  assert.equal(existsSync(join(load.paths.nativeWorkspaceDir, 'data', 'databases', 'neo4j')), false);
  // The command the plan gave moves it back to exactly where it was.
  for (const { from, to } of plan.moveBack) { assert.ok(existsSync(from), from); assert.ok(to.startsWith(load.paths.nativeWorkspaceDir)); }
  assert.equal(plan.folder, folderOf(load.root));
});

test('a switch whose newer version does not start and cannot be backed out offers keeping it and releasing the lock, and its words never point to the missing choice', async (t) => {
  const { formatRecoveryPlan } = await import('../src/cli/recovery-plan-text.js');
  const stuck = await newerInPlace(t, { fingerprint: null });
  const failing = deps({ checkStart: async () => { throw new Error('no answer'); } });
  const stopped = await stoppedAt(recover(stuck.paths, failing));
  assert.deepEqual([stopped.reason, stopped.facts.alternative, stopped.facts.alternativeRefused], ['start_failed', null, 'no_fingerprint']);
  const words = formatRecoveryPlan({ kind: 'refused', reason: stopped.reason, planKind: stopped.planKind, ...stopped.facts });
  assert.doesNotMatch(words, /--back-out|另一种做法|other choice/, 'going back is not there, so it is not offered');
  assert.match(words, /--keep-newer/);
  // A plain substring: a Windows path's backslashes would be escapes in a pattern.
  assert.ok(words.includes(`fuli graph import --input "${stuck.next.previousNeo4jAsset.graphBackup}" --yes`), 'the backup and the command that imports it');
  // With going back possible, both are named.
  const both = await newerInPlace(t);
  const other = await stoppedAt(recover(both.paths, failing));
  assert.equal(other.facts.alternative, 'back_out_switch');
  const otherWords = formatRecoveryPlan({ kind: 'refused', reason: other.reason, planKind: other.planKind, ...other.facts });
  assert.match(otherWords, /取消更新、留在 5\.26\.0：fuli graph runtime recover --back-out/);
  assert.doesNotMatch(otherWords, /--keep-newer/, 'going back is still possible, so finishing without a start check is not offered');

  // Keeping the newer version: no start, the journal is archived, the lock goes, the descriptor stays.
  const plan = await planNativeRecovery({ paths: stuck.paths, keepNewer: true, dependencies: deps().dependencies });
  assert.deepEqual([plan.kind, plan.steps.map(step => step.do)], ['keep_newer', ['archive-journal', 'release-lock']]);
  assert.match(formatRecoveryPlan(plan), /完成这次没做完的更新，留在 5\.26\.28，并解除这把锁.+不能再取消这次更新回到 5\.26\.0.+升级前的图备份在/s);
  const d = deps();
  const result = await applyNativeRecovery({ paths: stuck.paths, digest: plan.digest, keepNewer: true, dependencies: d.dependencies });
  assert.equal(result.status, 'recovered');
  assert.deepEqual(d.log, [], 'nothing was started');
  assert.deepEqual(manifestOf(stuck.paths), stuck.next);
  assert.equal(existsSync(join(stuck.root, LOCK)), false);
  assert.ok(existsSync(join(folderOf(stuck.root), 'neo4j-transaction.json')));
  // Only for a switch whose newer descriptor is in place.
  const { paths, root } = runtime(t);
  const previous = { status: 'ready', neo4jVersion: '5.26.0', neo4jHome: join(root, 'neo4j-community-5.26.0') };
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify(previous));
  await acquireNeo4jLifecycleLock(root, { operation: 'update', identify: holderIdentity });
  switchJournal(root, { previous, next: { ...previous, neo4jVersion: '5.26.28', neo4jHome: asset(root, '8888', '5.26.28') } });
  assert.equal((await planNativeRecovery({ paths, keepNewer: true, dependencies: deps().dependencies })).reason, 'keep_newer_unavailable');
});

test('a recovery claims the lock before its first step, so a second one started meanwhile is refused and says another recovery runs', async (t) => {
  const { formatRecoveryPlan } = await import('../src/cli/recovery-plan-text.js');
  const load = await interruptedLoad(t);
  // Recovery A is process 1001 and still runs; B is process 1002.
  const identity = { state: pid => pid === 1001 ? 'running' : 'gone', startTime: async () => 'Mon Nov 23 03:00:00 2026', matches: async pid => pid === 1001 };
  const me = pid => async () => ({ pid, command: 'node /x/cli.js', startedAt: 'Mon Nov 23 03:00:00 2026' });
  let second = null;
  const a = deps({ identity, whoami: me(1001), restore: async () => {
    const b = deps({ identity, whoami: me(1002) });
    const plan = await planNativeRecovery({ paths: load.paths, dependencies: b.dependencies });
    second = { plan, applied: await applyNativeRecovery({ paths: load.paths, digest: 'aaaaaaaaaaaaaaaa', dependencies: b.dependencies }) };
  } });
  const shown = await planNativeRecovery({ paths: load.paths, dependencies: a.dependencies });
  const holderAt = readLock(load.root).holder.at;
  const result = await applyNativeRecovery({ paths: load.paths, digest: shown.digest, dependencies: a.dependencies });
  assert.equal(result.status, 'recovered');
  assert.deepEqual([second.plan.reason, second.plan.pid, second.applied.reason], ['recovery_running', 1001, 'recovery_running']);
  assert.match(formatRecoveryPlan(second.plan), /另一个恢复（进程 1001）正在进行/);
  assert.ok(holderAt, 'the claim kept when the load took its lock');
});

// The copy interruptedLoad names, made good: its dump is there and matches its checksum.
function goodCopy(load) {
  writeFileSync(join(load.copy, 'personal.dump'), 'personal before the import');
  const sha256 = createHash('sha256').update('personal before the import').digest('hex');
  writeFileSync(join(load.copy, 'manifest.json'), JSON.stringify({ format: 'fuli-neo4j-backup', version: 1, createdAt: '2026-11-22T00:00:00.000Z',
    sourceMode: 'native', instances: [{ id: 'personal', file: 'personal.dump', sha256 }] }));
  return load;
}

test('abandoning an import moves only the graph it was writing: one it finished holds the new data, and the words say so', async (t) => {
  const { formatRecoveryPlan } = await import('../src/cli/recovery-plan-text.js');
  // personal was imported whole; the import was killed half way through workspace, and its copy is gone.
  const load = bothStores(await interruptedLoad(t, undefined, { graphStates: { personal: 'imported', workspace: 'writing' } }));
  rmSync(load.copy, { recursive: true });
  const plan = await planNativeRecovery({ paths: load.paths, abandonImport: true, dependencies: deps().dependencies });
  assert.deepEqual([plan.halfWritten, plan.imported, plan.beforeImport, plan.instances], [['workspace'], ['personal'], [], ['workspace']]);
  assert.ok(plan.steps.filter(step => step.do === 'move-aside').every(step => step.path.startsWith(load.paths.nativeWorkspaceDir)), 'only workspace moves');
  const words = formatRecoveryPlan(plan);
  assert.match(words, /personal：已经完整导入了这次的新数据，留在原位。放弃导入不会让它回到导入前。这次导入前的副本用不了/);
  assert.match(words, /personal: it already holds all of this import's new data/);
  assert.match(words, /workspace：这次导入写它的时候停下了（被打断或失败），可能只写了一半/);
  const { result } = await recover(load.paths, deps(), { abandonImport: true });
  assert.equal(result.status, 'recovered');
  assert.ok(existsSync(join(load.paths.nativePersonalDir, 'data', 'databases', 'neo4j')), 'personal stays');
  assert.equal(existsSync(join(load.paths.nativeWorkspaceDir, 'data', 'databases', 'neo4j')), false);

  // Not reached yet: still the data from before.
  const early = bothStores(await interruptedLoad(t, undefined, { graphStates: { personal: 'writing', workspace: 'untouched' } }));
  rmSync(early.copy, { recursive: true });
  const first = await planNativeRecovery({ paths: early.paths, abandonImport: true, dependencies: deps().dependencies });
  assert.deepEqual([first.halfWritten, first.imported, first.beforeImport], [['personal'], [], ['workspace']]);
  assert.match(formatRecoveryPlan(first), /workspace：还是导入前的数据，留在原位/);
  // A graph the lock names no state for is judged by its file times, the others by their state.
  const mixed = bothStores(await interruptedLoad(t, undefined, { graphStates: { personal: 'imported' } }));
  rmSync(mixed.copy, { recursive: true });
  const partly = await planNativeRecovery({ paths: mixed.paths, abandonImport: true, dependencies: deps().dependencies });
  assert.deepEqual([partly.imported, partly.written, partly.allInstances], [['personal'], ['workspace'], false]);
});

test('abandoning killed between moving a graph\'s database and its transaction logs puts both in one folder when run again', async (t) => {
  const load = bothStores(await interruptedLoad(t, undefined, { graphStates: { personal: 'imported', workspace: 'writing' } }));
  rmSync(load.copy, { recursive: true });
  const shown = await planNativeRecovery({ paths: load.paths, abandonImport: true, dependencies: deps().dependencies });
  assert.deepEqual(shown.steps.map(step => step.do), ['mark-abandoning', 'move-aside', 'move-aside', 'release-lock']);
  await stoppedAt(applyNativeRecovery({ paths: load.paths, digest: shown.digest, abandonImport: true, dependencies: killedAfter(2).dependencies }));
  // Run again as an ordinary recovery: the recorded judgement is finished all the same.
  const { plan, result } = await recover(load.paths, deps());
  assert.deepEqual([plan.kind, plan.steps.map(step => step.do), result.status], ['abandon_load', ['move-aside', 'release-lock'], 'recovered']);
  assert.equal(readdirSync(join(load.root, 'recovered')).filter(name => !name.endsWith('.json')).length, 1);
  for (const store of ['databases', 'transactions']) assert.ok(existsSync(join(folderOf(load.root), 'workspace', 'data', store, 'neo4j')), store);
  assert.ok(existsSync(join(load.paths.nativePersonalDir, 'data', 'databases', 'neo4j')));

  // An older FULI's lock, judged by file times: the transaction logs left behind are old, but the database already moved, so they follow.
  const old = await interruptedLoad(t, null);
  const folder = join(old.root, 'recovered', '2026-11-23T03-00-00-000Z');
  const hourAgo = (Date.now() - 60 * 60_000) / 1000;
  utimesSync(join(old.paths.nativeWorkspaceDir, 'data', 'transactions', 'neo4j'), hourAgo, hourAgo);
  mkdirSync(join(folder, 'workspace', 'data', 'databases'), { recursive: true });
  renameSync(join(old.paths.nativeWorkspaceDir, 'data', 'databases', 'neo4j'), join(folder, 'workspace', 'data', 'databases', 'neo4j'));
  const lock = readLock(old.root);
  writeFileSync(join(lock.path, 'holder.json'), JSON.stringify({ ...lock.holder, at: new Date(NOW).toISOString() }));
  const legacy = await planNativeRecovery({ paths: old.paths, abandonImport: true, dependencies: deps().dependencies });
  assert.deepEqual([legacy.written, legacy.untouched], [['workspace'], []]);
});

test('a copy that is good but will not go back says why, and abandoning the import is open after it, keeping that copy listed', async (t) => {
  const { formatRecoveryPlan } = await import('../src/cli/recovery-plan-text.js');
  const load = goodCopy(bothStores(await interruptedLoad(t, undefined, { graphStates: { personal: 'imported', workspace: 'writing' } })));
  const failing = { restore: async (_copy, _owner, mark) => {
    await mark('personal', 'restoring');
    await mark('personal', 'restoreFailed');
    throw new Error('No space left on device');
  }, diskFree: async () => 1024, listProcesses: async () => [{ pid: 66, command: `/opt/java/bin/java -Dneo4j.conf=${load.paths.nativePersonalDir}/conf --secret` }] };
  const stopped = await stoppedAt(recover(load.paths, deps(failing)));
  assert.equal(stopped.reason, 'restore_failed');
  assert.deepEqual([stopped.facts.freeBytes, stopped.facts.holders], [1024, [{ pid: 66, name: 'java' }]], 'a process holding the store is kept by PID and program name only');
  assert.ok(stopped.facts.leastBytes > 0);
  assert.equal(readLock(load.root).holder.restoreFailed.detail, 'No space left on device', 'the failure is recorded in the lock');
  assert.doesNotMatch(JSON.stringify(readLock(load.root).holder.restoreFailed), /neo4j\.conf|--secret/, 'no command line in the lock');
  const words = formatRecoveryPlan({ kind: 'refused', reason: stopped.reason, ...stopped.facts });
  assert.match(words, /磁盘剩余 1\.0 KB，导回至少需要 .+还有进程在用图谱的目录：66（java）.+kill 66/);
  assert.match(words, /副本本身是好的.+--abandon-import/s);
  // The ordinary plan tries again and says abandoning is open; abandoning keeps that copy and says it is good.
  const again = await planNativeRecovery({ paths: load.paths, dependencies: deps().dependencies });
  assert.equal(again.restoreFailed.detail, 'No space left on device');
  assert.match(formatRecoveryPlan(again), /上次导回没有成功.+--abandon-import/s);
  const abandon = await planNativeRecovery({ paths: load.paths, abandonImport: true, dependencies: deps().dependencies });
  assert.deepEqual([abandon.kind, abandon.copyProblem, abandon.restoreUnfinished, abandon.halfWritten], ['abandon_load', 'restore_failed', ['personal'], ['workspace']]);
  assert.ok(abandon.copies.some(copy => copy.path === load.copy), 'the good copy stays offered');
  assert.match(formatRecoveryPlan(abandon), /副本是好的（校验和对得上）.+原因解决后可以用下面列出的 fuli graph import 命令把它导回/s);
  assert.doesNotMatch(formatRecoveryPlan(abandon), /用不了|已损坏|找不到/);
  // Without a failed restore, a good copy is not abandoned.
  const fine = goodCopy(await interruptedLoad(t, undefined, { graphStates: { personal: 'imported', workspace: 'writing' } }));
  assert.equal((await planNativeRecovery({ paths: fine.paths, abandonImport: true, dependencies: deps().dependencies })).reason, 'restore_point_usable');
});

// What the lock of a real import (graph-backup.js) recorded while each of its
// loads ran, in order, with [fails] deciding which loads fail: an import
// killed during load k leaves exactly locks[k] behind.
async function importLocks(t, fails) {
  const { exportGraphData, importGraphData } = await import('../src/backup/graph-backup.js');
  const root = mkdtempSync(join(tmpdir(), 'fuli-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await exportGraphData({ outputDir: join(root, 'source'), sourceMode: 'native', instances: ['personal', 'workspace'],
    adapter: { async stop() { return { resume: false }; }, async dump(id, to) { writeFileSync(to, `new:${id}`); }, async start() {} } });
  const locks = [];
  let graphStates = null;
  await importGraphData({ inputDir: join(root, 'source'), targetMode: 'native', rollbackDir: join(root, 'rollback'), adapter: {
    async stop() { return { resume: false }; }, async dump(id, to) { writeFileSync(to, `old:${id}`); }, async start() {},
    async holdImport(details) {
      graphStates = details.graphStates;
      return { locked: true, async record(patch) { graphStates = patch.graphStates ?? graphStates; }, async release() {} };
    },
    async load(id, from) {
      const rollback = readFileSync(from, 'utf8').startsWith('old:');
      locks.push({ id, rollback, graphStates });
      if (fails(id, rollback)) throw new Error('load failed');
    } } }).catch(() => {});
  return locks;
}

// What abandoning an import whose own copy is gone does with each graph, killed with [graphStates] in its lock.
async function abandonWith(t, graphStates) {
  const load = bothStores(await interruptedLoad(t, undefined, { graphStates }));
  rmSync(load.copy, { recursive: true });
  const plan = await planNativeRecovery({ paths: load.paths, abandonImport: true, dependencies: deps().dependencies });
  const { result } = await recover(load.paths, deps(), { abandonImport: true });
  assert.equal(result.status, 'recovered');
  const stays = id => existsSync(join(id === 'personal' ? load.paths.nativePersonalDir : load.paths.nativeWorkspaceDir, 'data', 'databases', 'neo4j'));
  return { plan, stays };
}

test('an import that failed on its second graph and was killed while rolling the first one back: abandoning moves both, and says why each', async (t) => {
  const { formatRecoveryPlan } = await import('../src/cli/recovery-plan-text.js');
  const locks = await importLocks(t, (id, rollback) => id === 'workspace' && !rollback);
  const killed = locks.find(({ id, rollback }) => id === 'personal' && rollback);
  assert.deepEqual(killed.graphStates, { personal: 'restoring', workspace: 'importFailed' }, 'the failed graph is in the rollback\'s lock');
  const { plan, stays } = await abandonWith(t, killed.graphStates);
  assert.deepEqual([plan.restoreUnfinished, plan.halfWritten, plan.imported, plan.beforeImport], [['personal'], ['workspace'], [], []]);
  assert.deepEqual([stays('personal'), stays('workspace')], [false, false], 'both may be half written: both move aside, nothing deleted');
  const words = formatRecoveryPlan(plan);
  assert.match(words, /personal：把它从这次导入前的副本导回时停下了（被打断或没有成功），可能只写了一半/);
  assert.match(words, /workspace：这次导入写它的时候停下了（被打断或失败），可能只写了一半/);
  assert.doesNotMatch(words, /也可能还是导入前|留在原位/, 'no graph is left in place on a guess');
});

test('an import rollback that failed on one graph and was killed on the next: both move aside, the failed one is never taken for data from before', async (t) => {
  const locks = await importLocks(t, (id, rollback) => (id === 'workspace' && !rollback) || (id === 'personal' && rollback));
  const killed = locks.find(({ id, rollback }) => id === 'workspace' && rollback);
  assert.deepEqual(killed.graphStates, { personal: 'restoreFailed', workspace: 'restoring' });
  const { plan, stays } = await abandonWith(t, killed.graphStates);
  assert.deepEqual([plan.restoreUnfinished, plan.beforeImport], [['personal', 'workspace'], []]);
  assert.deepEqual([stays('personal'), stays('workspace')], [false, false]);
});

test('a restore that failed, then on a retry brought one graph back and was killed on the next: abandoning keeps the one brought back and moves the other', async (t) => {
  const { formatRecoveryPlan } = await import('../src/cli/recovery-plan-text.js');
  // The import was killed writing workspace; its copy (good) holds both graphs.
  const load = bothStores(await interruptedLoad(t, (_load, copy) => ({ path: copy, instances: ['personal', 'workspace'], loading: ['personal', 'workspace'] }),
    { graphStates: { personal: 'imported', workspace: 'writing' } }));
  const entries = ['personal', 'workspace'].map(id => ({ id, file: `${id}.dump`, sha256: createHash('sha256').update(`${id} before`).digest('hex') }));
  for (const id of ['personal', 'workspace']) writeFileSync(join(load.copy, `${id}.dump`), `${id} before`);
  writeFileSync(join(load.copy, 'manifest.json'), JSON.stringify({ format: 'fuli-neo4j-backup', version: 1, createdAt: '2026-11-22T00:00:00.000Z', sourceMode: 'native', instances: entries }));
  // First recovery: personal would not go back (no space).
  const first = await stoppedAt(recover(load.paths, deps({ restore: async (_copy, _owner, mark) => {
    await mark('personal', 'restoring');
    await mark('personal', 'restoreFailed');
    throw new Error('No space left on device');
  }, diskFree: async () => 1024 })));
  assert.equal(first.reason, 'restore_failed');
  assert.equal(readLock(load.root).holder.graphStates.personal, 'restoreFailed');
  // Space freed, tried again: personal is back, then it was killed while workspace was being written.
  await stoppedAt(recover(load.paths, deps({ restore: async (_copy, _owner, mark) => {
    await mark('personal', 'restoring');
    await mark('personal', 'restored');
    await mark('workspace', 'restoring');
    throw new Error('killed');
  } })));
  assert.deepEqual(readLock(load.root).holder.graphStates, { personal: 'restored', workspace: 'restoring' }, 'each graph\'s state was updated before it was written');
  // The window still offers abandoning (the earlier failure); the person takes it.
  const plan = await planNativeRecovery({ paths: load.paths, abandonImport: true, dependencies: deps().dependencies });
  assert.deepEqual([plan.kind, plan.beforeImport, plan.restoreUnfinished, plan.halfWritten, plan.imported], ['abandon_load', ['personal'], ['workspace'], [], []]);
  const words = formatRecoveryPlan(plan);
  assert.match(words, /personal：还是导入前的数据，留在原位/);
  assert.match(words, /workspace：把它从这次导入前的副本导回时停下了.+原因解决后，可以用下面这次导入前的副本把它导回/s);
  const { result } = await recover(load.paths, deps(), { abandonImport: true });
  assert.equal(result.status, 'recovered');
  assert.ok(existsSync(join(load.paths.nativePersonalDir, 'data', 'databases', 'neo4j')), 'personal, brought back, stays');
  assert.equal(existsSync(join(load.paths.nativeWorkspaceDir, 'data', 'databases', 'neo4j')), false, 'workspace, half written, moves aside');
  assert.equal(existsSync(join(load.root, LOCK)), false, 'the record goes with the lock');
});

test('a newer version that does not start and whose programs cannot read the store format can still be kept and unlocked', async (t) => {
  const { formatRecoveryPlan } = await import('../src/cli/recovery-plan-text.js');
  const broken = { storeFormats: async () => { throw new Error('java: bad CPU type'); }, checkStart: async () => { throw new Error('no answer'); } };
  // Read at plan time (nothing runs): going back cannot be checked, so keeping is open at once.
  const stuck = await newerInPlace(t);
  const plan = await planNativeRecovery({ paths: stuck.paths, dependencies: deps(broken).dependencies });
  assert.deepEqual([plan.kind, plan.alternative, plan.alternativeRefused, plan.keepable], ['finish_switch', null, 'format_unreadable', true]);
  const words = formatRecoveryPlan(plan);
  assert.match(words, /不能取消更新、回到 5\.26\.0：读不出存储格式：读它用的是现在生效的这一份程序和 Java/);
  assert.match(words, /如果 5\.26\.28 也起不来，可以完成更新并解除这把锁.+--keep-newer/);
  const finish = await stoppedAt(recover(stuck.paths, deps(broken)));
  assert.deepEqual([finish.reason, finish.facts.keepable], ['start_failed', true]);
  const keep = await planNativeRecovery({ paths: stuck.paths, keepNewer: true, dependencies: deps(broken).dependencies });
  assert.equal(keep.kind, 'keep_newer');
  assert.equal((await applyNativeRecovery({ paths: stuck.paths, digest: keep.digest, keepNewer: true, dependencies: deps(broken).dependencies })).status, 'recovered');
  assert.equal(existsSync(join(stuck.root, LOCK)), false);
  assert.equal(existsSync(join(stuck.root, 'neo4j-transaction.json')), false);
  assert.equal((await planNativeRecovery({ paths: stuck.paths, dependencies: deps(broken).dependencies })).kind, 'nothing', 'an ordinary failed start is next');

  // Services were running at plan time, so going back was offered; it stopped at the format: recorded, and keeping opens.
  const running = await newerInPlace(t);
  writeFileSync(running.paths.nativeProcessStatePath, JSON.stringify({ databases: { personal: { pid: 77, command: 'java' } } }));
  const alive = { state: pid => pid === 77 ? 'running' : 'gone', startTime: async () => null, matches: async pid => pid === 77 };
  const backed = await stoppedAt(recover(running.paths, deps({ ...broken, identity: alive }), { backOut: true }));
  assert.deepEqual([backed.reason, backed.facts.keepable, backed.facts.backOutFailed], ['format_unreadable', true, 'format_unreadable']);
  assert.equal(JSON.parse(readFileSync(join(running.root, 'neo4j-transaction.json'), 'utf8')).backOutFailed, 'format_unreadable');
  rmSync(running.paths.nativeProcessStatePath);
  const again = await planNativeRecovery({ paths: running.paths, dependencies: deps(broken).dependencies });
  assert.deepEqual([again.keepable, again.backOutFailed], [true, 'format_unreadable']);
  assert.match(formatRecoveryPlan(again), /上次取消更新、回到 5\.26\.0 没有走通：读不出存储格式/);
  assert.equal((await planNativeRecovery({ paths: running.paths, keepNewer: true, dependencies: deps(broken).dependencies })).kind, 'keep_newer');
});

test('finishing a switch without a start check is open only once going back is impossible or was tried', async (t) => {
  const { formatRecoveryPlan } = await import('../src/cli/recovery-plan-text.js');
  const keep = paths => planNativeRecovery({ paths, keepNewer: true, dependencies: deps().dependencies });
  // Going back is possible: refused, pointing to it.
  const open = await newerInPlace(t);
  const refusal = await keep(open.paths);
  assert.equal(refusal.reason, 'back_out_available');
  assert.match(formatRecoveryPlan(refusal), /现在还能取消更新、留在 5\.26\.0.+--back-out/);
  assert.equal((await planNativeRecovery({ paths: open.paths, dependencies: deps().dependencies })).keepable, false);
  // Going back was tried and wrote the switched-to descriptor back (backingOut): open.
  const tried = await newerInPlace(t);
  const journal = JSON.parse(readFileSync(join(tried.root, 'neo4j-transaction.json'), 'utf8'));
  writeFileSync(join(tried.root, 'neo4j-transaction.json'), JSON.stringify({ ...journal, backingOut: true }));
  assert.equal((await keep(tried.paths)).kind, 'keep_newer');
  // Going back is not possible (no fingerprint): open.
  assert.equal((await keep((await newerInPlace(t, { fingerprint: null })).paths)).kind, 'keep_newer');
  // A back-out stopped at a check earlier, but that check passes now: the old record no longer opens it.
  for (const backOutFailed of ['format_unreadable', 'format_changed', 'assets_changed']) {
    const fixed = await newerInPlace(t);
    const recorded = JSON.parse(readFileSync(join(fixed.root, 'neo4j-transaction.json'), 'utf8'));
    writeFileSync(join(fixed.root, 'neo4j-transaction.json'), JSON.stringify({ ...recorded, backOutFailed }));
    assert.equal((await keep(fixed.paths)).reason, 'back_out_available', backOutFailed);
    const shown = await planNativeRecovery({ paths: fixed.paths, dependencies: deps().dependencies });
    assert.deepEqual([shown.keepable, shown.backOutFailed, shown.alternative?.kind], [false, undefined, 'back_out_switch'], backOutFailed);
    // Finishing then fails to start: the refusal still points to going back, not to keeping.
    const finish = await stoppedAt(recover(fixed.paths, deps({ checkStart: async () => { throw new Error('no answer'); } })));
    assert.deepEqual([finish.reason, finish.facts.keepable, finish.facts.backOutFailed, finish.facts.alternative], ['start_failed', false, null, 'back_out_switch'], backOutFailed);
  }
  // While services run the store format is not read at plan time: a recorded format failure still opens it.
  const busy = await newerInPlace(t);
  const busyJournal = JSON.parse(readFileSync(join(busy.root, 'neo4j-transaction.json'), 'utf8'));
  writeFileSync(join(busy.root, 'neo4j-transaction.json'), JSON.stringify({ ...busyJournal, backOutFailed: 'format_changed' }));
  writeFileSync(busy.paths.nativeProcessStatePath, JSON.stringify({ databases: { personal: { pid: 77, command: 'java' } } }));
  const alive = { state: pid => pid === 77 ? 'running' : 'gone', startTime: async () => null, matches: async pid => pid === 77 };
  assert.equal((await planNativeRecovery({ paths: busy.paths, keepNewer: true, dependencies: deps({ identity: alive }).dependencies })).kind, 'keep_newer');
  // A back-out whose older version did not start: keeping is offered from then on.
  const failed = await newerInPlace(t);
  const stopped = await stoppedAt(recover(failed.paths, deps({ checkStart: async () => { throw new Error('no answer'); } }), { backOut: true }));
  assert.equal(stopped.facts.keepable, true);
  assert.match(formatRecoveryPlan({ kind: 'refused', reason: stopped.reason, planKind: stopped.planKind, ...stopped.facts }),
    /5\.26\.0 没能启动或没有应答，描述文件已经写回 5\.26\.28.+--keep-newer.+之后不能再回到 5\.26\.0/s);
});

test('an unfinished rollback is worded as a rollback, with the versions and programs on each side, never "newer" or an upgrade backup', async (t) => {
  const { formatRecoveryPlan } = await import('../src/cli/recovery-plan-text.js');
  const { paths, root } = runtime(t);
  const previous = { status: 'ready', neo4jVersion: '5.26.28', neo4jHome: asset(root, '2222', '5.26.28'), neo4jAssetFingerprint: 'fp' };
  const next = { ...previous, neo4jHome: asset(root, '1111', '5.26.28'), previousNeo4jAsset: { home: previous.neo4jHome, version: '5.26.28' } };
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify(next));
  await acquireNeo4jLifecycleLock(root, { operation: 'rollback', identify: holderIdentity });
  switchJournal(root, { previous, next, action: 'rollback' });
  const plan = await planNativeRecovery({ paths, dependencies: deps().dependencies });
  assert.deepEqual([plan.kind, plan.alternative.kind], ['finish_switch', 'back_out_switch']);
  const words = formatRecoveryPlan(plan);
  assert.match(words, /完成这次没做完的回退，改用 5\.26\.28（更新前保留的那一份程序，安装于 [^）]+）/);
  assert.match(words, /也可以取消回退、留在 5\.26\.28（回退前在用的那一份程序，安装于 [^）]+）/);
  assert.match(words, /cancel the rollback and stay on 5\.26\.28 \(the programs in use before the rollback, installed /);
  assert.doesNotMatch(words, /jvs-a-/, 'the install time names each side, not the hashed directory');
  assert.match(words, /Finish the unfinished rollback to 5\.26\.28/);
  assert.doesNotMatch(words, /新版本|旧版本|\bnewer\b|\bolder\b|升级前|upgrade/);
  const back = formatRecoveryPlan(plan.alternative);
  assert.match(back, /取消这次没做完的回退，留在 5\.26\.28（回退前在用的那一份程序，安装于 /);
  assert.doesNotMatch(back, /新版本|旧版本|\bnewer\b|\bolder\b/, back);
  // Without an install time each side still says which copy it is, then its directory.
  const untimed = formatRecoveryPlan({ ...plan, fromInstalledAt: null, toInstalledAt: null });
  assert.match(untimed, /改用 5\.26\.28（更新前保留的那一份程序，neo4j-assets\/jvs-a-1111\/neo4j-community-5\.26\.28）/);
  assert.match(untimed, /留在 5\.26\.28（回退前在用的那一份程序，neo4j-assets\/jvs-a-2222\/neo4j-community-5\.26\.28）/);
  assert.match(untimed, /stay on 5\.26\.28 \(the programs in use before the rollback, neo4j-assets\/jvs-a-2222\/neo4j-community-5\.26\.28\)/);
  // An update says update.
  const update = await newerInPlace(t);
  assert.match(formatRecoveryPlan(await planNativeRecovery({ paths: update.paths, dependencies: deps().dependencies })), /完成这次没做完的更新，改用 5\.26\.28：/);
});

test('a lock\'s age counts from when its operation took it, which a recovery\'s claim keeps', async (t) => {
  const { root } = runtime(t);
  await acquireNeo4jLifecycleLock(root, { operation: 'start', identify: holderIdentity });
  const lock = readLock(root);
  writeFileSync(join(lock.path, 'holder.json'), JSON.stringify({ ...lock.holder, at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }));
  assert.equal(lockTooRecent(readLock(root), Date.now()), null, 'rewriting the holder made the directory new, not the lock');
  writeFileSync(join(lock.path, 'holder.json'), JSON.stringify({ ...lock.holder, at: new Date().toISOString() }));
  assert.equal(lockTooRecent(readLock(root), Date.now()).reason, 'too_recent');
});

test('a store moved beside an earlier one goes back under its own name', async (t) => {
  const { graphStoresIn } = await import('../src/native-runtime/recovered-dir.js');
  const { root } = runtime(t);
  const folder = join(root, 'recovered', '2026-11-23T03-00-00-000Z');
  mkdirSync(join(folder, 'personal', 'data', 'databases', 'neo4j-1763866800000'), { recursive: true });
  assert.deepEqual(graphStoresIn(folder, root).map(({ to }) => to), [join(root, 'personal', 'data', 'databases', 'neo4j')]);
});
