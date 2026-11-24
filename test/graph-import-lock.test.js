import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { exportGraphData, importGraphData } from '../src/backup/graph-backup.js';
import { createGraphBackupAdapter } from '../src/backup/runtime-adapters.js';
import { migrateContainerGraphToNative } from '../src/backup/runtime-migration.js';
import { formatRecoveryPlan } from '../src/cli/recovery-plan-text.js';
import { readLock } from '../src/native-runtime/neo4j-lifecycle-lock.js';
import { applyNativeRecovery, planNativeRecovery } from '../src/native-runtime/neo4j-recovery.js';
import { createNativeGraphServices } from '../src/native-runtime/runtime.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

// An import (graph-backup.js) through the real native adapter, lease and lock
// (macOS), with neo4j-admin faked: a graph's store is a folder holding one
// file that says whose data it is. Killing the import is a step that never
// returns: what is on disk then is what a kill there leaves.

const ENVIRONMENT = ['FULI_PERSONAL_NEO4J_PASSWORD=personal-password', 'FULI_WORKSPACE_NEO4J_PASSWORD=workspace-password',
  'FULI_PERSONAL_BOOTSTRAP_TOKEN=personal-bootstrap-token-1234', 'FULI_WORKSPACE_BOOTSTRAP_TOKEN=workspace-bootstrap-token-12'].join('\n');
const LOCK = '.neo4j-lifecycle.lock';
const gone = { state: () => 'gone', startTime: async () => null, matches: async () => false };
const recoveryDeps = { identity: gone, listProcesses: async () => [], stopServices: async () => {}, checkStart: async () => {},
  restore: async () => {}, log: () => ({ record: () => {} }) };
const never = () => new Promise(() => {});

// A native runtime whose graphs hold [before] (null: empty), and a bundle of new data for both.
function scene(t, { before = { personal: 'old:personal', workspace: 'old:workspace' }, admin = async () => {}, record = async () => {}, killAt = () => false, setAside } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-import-lock-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const paths = resolveSetupPaths({ dataDir, packageRoot: '/package' });
  mkdirSync(paths.nativeRuntimeDir, { recursive: true });
  writeFileSync(paths.graphRuntimeConfigPath, JSON.stringify({ workspaces: [{ managedDevelopment: true }] }));
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify({ status: 'ready', mode: 'native', javaHome: '/jdk', neo4jHome: '/neo4j', providerPython: '/python', neo4jVersion: '5.26.28' }));
  const dir = id => id === 'personal' ? paths.nativePersonalDir : paths.nativeWorkspaceDir;
  const storeFile = id => join(dir(id), 'data', 'databases', 'neo4j', 'graph');
  const write = (id, body) => {
    for (const store of [['data', 'databases', 'neo4j'], ['transactions', 'neo4j']]) mkdirSync(join(dir(id), ...store), { recursive: true });
    writeFileSync(storeFile(id), body);
  };
  for (const [id, body] of Object.entries(before)) if (body) write(id, body);
  const events = [];
  let killed;
  const kill = new Promise(resolve => { killed = resolve; });
  const checkpoint = async (name) => { events.push(name); if (killAt(name)) { killed(name); await never(); } };
  // neo4j-admin: a dump copies the store out, a load writes it (half first, then whole).
  const run = async (_command, args, { cwd }) => {
    const id = cwd === paths.nativePersonalDir ? 'personal' : 'workspace';
    if (args[1] === 'dump') return writeFileSync(join(args[3].slice('--to-path='.length), 'neo4j.dump'), readFileSync(storeFile(id)));
    if (args[1] !== 'load') return;
    const body = readFileSync(join(args[3].slice('--from-path='.length), 'neo4j.dump'), 'utf8');
    await checkpoint(`load ${body}`);
    write(id, `half:${body}`);
    await checkpoint(`half ${body}`);
    await admin(id, body);
    write(id, body);
  };
  const services = options => createNativeGraphServices({ ...options, platform: 'darwin', env: {}, readText: async () => ENVIRONMENT,
    writeText: async () => {}, pathExists: () => true, markInitialized: () => {}, readProcessState: () => null, writeProcessState: () => {},
    readSettings: () => ({ ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native' }), run,
    spawnDatabase: () => assert.fail('no Neo4j is started'), findOrphans: async () => [], verifyPortFree: async () => {} });
  async function adapter() {
    const real = await createGraphBackupAdapter({ mode: 'native', paths, createNativeServices: services });
    return { ...real,
      // As if FULI's graph services ran before the import: they start again only with every graph whole.
      stop: async () => ({ ...await real.stop(), resume: true }),
      start: async () => { events.push(`start (lock ${existsSync(join(paths.nativeRuntimeDir, LOCK)) ? 'held' : 'gone'})`); },
      // Reconciling starts the graph services; nothing here starts a real one.
      reconcile: async () => { await checkpoint('reconcile'); },
      ...(setAside ? { setAside: async (id) => { await setAside(id); return real.setAside(id); } } : {}),
      holdImport: async (details) => {
        const lease = await real.holdImport(details);
        await checkpoint('held');
        return { ...lease, record: async (patch) => {
          await record(patch);
          await lease.record(patch);
          await checkpoint(`recorded ${JSON.stringify(patch)}`);
        } };
      } };
  }
  async function bundle() {
    const source = join(dataDir, 'bundle');
    await exportGraphData({ outputDir: source, sourceMode: 'native', instances: ['personal', 'workspace'],
      adapter: { async stop() { return { resume: false }; }, async dump(id, to) { writeFileSync(to, `new:${id}`); }, async start() {} } });
    return source;
  }
  async function runImport() {
    const inputDir = await bundle();
    return importGraphData({ inputDir, targetMode: 'native', rollbackDir: paths.graphBackupDir, adapter: await adapter() });
  }
  const holds = id => existsSync(storeFile(id)) ? readFileSync(storeFile(id), 'utf8') : null;
  return { paths, events, kill, runImport, holds, services, adapter, bundle, root: paths.nativeRuntimeDir, bundleDir: join(dataDir, 'bundle') };
}

const lockOf = s => readLock(s.root)?.holder ?? null;
const plan = (s, options = {}) => planNativeRecovery({ paths: s.paths, dependencies: recoveryDeps, ...options });
const copyOf = s => join(s.paths.graphBackupDir, readdirSync(s.paths.graphBackupDir).find(name => name.startsWith('before-import-')));

// Killed at [point]: the lock, what it says, what a recovery plans and what
// abandoning the import (once its copy is gone) would move.
async function killedAt(t, point, options = {}) {
  const s = scene(t, { ...options, killAt: name => name === point });
  s.runImport().catch(() => {});
  assert.equal(await s.kill, point);
  const holder = lockOf(s);
  assert.ok(holder, `the lock is on disk after a kill at ${point}`);
  assert.equal(holder.operation, 'load');
  // The same fakes as the import: a start that got past the lock would fail on them, never reach a real Neo4j.
  await assert.rejects(s.services({ paths: s.paths }).start(), /in progress/, 'a start is held back');
  const recovery = await plan(s);
  rmSync(copyOf(s), { recursive: true });
  const abandon = await plan(s, { abandonImport: true });
  return { s, holder, recovery, abandon };
}

const recordedAfter = patch => `recorded ${JSON.stringify(patch)}`;
const states = (personal, workspace) => recordedAfter({ graphStates: { personal, workspace } });

test('an import killed at any step leaves its one lock, recording what each graph holds; a recovery restores and abandoning moves only what may be half written', async (t) => {
  const failWorkspace = { admin: async (id, body) => { if (id === 'workspace' && body.startsWith('new:')) throw new Error('neo4j-admin failed'); } };
  const cases = [
    // [kill point, options, graphStates in the lock, graphs on disk, graphs abandoning moves]
    ['held', {}, { personal: 'untouched', workspace: 'untouched' }, { personal: 'old:personal', workspace: 'old:workspace' }, []],
    [states('writing', 'untouched'), {}, { personal: 'writing', workspace: 'untouched' }, { personal: 'old:personal', workspace: 'old:workspace' }, ['personal']],
    ['half new:personal', {}, { personal: 'writing', workspace: 'untouched' }, { personal: 'half:new:personal', workspace: 'old:workspace' }, ['personal']],
    ['load new:workspace', {}, { personal: 'imported', workspace: 'writing' }, { personal: 'new:personal', workspace: 'old:workspace' }, ['workspace']],
    ['half new:workspace', {}, { personal: 'imported', workspace: 'writing' }, { personal: 'new:personal', workspace: 'half:new:workspace' }, ['workspace']],
    [states('imported', 'importFailed'), failWorkspace, { personal: 'imported', workspace: 'importFailed' }, { personal: 'new:personal', workspace: 'half:new:workspace' }, ['workspace']],
    // The rollback's copy of the dump goes to a staging folder before neo4j-admin: the lock already says restoring.
    [states('restoring', 'importFailed'), failWorkspace, { personal: 'restoring', workspace: 'importFailed' }, { personal: 'new:personal', workspace: 'half:new:workspace' }, ['workspace', 'personal']],
    ['half old:personal', failWorkspace, { personal: 'restoring', workspace: 'importFailed' }, { personal: 'half:old:personal', workspace: 'half:new:workspace' }, ['workspace', 'personal']],
    [recordedAfter({ restored: true }), failWorkspace, { personal: 'restored', workspace: 'restored' }, { personal: 'old:personal', workspace: 'old:workspace' }, null]
  ];
  for (const [point, options, graphStates, holds, moves] of cases) {
    const { s, holder, recovery, abandon } = await killedAt(t, point, options);
    assert.deepEqual(holder.graphStates, graphStates, `the lock says what each graph holds, killed at ${point}`);
    assert.deepEqual({ personal: s.holds('personal'), workspace: s.holds('workspace') }, holds, `on disk, killed at ${point}`);
    assert.equal(recovery.kind, 'restore_load', point);
    if (holder.restored) {
      // Every graph is back already: the recovery only checks the start and releases the lock.
      assert.deepEqual(recovery.steps.map(step => step.do), ['check-start', 'release-lock']);
      assert.equal(abandon.reason, 'restore_point_usable', 'nothing to abandon');
      continue;
    }
    assert.deepEqual(recovery.steps.map(step => step.do), ['restore', 'mark-restored', 'check-start', 'release-lock'], point);
    assert.deepEqual(recovery.restorePoint.instances, ['personal', 'workspace'], 'the whole graph goes back to the copy this import took first');
    assert.equal(abandon.kind, 'abandon_load', point);
    assert.deepEqual(abandon.instances, moves, `abandoning moves exactly what may be half written, killed at ${point}`);
  }
});

test('abandoning an import killed while writing its second graph moves that graph aside and keeps the first one\'s new data', async (t) => {
  const { s } = await killedAt(t, 'half new:workspace');
  const shown = await plan(s, { abandonImport: true });
  await applyNativeRecovery({ paths: s.paths, digest: shown.digest, abandonImport: true, dependencies: recoveryDeps });
  assert.deepEqual([s.holds('personal'), s.holds('workspace')], ['new:personal', null]);
  assert.equal(existsSync(join(s.root, LOCK)), false);
});

test('an import whose second graph fails is rolled back under the same lock, which then goes, and the services start again', async (t) => {
  const s = scene(t, { admin: async (id, body) => { if (id === 'workspace' && body.startsWith('new:')) throw new Error('neo4j-admin failed'); } });
  await assert.rejects(s.runImport(), /neo4j-admin failed.+每个图谱都已退回导入前的数据/s);
  assert.deepEqual([s.holds('personal'), s.holds('workspace')], ['old:personal', 'old:workspace']);
  assert.equal(existsSync(join(s.root, LOCK)), false);
  assert.equal(s.events.filter(event => event === 'held').length, 1, 'one lock for the import and its rollback');
  assert.equal(s.events.at(-1), 'start (lock gone)');
});

test('an import whose rollback cannot copy the dump back keeps its lock, starts nothing, and says why', async (t) => {
  const s = scene(t, { admin: async (id, body) => { if (id === 'workspace' && body.startsWith('new:')) throw new Error('neo4j-admin failed'); },
    // The copy cannot be read once the import has failed (as when the disk is full while copying it to the staging folder).
    // It is moved away rather than made unreadable: Windows ignores POSIX permission bits.
    record: async (patch) => { if (patch.graphStates?.workspace === 'importFailed' && existsSync(join(copyOf(s), 'personal.dump'))) renameSync(join(copyOf(s), 'personal.dump'), join(copyOf(s), 'personal.dump.away')); } });
  await assert.rejects(s.runImport(), (error) => {
    assert.equal(error.code, 'graph_import_incomplete');
    assert.match(error.message, /自动退回没有做完（.*ENOENT.*）。维护锁留着，FULI 不会在写了一半的图谱上启动。运行 fuli graph runtime recover/s);
    assert.match(error.message, /The maintenance lock is kept/);
    return true;
  });
  const holder = lockOf(s);
  assert.deepEqual(holder.graphStates, { personal: 'restoreFailed', workspace: 'restored' });
  assert.match(holder.restoreFailed.detail, /ENOENT/, 'why is recorded for the recovery\'s words');
  assert.equal(s.events.some(event => event.startsWith('start')), false, 'nothing starts on a half-written graph');
  // What #1084's recovery already knows: retry the restore, or abandon (the copy is good) and move the failed graph aside.
  renameSync(join(copyOf(s), 'personal.dump.away'), join(copyOf(s), 'personal.dump'));
  const retry = await plan(s);
  assert.deepEqual([retry.kind, retry.restoreFailed.detail], ['restore_load', holder.restoreFailed.detail]);
  const abandon = await plan(s, { abandonImport: true });
  assert.deepEqual([abandon.kind, abandon.copyProblem, abandon.instances, abandon.beforeImport], ['abandon_load', 'restore_failed', ['personal'], ['workspace']]);
});

test('a graph that was empty before the import is emptied again when the import fails on it, never deleted, and the lock goes', async (t) => {
  const s = scene(t, { before: { personal: 'old:personal', workspace: null },
    admin: async (id, body) => { if (id === 'workspace' && body.startsWith('new:')) throw new Error('neo4j-admin failed'); } });
  await assert.rejects(s.runImport(), /每个图谱都已退回导入前的数据/);
  assert.deepEqual([s.holds('personal'), s.holds('workspace')], ['old:personal', null]);
  assert.equal(existsSync(join(s.paths.nativeWorkspaceDir, 'transactions', 'neo4j')), false, 'its transaction logs move too');
  const [folder] = readdirSync(join(s.root, 'recovered'));
  assert.equal(readFileSync(join(s.root, 'recovered', folder, 'workspace', 'data', 'databases', 'neo4j', 'graph'), 'utf8'), 'half:new:workspace',
    'the half-written store is set aside in the recovered folder');
  assert.equal(existsSync(join(s.root, LOCK)), false);
  assert.equal(s.events.at(-1), 'start (lock gone)');
});

test('a successful import releases its one lock before the services start again', async (t) => {
  const s = scene(t);
  const result = await s.runImport();
  assert.equal(result.status, 'imported');
  assert.deepEqual([s.holds('personal'), s.holds('workspace')], ['new:personal', 'new:workspace']);
  assert.deepEqual([s.events.filter(event => event === 'held').length, s.events.at(-1)], [1, 'start (lock gone)']);
});

test('an import killed after every graph is written: while reconciling, a recovery takes it back; once it recorded that it finished, a recovery only checks the start', async (t) => {
  const reconciling = await killedAt(t, 'reconcile');
  assert.deepEqual(reconciling.holder.graphStates, { personal: 'imported', workspace: 'imported' });
  assert.equal(reconciling.holder.completed, undefined);
  assert.deepEqual([reconciling.recovery.kind, reconciling.recovery.steps.map(step => step.do)], ['restore_load', ['restore', 'mark-restored', 'check-start', 'release-lock']]);
  const finished = await killedAt(t, recordedAfter({ completed: true }));
  assert.equal(finished.holder.completed, true);
  assert.deepEqual([finished.s.holds('personal'), finished.s.holds('workspace')], ['new:personal', 'new:workspace']);
  assert.deepEqual([finished.recovery.kind, finished.recovery.steps.map(step => step.do)], ['finish_load', ['check-start', 'release-lock']]);
  assert.equal(finished.recovery.steps[0].afterImport, true, 'the lock goes even if that start fails: the graph is whole');
  assert.equal(finished.abandon.reason, 'no_import', 'nothing to abandon');
  assert.match(formatRecoveryPlan(finished.recovery), /做完一次已经成功的导入.+不撤回这次导入/s);
  // The start it refuses knows it too (startup-failure.js words it).
  await assert.rejects(finished.s.services({ paths: finished.s.paths }).start(), error => error.startupFailure?.completed === true);
  await applyNativeRecovery({ paths: finished.s.paths, digest: finished.recovery.digest, dependencies: recoveryDeps });
  assert.deepEqual([finished.s.holds('personal'), finished.s.holds('workspace'), existsSync(join(finished.s.root, LOCK))], ['new:personal', 'new:workspace', false]);
});

test('a graph is recorded as being written only once its dump is staged, right before neo4j-admin writes', async (t) => {
  const s = scene(t, { killAt: name => name === states('writing', 'untouched') });
  s.runImport().catch(() => {});
  await s.kill;
  const staged = readdirSync(s.bundleDir).filter(name => name.startsWith('.fuli-neo4j-'));
  assert.equal(staged.length, 1);
  assert.equal(readFileSync(join(s.bundleDir, staged[0], 'neo4j.dump'), 'utf8'), 'new:personal');
  assert.equal(s.events.some(event => event.startsWith('load ')), false, 'neo4j-admin has not begun');
});

test('a graph empty before the import that cannot be emptied again keeps the lock and records why for the recovery', async (t) => {
  const s = scene(t, { before: { personal: 'old:personal', workspace: null },
    admin: async (id, body) => { if (id === 'workspace' && body.startsWith('new:')) throw new Error('neo4j-admin failed'); },
    setAside: async () => { throw new Error('EBUSY: resource busy or locked'); } });
  await assert.rejects(s.runImport(), (error) => {
    assert.equal(error.code, 'graph_import_incomplete');
    assert.match(error.message, /自动退回没有做完（EBUSY/);
    return true;
  });
  assert.deepEqual(lockOf(s).setAsideFailed, { graph: 'workspace', detail: 'EBUSY: resource busy or locked' });
  const recovery = await plan(s);
  assert.deepEqual(recovery.setAsideFailed, lockOf(s).setAsideFailed);
  assert.match(formatRecoveryPlan(recovery), /导入自己退回时没能把 workspace（导入前是空的）挪开：EBUSY: resource busy or locked。这次会再挪一遍。/);
});

test('releasing the lease after a failed import does not hide why the import failed', async (t) => {
  const s = scene(t, { admin: async (id, body) => { if (id === 'workspace' && body.startsWith('new:')) throw new Error('neo4j-admin failed'); } });
  const adapter = await s.adapter();
  const lease = adapter.holdImport;
  adapter.holdImport = async details => ({ ...await lease(details), release: async () => { throw new Error('the lock could not be removed'); } });
  await assert.rejects(importGraphData({ inputDir: await s.bundle(), targetMode: 'native', rollbackDir: s.paths.graphBackupDir, adapter }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /每个图谱都已退回导入前的数据.+could not be released either: the lock could not be removed/s);
    return true;
  });
});

test('graph migrate whose import keeps the native lock switches back to the unchanged container graph, leaves the lock, and says to recover before moving again', async (t) => {
  // The native graph is empty before the move; recording the second graph's state fails (a full disk).
  const s = scene(t, { before: {}, record: async (patch) => { if (patch.graphStates?.workspace === 'writing') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); } });
  const container = { personal: 'container:personal', workspace: 'container:workspace' };
  let mode = 'container';
  const steps = [];
  const written = [];
  const containerAdapter = { instances: ['personal', 'workspace'], census: async () => ({ labels: {}, relationships: {} }) };
  await assert.rejects(migrateContainerGraphToNative({ backupRoot: s.paths.graphBackupDir, now: () => new Date('2026-11-24T00:00:00Z'), ports: {
    runtimeMode: () => mode,
    checkNative: async () => {},
    consoleRunning: async () => false,
    // As `fuli stop` does it: a native runtime of its own, without the import's token, stops under the lifecycle lock.
    stopRuntime: async () => { steps.push('stop'); await s.services({ paths: s.paths }).stopDatabases(); },
    startRuntime: async () => { steps.push('start'); },
    createAdapter: async (kind) => kind === 'container' ? containerAdapter : s.adapter(),
    exportGraph: async () => {},
    importGraph: async () => { steps.push('import'); return importGraphData({ inputDir: await s.bundle(), targetMode: 'native', rollbackDir: s.paths.graphBackupDir, adapter: await s.adapter() }); },
    setupRuntime: async (next) => { steps.push(`setup ${next}`); mode = next; },
    write: line => written.push(line)
  } }), (error) => {
    assert.match(error.message, /已回到容器图谱，可以正常使用，容器里的数据没有变；导出在 .+原生运行时留着一把维护锁：再次迁移之前，先运行 fuli graph runtime recover，它会把原生图谱退回到这次迁移之前（之前是空的就清空），容器数据不受影响。/s);
    assert.match(error.message, /Fuli is back on the container graph and can be used as usual; the container data did not change/);
    assert.match(error.message, /磁盘满了：先腾出一些磁盘空间/, 'a full disk is said first');
    return true;
  });
  assert.deepEqual(steps, ['setup native', 'import', 'setup container'], 'the native runtime is not stopped under the lock it holds');
  assert.equal(mode, 'container');
  assert.deepEqual(container, { personal: 'container:personal', workspace: 'container:workspace' }, 'the container data is not touched');
  assert.equal(lockOf(s).operation, 'load', 'the native lock stays for a recovery');
  // That recovery empties the native graph again: it was empty before the move.
  const recovery = await plan(s);
  assert.deepEqual([recovery.kind, recovery.restorePoint, recovery.emptied], ['restore_load', null, ['personal', 'workspace']]);
});
