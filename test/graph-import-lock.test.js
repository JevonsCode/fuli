import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { exportGraphData, importGraphData } from '../src/backup/graph-backup.js';
import { createGraphBackupAdapter } from '../src/backup/runtime-adapters.js';
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
function scene(t, { before = { personal: 'old:personal', workspace: 'old:workspace' }, admin = async () => {}, record = async () => {}, killAt = () => false } = {}) {
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
      reconcile: async () => { events.push('reconcile'); },
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
  return { paths, events, kill, runImport, holds, root: paths.nativeRuntimeDir };
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
  await assert.rejects(createNativeGraphServices({ paths: s.paths, platform: 'darwin', env: {} }).start(), /in progress/, 'a start is held back');
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
    record: async (patch) => { if (patch.graphStates?.workspace === 'importFailed') chmodSync(join(copyOf(s), 'personal.dump'), 0o000); } });
  await assert.rejects(s.runImport(), (error) => {
    assert.equal(error.code, 'graph_import_incomplete');
    assert.match(error.message, /自动退回没有做完（.*EACCES.*）。维护锁留着，FULI 不会在写了一半的图谱上启动。运行 fuli graph runtime recover/s);
    assert.match(error.message, /The maintenance lock is kept/);
    return true;
  });
  const holder = lockOf(s);
  assert.deepEqual(holder.graphStates, { personal: 'restoreFailed', workspace: 'restored' });
  assert.match(holder.restoreFailed.detail, /EACCES/, 'why is recorded for the recovery\'s words');
  assert.equal(s.events.some(event => event.startsWith('start')), false, 'nothing starts on a half-written graph');
  // What #1084's recovery already knows: retry the restore, or abandon (the copy is good) and move the failed graph aside.
  chmodSync(join(copyOf(s), 'personal.dump'), 0o600);
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
