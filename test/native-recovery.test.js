import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireNeo4jLifecycleLock } from '../src/native-runtime/neo4j-lifecycle-lock.js';
import { applyNativeRecovery, planNativeRecovery } from '../src/native-runtime/neo4j-recovery.js';

const LOCK = '.neo4j-lifecycle.lock';
const holderIdentity = async () => ({ pid: 4321, command: 'node /x/cli.js', startedAt: 'Sun Nov 22 01:24:35 2026' });
const gone = { state: () => 'gone', startTime: async () => null, matches: async () => false };

// A made-up data directory with a native runtime in it.
function runtime(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-recover-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const root = join(dataDir, 'native-runtime');
  mkdirSync(join(root, 'neo4j-assets'), { recursive: true });
  const paths = { dataDir, nativeRuntimeDir: root, nativeRuntimeManifestPath: join(root, 'manifest.json'),
    nativeProcessStatePath: join(root, 'processes.json'), graphBackupDir: join(dataDir, 'backups', 'graph') };
  mkdirSync(paths.graphBackupDir, { recursive: true });
  return { paths, root };
}

function asset(root, id, version) {
  const container = join(root, 'neo4j-assets', `jvs-a-${id}`);
  mkdirSync(join(container, `neo4j-community-${version}`), { recursive: true });
  writeFileSync(join(container, 'fuli-asset-owner.json'), JSON.stringify({ kind: 'fuli-neo4j-assets', id: `jvs-a-${id}`, version }));
  return join(container, `neo4j-community-${version}`);
}

function deps(overrides = {}) {
  const log = [];
  return { log, dependencies: { identity: gone, listProcesses: async () => [], fingerprint: async () => 'fp',
    storeFormats: async () => ({ 'personal:neo4j': 'aligned' }), stopServices: async () => log.push('stop'),
    restore: async (from) => log.push(`restore ${from}`), log: () => ({ record: (event) => log.push(event.operation) }),
    now: () => Date.parse('2026-11-23T03:00:00.000Z'), ...overrides } };
}

async function recover(paths, d, options = {}) {
  const plan = await planNativeRecovery({ paths, dependencies: d.dependencies, ...options });
  return { plan, result: plan.digest ? await applyNativeRecovery({ paths, digest: plan.digest, dependencies: d.dependencies, ...options }) : plan };
}

function switchJournal(root, { previous, next, phase = 'switching', action = 'update', storeFormats = { 'personal:neo4j': 'aligned' } }) {
  writeFileSync(join(root, 'neo4j-transaction.json'), JSON.stringify({ action, phase, previous, next, storeFormats }));
}

test('nothing to recover says so and changes nothing', async (t) => {
  const { paths } = runtime(t);
  assert.equal((await planNativeRecovery({ paths, dependencies: deps().dependencies })).kind, 'nothing');
});

test('a switch killed before the new descriptor was written is undone: the candidate is set aside, the journal kept, the lock released', async (t) => {
  const { paths, root } = runtime(t);
  const oldHome = join(root, 'neo4j-community-5.26.0');
  const newHome = asset(root, '1111', '5.26.28');
  const previous = { status: 'ready', neo4jVersion: '5.26.0', neo4jHome: oldHome };
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify(previous));
  await acquireNeo4jLifecycleLock(root, { operation: 'update', identify: holderIdentity });
  switchJournal(root, { previous, next: { ...previous, neo4jVersion: '5.26.28', neo4jHome: newHome } });
  const d = deps();
  const { plan, result } = await recover(paths, d);
  assert.equal(plan.kind, 'undo_switch');
  assert.deepEqual(plan.steps.map(step => step.do), ['move-aside', 'archive-journal', 'release-lock']);
  assert.equal(result.status, 'recovered');
  assert.equal(existsSync(join(root, 'neo4j-assets', 'jvs-a-1111')), false);
  assert.ok(existsSync(join(root, 'recovered', 'jvs-a-1111')), 'set aside, not deleted');
  assert.equal(existsSync(join(root, 'neo4j-transaction.json')), false);
  assert.ok(readdirSync(join(root, 'recovered')).some(name => name.startsWith('neo4j-transaction-')), 'the journal is kept');
  assert.equal(existsSync(join(root, LOCK)), false);
  assert.ok(readdirSync(join(root, 'recovered')).some(name => name.startsWith('recovery-')), 'what was done is recorded');
});

test('a switch killed after the new descriptor was written is finished by default, and backed out only when the store format did not change', async (t) => {
  const setup = async () => {
    const { paths, root } = runtime(t);
    const previous = { status: 'ready', neo4jVersion: '5.26.0', neo4jHome: join(root, 'neo4j-community-5.26.0'), neo4jAssetFingerprint: 'fp' };
    const next = { ...previous, neo4jVersion: '5.26.28', neo4jHome: asset(root, '2222', '5.26.28'),
      previousNeo4jAsset: { home: previous.neo4jHome, graphBackup: join(paths.graphBackupDir, 'before-neo4j-5.26.28-x') } };
    writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify(next));
    await acquireNeo4jLifecycleLock(root, { operation: 'update', identify: holderIdentity });
    switchJournal(root, { previous, next });
    return { paths, root, previous, next };
  };
  const finished = await setup();
  const { plan, result } = await recover(finished.paths, deps());
  assert.deepEqual([plan.kind, plan.fromVersion, plan.toVersion], ['finish_switch', '5.26.0', '5.26.28']);
  assert.equal(result.status, 'recovered');
  assert.deepEqual(JSON.parse(readFileSync(finished.paths.nativeRuntimeManifestPath, 'utf8')), finished.next, 'the newer descriptor stays');

  const backedOut = await setup();
  const back = await recover(backedOut.paths, deps(), { backOut: true });
  assert.equal(back.plan.kind, 'back_out_switch');
  assert.deepEqual(JSON.parse(readFileSync(backedOut.paths.nativeRuntimeManifestPath, 'utf8')), backedOut.previous);
  assert.ok(existsSync(join(backedOut.root, 'recovered', 'jvs-a-2222')));

  const changed = await setup();
  const formats = deps({ storeFormats: async () => ({ 'personal:neo4j': 'block' }) });
  await assert.rejects(recover(changed.paths, formats, { backOut: true }), (error) => error.code === 'recover_step_failed');
  assert.ok(formats.log.includes('native.recover.check-formats'), 'the failed step is in the diagnostics log');
  assert.deepEqual(JSON.parse(readFileSync(changed.paths.nativeRuntimeManifestPath, 'utf8')), changed.next, 'nothing written back');
  assert.ok(existsSync(join(changed.root, LOCK)), 'the lock stays until it can be finished');
  assert.equal((await recover(changed.paths, deps())).result.status, 'recovered', 'finishing it still works');
});

test('an uninstall killed while removing programs is finished; the knowledge data is not touched', async (t) => {
  const { paths, root } = runtime(t);
  const home = join(root, 'neo4j-community-5.26.28');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'personal', 'data'), { recursive: true });
  const previous = { status: 'ready', neo4jVersion: '5.26.28', neo4jHome: home };
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify({ ...previous, status: 'uninstalled' }));
  await acquireNeo4jLifecycleLock(root, { operation: 'uninstall', identify: holderIdentity });
  switchJournal(root, { previous, phase: 'removing-assets', action: 'uninstall' });
  const { plan } = await recover(paths, deps());
  assert.deepEqual(plan.steps.map(step => step.do), ['remove', 'archive-journal', 'release-lock']);
  assert.equal(existsSync(home), false);
  assert.ok(existsSync(join(root, 'personal', 'data')));
});

test('an update killed before its journal sets aside its half-installed programs and unfinished backup, and releases the lock', async (t) => {
  const { paths, root } = runtime(t);
  const home = asset(root, '3333', '5.26.0');
  asset(root, '4444', '5.26.28');
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify({ status: 'ready', neo4jHome: home, neo4jAssetFingerprint: 'fp' }));
  mkdirSync(join(paths.graphBackupDir, 'before-neo4j-5.26.28-2026.partial-0a1b'));
  await acquireNeo4jLifecycleLock(root, { operation: 'update', identify: holderIdentity });
  const { plan, result } = await recover(paths, deps());
  assert.equal(plan.kind, 'clear_interrupted');
  assert.equal(result.status, 'recovered');
  assert.ok(existsSync(home), 'the programs in use stay');
  assert.ok(existsSync(join(root, 'recovered', 'jvs-a-4444')));
  assert.ok(existsSync(join(paths.graphBackupDir, 'before-neo4j-5.26.28-2026.incomplete')));
  assert.equal(existsSync(join(root, LOCK)), false);
  // Programs that changed under the descriptor, or a directory FULI did not make, are left for a person.
  const changed = runtime(t);
  writeFileSync(changed.paths.nativeRuntimeManifestPath, JSON.stringify({ neo4jHome: asset(changed.root, '5555', '5.26.0'), neo4jAssetFingerprint: 'other' }));
  await acquireNeo4jLifecycleLock(changed.root, { operation: 'update', identify: holderIdentity });
  assert.equal((await planNativeRecovery({ paths: changed.paths, dependencies: deps().dependencies })).reason, 'assets_changed');
  const foreign = runtime(t);
  mkdirSync(join(foreign.root, 'neo4j-assets', 'jvs-a-6666'));
  await acquireNeo4jLifecycleLock(foreign.root, { operation: 'rollback', identify: holderIdentity });
  assert.equal((await planNativeRecovery({ paths: foreign.paths, dependencies: deps().dependencies })).reason, 'unknown_assets');
});

test('a dump releases its lock; a load restores the whole graph from the copy the import took first, or says there is none', async (t) => {
  const dump = runtime(t);
  await acquireNeo4jLifecycleLock(dump.root, { operation: 'dump', identify: holderIdentity });
  assert.equal((await recover(dump.paths, deps())).plan.kind, 'release_dump');
  assert.equal(existsSync(join(dump.root, LOCK)), false);

  const load = runtime(t);
  const before = join(load.paths.graphBackupDir, 'before-import-2026-11-22T00-00-00-000Z-a');
  mkdirSync(before);
  writeFileSync(join(before, 'manifest.json'), JSON.stringify({ format: 'fuli-neo4j-backup', version: 1, createdAt: '2026-11-22T00:00:00.000Z',
    sourceMode: 'native', instances: [{ id: 'personal', file: 'personal.dump', sha256: 'a'.repeat(64) }] }));
  await acquireNeo4jLifecycleLock(load.root, { operation: 'load', identify: holderIdentity });
  const d = deps();
  const { plan } = await recover(load.paths, d);
  assert.equal(plan.kind, 'restore_load');
  assert.deepEqual(plan.steps.map(step => step.do), ['release-lock', 'restore']);
  assert.deepEqual(d.log, [`restore ${before}`]);

  const empty = runtime(t);
  await acquireNeo4jLifecycleLock(empty.root, { operation: 'load', identify: holderIdentity });
  assert.equal((await planNativeRecovery({ paths: empty.paths, dependencies: deps().dependencies })).reason, 'no_restore_point');
  assert.ok(existsSync(join(empty.root, LOCK)), 'a half-written load keeps its lock until it can be restored');
});

test('a recovery killed part way is planned and finished again', async (t) => {
  const { paths, root } = runtime(t);
  const previous = { status: 'ready', neo4jVersion: '5.26.0', neo4jHome: join(root, 'neo4j-community-5.26.0') };
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify(previous));
  await acquireNeo4jLifecycleLock(root, { operation: 'update', identify: holderIdentity });
  switchJournal(root, { previous, next: { ...previous, neo4jVersion: '5.26.28', neo4jHome: asset(root, '7777', '5.26.28') } });
  const plan = await planNativeRecovery({ paths, dependencies: deps().dependencies });
  // Killed right after the candidate was set aside.
  mkdirSync(join(root, 'recovered'), { recursive: true });
  const { renameSync } = await import('node:fs');
  renameSync(join(root, 'neo4j-assets', 'jvs-a-7777'), join(root, 'recovered', 'jvs-a-7777'));
  const again = await planNativeRecovery({ paths, dependencies: deps().dependencies });
  // The same plan: a step already done is skipped when it runs again.
  assert.deepEqual([again.kind, again.digest], ['undo_switch', plan.digest]);
  assert.equal((await applyNativeRecovery({ paths, digest: again.digest, dependencies: deps().dependencies })).status, 'recovered');
  assert.ok(existsSync(join(root, 'recovered', 'jvs-a-7777')));
  assert.equal(existsSync(join(root, LOCK)), false);
});

test('a plan that changed since it was shown is not applied; a holder still running or a lock nobody recorded is refused', async (t) => {
  const { paths, root } = runtime(t);
  await acquireNeo4jLifecycleLock(root, { operation: 'dump', identify: holderIdentity });
  assert.equal((await applyNativeRecovery({ paths, digest: 'stale', dependencies: deps().dependencies })).reason, 'plan_changed');
  assert.ok(existsSync(join(root, LOCK)));
  const running = { state: () => 'running', startTime: async () => 'Sun Nov 22 01:24:35 2026', matches: async () => true };
  assert.equal((await planNativeRecovery({ paths, dependencies: deps({ identity: running }).dependencies })).reason, 'holder_running');
  const legacy = runtime(t);
  mkdirSync(join(legacy.root, LOCK));
  writeFileSync(join(legacy.root, LOCK, 'owner'), 'token-a');
  assert.equal((await planNativeRecovery({ paths: legacy.paths, dependencies: deps().dependencies })).reason, 'no_holder');
});

test('the recorded graph services are stopped first, under the lock\'s own token', async (t) => {
  const { paths, root } = runtime(t);
  const lock = await acquireNeo4jLifecycleLock(root, { operation: 'dump', identify: holderIdentity });
  writeFileSync(paths.nativeProcessStatePath, JSON.stringify({ databases: { personal: { pid: 77, command: 'java' } } }));
  const tokens = [];
  const services = { state: pid => pid === 77 ? 'running' : 'gone', startTime: async () => null, matches: async pid => pid === 77 };
  const d = deps({ identity: services, stopServices: async (_paths, owner) => { tokens.push(owner); } });
  const plan = await planNativeRecovery({ paths, dependencies: d.dependencies });
  assert.deepEqual(plan.steps.map(step => step.do), ['stop-services', 'release-lock']);
  await applyNativeRecovery({ paths, digest: plan.digest, dependencies: d.dependencies });
  assert.deepEqual(tokens, [lock.token]);
});

test('fuli graph runtime recover shows the plan, does it only with that plan\'s digest, and says why it will not', async () => {
  const { runNativeRuntimeCommand } = await import('../src/cli/native-runtime-command.js');
  const { readStartupFailure, startupFailureLine } = await import('../src/local-runtime/startup-failure-line.js');
  const written = [];
  const plan = { kind: 'release_dump', operation: 'dump', steps: [{ do: 'release-lock' }], digest: '0123456789abcdef' };
  const applied = [];
  const run = (args, planned = plan) => runNativeRuntimeCommand(args, { platform: 'darwin', write: line => written.push(line),
    resolvePaths: () => ({ dataDir: '/x/fuli-data', nativeRuntimeDir: '/x/fuli-data/native-runtime' }),
    planRecovery: async () => planned, applyRecovery: async ({ digest }) => { applied.push(digest); return { ...planned, status: 'recovered' }; } });
  assert.deepEqual(await run(['recover', '--preview', '--json']), { status: 'preview', exitCode: 0 });
  assert.deepEqual(JSON.parse(written.at(-1)), plan);
  assert.equal((await run(['recover', '--yes', '--expect', '0123456789abcdef'])).status, 'recovered');
  assert.deepEqual(applied, ['0123456789abcdef']);
  assert.match(written.join('\n'), /1\. 解除数据库维护锁 \/ Release the database maintenance lock/);
  // A digest from a plan that has since changed does nothing.
  await assert.rejects(run(['recover', '--yes', '--expect', 'ffffffffffffffff']), (error) => {
    assert.equal(readStartupFailure(startupFailureLine(error)).failure.reason, 'plan_changed');
    return true;
  });
  assert.deepEqual(applied, ['0123456789abcdef']);
  await assert.rejects(run(['recover', '--yes', '--expect', '0123456789abcdef'], { kind: 'refused', reason: 'no_restore_point', operation: 'load' }),
    /导入前没有留下备份/);
});

test('the window\'s 恢复并启动 previews the plan, then recovers with that plan\'s digest and starts', async () => {
  const { runTrayAction } = await import('../src/desktop/desktop-controller.js');
  const context = { packageRoot: '/x/pkg', dataDir: '/x/fuli-test-data-that-does-not-exist', nodePath: '/x/node', cliPath: '/x/cli.js' };
  const calls = [];
  const runCli = async (_context, args) => {
    calls.push(args.slice(0, args.indexOf('--data-dir')).join(' '));
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ status: calls.some(call => call.startsWith('setup')) ? 'running' : 'stopped' }), stderr: '' };
    if (args.includes('--preview')) return { code: 0, stdout: JSON.stringify({ kind: 'release_dump', steps: [], digest: '0123456789abcdef' }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const preview = await runTrayAction('recover-preview', context, { runCli });
  assert.equal(preview.recoveryPlan.digest, '0123456789abcdef');
  await runTrayAction('recover-start', context, { runCli, recoveryDigest: '0123456789abcdef', otherConsole: () => null, holdAdoption: () => null,
    portBlocked: async () => false });
  assert.ok(calls.includes('graph runtime recover --yes --expect 0123456789abcdef'));
  assert.ok(calls.indexOf('graph runtime recover --yes --expect 0123456789abcdef') < calls.findIndex(call => call.startsWith('setup')),
    'it starts only after the recovery');
  await assert.rejects(runTrayAction('recover-start', context, { runCli }), /needs the digest/);
});
