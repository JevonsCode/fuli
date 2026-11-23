import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { exportGraphData, importGraphData } from '../src/backup/graph-backup.js';
import { createGraphBackupAdapter } from '../src/backup/runtime-adapters.js';
import { graphImportCommand, readUnfinishedImport } from '../src/backup/unfinished-import.js';
import { reportingStartupFailure } from '../src/local-runtime/startup-failure.js';
import { startupFailureLine } from '../src/local-runtime/startup-failure-line.js';
import { createNativeGraphServices } from '../src/native-runtime/runtime.js';
import { ensureGraphRuntime } from '../src/setup/graph-runtime.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

// On a runtime with no lifecycle lock — containers, and native outside macOS
// (here the native runtime with platform 'linux', which takes the same path as
// Windows: no lock) — an import keeps a marker while a graph may be half
// written (backup/unfinished-import.js). Real adapters and the real import;
// neo4j-admin and docker are faked: a graph's store is one file that says
// whose data it is. Killing the import is a step that never returns.

const ENVIRONMENT = ['FULI_PERSONAL_NEO4J_PASSWORD=personal-password', 'FULI_WORKSPACE_NEO4J_PASSWORD=workspace-password',
  'FULI_PERSONAL_BOOTSTRAP_TOKEN=personal-bootstrap-token-1234', 'FULI_WORKSPACE_BOOTSTRAP_TOKEN=workspace-bootstrap-token-12'].join('\n');
const never = () => new Promise(() => {});

function scene(t, mode, { admin = async () => {}, killAt = () => false } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), `fuli-import-unfinished-${mode}-`));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const paths = resolveSetupPaths({ dataDir, packageRoot: '/package' });
  mkdirSync(paths.nativeRuntimeDir, { recursive: true });
  writeFileSync(paths.graphRuntimeConfigPath, JSON.stringify({ workspaces: [{ managedDevelopment: true }] }));
  writeFileSync(paths.nativeRuntimeManifestPath, JSON.stringify({ status: 'ready', mode: 'native', javaHome: '/jdk', neo4jHome: '/neo4j', providerPython: '/python', neo4jVersion: '5.26.28' }));
  // Each graph's store: a file in the data directory standing for the native store or the container volume.
  const store = id => join(dataDir, 'stores', `${id}.graph`);
  mkdirSync(join(dataDir, 'stores'));
  const holds = id => existsSync(store(id)) ? readFileSync(store(id), 'utf8') : null;
  for (const id of ['personal', 'workspace']) writeFileSync(store(id), `old:${id}`);
  const events = [];
  let killed;
  const kill = new Promise(resolve => { killed = resolve; });
  const checkpoint = async (name) => { events.push(name); if (killAt(name)) { killed(name); await never(); } };
  // neo4j-admin: a dump copies the store out, a load writes it (half first, then whole).
  const dump = (id, to) => writeFileSync(to, readFileSync(store(id)));
  const load = async (id, from) => {
    const body = readFileSync(from, 'utf8');
    await checkpoint(`load ${body}`);
    writeFileSync(store(id), `half:${body}`);
    await checkpoint(`half ${body}`);
    await admin(id, body);
    writeFileSync(store(id), body);
  };
  async function adapter() {
    const real = mode === 'native'
      ? await createGraphBackupAdapter({ mode, paths, createNativeServices: options => createNativeGraphServices({ ...options, platform: 'linux', env: {},
        readText: async () => ENVIRONMENT, writeText: async () => {}, pathExists: () => true, markInitialized: () => {},
        readProcessState: () => null, writeProcessState: () => {}, readSettings: () => ({ ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native' }),
        spawnDatabase: () => assert.fail('no Neo4j is started'),
        run: async (_command, args, { cwd }) => {
          const id = cwd === paths.nativePersonalDir ? 'personal' : 'workspace';
          if (args[1] === 'dump') return dump(id, join(args[3].slice('--to-path='.length), 'neo4j.dump'));
          if (args[1] === 'load') return load(id, join(args[3].slice('--from-path='.length), 'neo4j.dump'));
        } }) })
      : await createGraphBackupAdapter({ mode, paths, ensureContainer: async () => ({ dockerCommand: 'docker', dockerEnvironment: {} }), run: docker() });
    return { ...real,
      hasData: async id => existsSync(store(id)),
      stop: async () => ({ ...await real.stop(), resume: true }),
      start: async () => { events.push('start'); },
      reconcile: async () => { await checkpoint('reconcile'); } };
  }
  // docker: a helper container per graph whose /backup/neo4j.dump stands apart from the store.
  function docker() {
    const helpers = new Map();
    return async (_command, args) => {
      if (args.includes('run')) { helpers.set(args[args.indexOf('--name') + 1], { id: args.at(-4).replace('-neo4j', ''), dump: null }); return ''; }
      if (args[0] === 'cp') {
        const [from, to] = args.slice(1);
        if (to.includes(':/backup/')) helpers.get(to.split(':')[0]).dump = readFileSync(from, 'utf8');
        else writeFileSync(to, helpers.get(from.split(':')[0]).dump);
        return '';
      }
      if (args[0] === 'exec' && args.includes('neo4j-admin')) {
        const helper = helpers.get(args[1]);
        if (args.includes('dump')) { helper.dump = readFileSync(store(helper.id), 'utf8'); return ''; }
        const staged = join(dataDir, `${args[1]}.dump`);
        writeFileSync(staged, helper.dump);
        await load(helper.id, staged);
        return '';
      }
      return '';
    };
  }
  async function bundle(name = 'bundle') {
    const source = join(dataDir, name);
    await exportGraphData({ outputDir: source, sourceMode: mode, instances: ['personal', 'workspace'],
      adapter: { async stop() { return { resume: false }; }, async dump(id, to) { writeFileSync(to, `new:${id}`); }, async start() {} } });
    return source;
  }
  const runImport = async (inputDir) => importGraphData({ inputDir: inputDir ?? await bundle(), targetMode: mode, rollbackDir: paths.graphBackupDir, adapter: await adapter() });
  // A start in [mode] as `fuli start` and the tray run it: refused before any runtime is touched, or
  // reaching the runtime (which throws here, so nothing really starts).
  const start = () => reportingStartupFailure(() => ensureGraphRuntime({ paths, runtimeMode: mode, runtimeSettings: { ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: mode } }, {
    readState: () => null, readAdaptiveSettings: () => ({}),
    ensureContainerRuntime: async () => { throw new Error('reached the runtime'); },
    ensureNativeRuntime: async () => { throw new Error('reached the runtime'); } }));
  const copies = () => existsSync(paths.graphBackupDir) ? readdirSync(paths.graphBackupDir).filter(name => name.startsWith('before-import-')) : [];
  return { paths, events, kill, runImport, holds, start, copies, marker: () => readUnfinishedImport(paths, mode) };
}

const failWorkspace = (id, body) => { if (id === 'workspace' && body.startsWith('new:')) throw new Error('neo4j-admin failed'); };
const failRollback = (id, body) => { if (id === 'workspace' || body.startsWith('old:personal')) throw new Error(`neo4j-admin failed on ${body}`); };

for (const mode of ['native', 'container']) {
  test(`${mode} without a lock: an import killed while writing leaves its marker, a start is refused and names the import that brings the copy back; that import clears it`, async (t) => {
    const s = scene(t, mode, { killAt: name => name === 'half new:workspace' });
    s.runImport().catch(() => {});
    await s.kill;
    assert.deepEqual([s.holds('personal'), s.holds('workspace')], ['new:personal', 'half:new:workspace']);
    const marker = s.marker();
    assert.deepEqual([marker.graphStates, marker.partial], [{ personal: 'imported', workspace: 'writing' }, ['workspace']]);
    const [copy] = s.copies();
    const copyPath = join(s.paths.graphBackupDir, copy);
    await assert.rejects(s.start(), (error) => {
      assert.doesNotMatch(error.message, /reached the runtime/, 'nothing is started');
      assert.match(error.message, new RegExp(`没有启动：上次向${mode === 'native' ? '原生' : '容器'}模式的图谱导入数据（.+开始）没有完成，图谱 workspace 可能只写入了一半，这次没有启动任何东西。`));
      assert.ok(error.message.includes(`下一步：把图谱导回到导入前（导入前的副本在 ${copyPath}）：${graphImportCommand(copyPath, mode)}。导回成功后再启动。`));
      assert.match(error.message, /Next: Bring the graph back to before the import/);
      // The desktop window's facts: the way back and the copy's folder name, never a path.
      const line = startupFailureLine(error);
      assert.match(line, /"code":"graph_import_unfinished"/);
      assert.ok(line.includes(`"copyName":"${copy}"`) && line.includes('"way":"copy"'));
      assert.doesNotMatch(line, /Path"|[\\/]stores/);
      return true;
    });
    // The import itself is not held back: the copy goes back, the marker goes, and a start reaches the runtime.
    const back = await s.runImport(copyPath);
    assert.equal(back.status, 'imported');
    assert.deepEqual([s.holds('personal'), s.holds('workspace')], ['old:personal', 'old:workspace']);
    assert.equal(s.marker(), null);
    await assert.rejects(s.start(), /reached the runtime/);
  });

  test(`${mode} without a lock: an import whose rollback fails keeps its marker and starts nothing; importing the copy back clears it`, async (t) => {
    let broken = true;
    const s = scene(t, mode, { admin: async (id, body) => { if (broken) failRollback(id, body); } });
    await assert.rejects(s.runImport(), (error) => {
      assert.equal(error.code, 'graph_import_incomplete');
      assert.match(error.message, /FULI 记下了这次导入没有完成，在把图谱导回之前不会启动。/);
      return true;
    });
    assert.equal(s.events.includes('start'), false);
    assert.deepEqual(s.marker().partial, ['personal', 'workspace']);
    await assert.rejects(s.start(), /没有启动：.+图谱 personal、workspace 可能只写入了一半/s);
    const copyPath = join(s.paths.graphBackupDir, s.copies()[0]);
    // Still failing: the half-written graphs are not copied again, nothing can bring them back, and the marker keeps the first copy.
    await assert.rejects(s.runImport(copyPath), /already half written by an earlier unfinished import/);
    assert.deepEqual([s.copies().length, s.marker().copy], [1, copyPath]);
    // Once the cause is gone, the copy goes back and the marker goes.
    broken = false;
    await s.runImport(copyPath);
    assert.deepEqual([s.holds('personal'), s.holds('workspace'), s.marker()], ['old:personal', 'old:workspace', null]);
    await assert.rejects(s.start(), /reached the runtime/);
  });

  test(`${mode} without a lock: no marker after an import that succeeds or rolls back`, async (t) => {
    const ok = scene(t, mode);
    await ok.runImport();
    assert.equal(ok.marker(), null);
    assert.equal(ok.events.at(-1), 'start');
    const rolled = scene(t, mode, { admin: async (id, body) => failWorkspace(id, body) });
    await assert.rejects(rolled.runImport(), /每个图谱都已退回导入前的数据/);
    assert.equal(rolled.marker(), null);
    assert.deepEqual([rolled.holds('personal'), rolled.holds('workspace')], ['old:personal', 'old:workspace']);
    assert.equal(rolled.events.at(-1), 'start');
  });
}

test('a marker that cannot be read still refuses the start; one for the other runtime mode does not', async (t) => {
  const s = scene(t, 'container');
  writeFileSync(join(s.paths.dataDir, 'graph-import-unfinished-container.json'), '{ not json');
  await assert.rejects(s.start(), /没有启动：上次向容器模式的图谱导入数据没有完成.+backups\/graph/s);
  const native = scene(t, 'native');
  writeFileSync(join(native.paths.dataDir, 'graph-import-unfinished-container.json'), '{}');
  await assert.rejects(native.start(), /reached the runtime/);
});

test('an import that lacks a graph an unfinished one may have left half written changes nothing and says the way back', async (t) => {
  const s = scene(t, 'container', { killAt: name => name === 'half new:workspace' });
  s.runImport().catch(() => {});
  await s.kill;
  const personalOnly = join(s.paths.dataDir, 'personal-only');
  await exportGraphData({ outputDir: personalOnly, sourceMode: 'container', instances: ['personal'],
    adapter: { async stop() { return { resume: false }; }, async dump(id, to) { writeFileSync(to, `other:${id}`); }, async start() {} } });
  await assert.rejects(s.runImport(personalOnly), (error) => {
    assert.match(error.message, /没有导入：上次没有完成的导入可能把图谱 workspace 只写入了一半，这份备份里没有它/);
    assert.ok(error.message.includes(graphImportCommand(join(s.paths.graphBackupDir, s.copies()[0]), 'container')));
    return true;
  });
  assert.equal(s.holds('personal'), 'new:personal', 'nothing changed');
});

test('PowerShell gets the import command with a literal path', () => {
  assert.equal(graphImportCommand('C:\\Users\\a$b\\backups\\graph\\before-import-1', 'native', 'win32'),
    "fuli graph import --input 'C:\\Users\\a$b\\backups\\graph\\before-import-1' --target-mode native --yes");
  assert.equal(graphImportCommand("C:\\it's", 'container', 'win32'), "fuli graph import --input 'C:\\it''s' --target-mode container --yes");
  assert.equal(graphImportCommand('/data/backups/graph/x', 'native', 'darwin'), 'fuli graph import --input "/data/backups/graph/x" --target-mode native --yes');
});
