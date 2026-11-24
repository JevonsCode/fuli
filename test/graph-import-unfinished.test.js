import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { abandonUnfinishedImport } from '../src/backup/abandon-import.js';
import { exportGraphData, importGraphData } from '../src/backup/graph-backup.js';
import { createGraphBackupAdapter } from '../src/backup/runtime-adapters.js';
import { graphImportCommand, markUnfinishedImport, readUnfinishedImport } from '../src/backup/unfinished-import.js';
import { reportingStartupFailure } from '../src/local-runtime/startup-failure.js';
import { startupFailureLine } from '../src/local-runtime/startup-failure-line.js';
import { createNativeGraphServices } from '../src/native-runtime/runtime.js';
import { ensureGraphRuntime } from '../src/setup/graph-runtime.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';
import { moveCommand } from '../src/text/terminal-command.js';

// On a runtime with no lifecycle lock — containers, and native outside macOS
// (here the native runtime with platform 'linux', which takes the same path as
// Windows: no lock) — an import keeps a marker while a graph may be half
// written (backup/unfinished-import.js). Real adapters and the real import;
// neo4j-admin and docker are faked: a graph's store is one file that says
// whose data it is. Killing the import is a step that never returns.
// [beforeLoad] runs before a load stages its dump (the copy step), [cpFails]
// fails docker's copy into the helper, [empty] graphs have no data at first,
// and [asideFails] fails moving a container graph aside.

const ENVIRONMENT = ['FULI_PERSONAL_NEO4J_PASSWORD=personal-password', 'FULI_WORKSPACE_NEO4J_PASSWORD=workspace-password',
  'FULI_PERSONAL_BOOTSTRAP_TOKEN=personal-bootstrap-token-1234', 'FULI_WORKSPACE_BOOTSTRAP_TOKEN=workspace-bootstrap-token-12'].join('\n');
const never = () => new Promise(() => {});

function scene(t, mode, { admin = async () => {}, killAt = () => false, beforeLoad = async () => {}, cpFails = () => false, empty = [], asideFails = () => false, logsFail = () => false, reconcileFails = () => false } = {}) {
  const asideFolders = [];
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
  for (const id of ['personal', 'workspace']) if (!empty.includes(id)) writeFileSync(store(id), `old:${id}`);
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
      load: async (id, from, options) => { await beforeLoad(id, readFileSync(from, 'utf8')); return real.load(id, from, options); },
      hasData: async id => existsSync(store(id)),
      stop: async () => ({ ...await real.stop(), resume: true }),
      start: async () => { events.push('start'); },
      reconcile: async () => { await checkpoint('reconcile'); if (reconcileFails()) throw new Error('identity reconciliation failed'); } };
  }
  // docker: a helper container per graph whose /backup/neo4j.dump stands apart from the store.
  function docker() {
    const helpers = new Map();
    return async (_command, args) => {
      if (args.includes('run')) { helpers.set(args[args.indexOf('--name') + 1], { id: args.at(-4).replace('-neo4j', ''), dump: null }); return ''; }
      if (args[0] === 'cp') {
        const [from, to] = args.slice(1);
        if (to.includes(':/backup/') && cpFails()) throw new Error('Error response from daemon: copying into the container failed: no space left on device');
        if (to.includes(':/backup/')) helpers.get(to.split(':')[0]).dump = readFileSync(from, 'utf8');
        else writeFileSync(to, helpers.get(from.split(':')[0]).dump);
        return '';
      }
      // The set-aside script: the store moves inside the volume, into the folder it names, and it says
      // where; [logsFail] then fails moving the transaction logs.
      if (args[0] === 'exec' && args.includes('-c')) {
        const helper = helpers.get(args[1]);
        if (asideFails()) throw new Error('Cannot connect to the Docker daemon');
        asideFolders.push(args.at(-1));
        const failed = logsFail() ? 'failed transactions/neo4j mv: cannot move: Permission denied\n' : '';
        if (!existsSync(store(helper.id))) return failed;
        renameSync(store(helper.id), join(dataDir, 'stores', `${helper.id}${args.at(-1).replace('/data/', '@')}`));
        return `moved databases/neo4j ${args.at(-1)}/databases/neo4j\n${failed}`;
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
  const abandon = async () => abandonUnfinishedImport({ adapter: await adapter(), targetMode: mode, paths });
  const asides = () => readdirSync(join(dataDir, 'stores')).filter(name => name.includes('@recovered-'));
  return { paths, events, kill, killed: () => killed, runImport, bundle, holds, start, copies, abandon, asides, asideFolders, marker: () => readUnfinishedImport(paths, mode) };
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
      // The last way out is always there: giving the import up.
      assert.ok(error.message.includes(`导回走不通时（比如那份备份本身读不了），放弃这次导入：fuli graph abandon-import --target-mode ${mode}，FULI 把图谱 workspace 挪开（不删除）、清掉这条记录，之后它是空的。`));
      assert.match(error.message, /Next: Bring the graph back to before the import/);
      // The desktop window's facts: the way back with the command to copy, written for this platform, and giving up.
      const line = startupFailureLine(error);
      assert.match(line, /"code":"graph_import_unfinished"/);
      const facts = JSON.parse(line.slice('FULI_STARTUP_FAILURE '.length));
      assert.deepEqual([facts.copyName, facts.way, facts.command, facts.abandonCommand],
        [copy, 'copy', graphImportCommand(copyPath, mode), `fuli graph abandon-import --target-mode ${mode}`]);
      assert.doesNotMatch(line, /[\\/]stores/);
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
    await assert.rejects(s.runImport(copyPath), /left half written by an earlier unfinished import and this import did not write it whole/);
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

test('a marker that cannot be read still refuses the start, names its file, the newest whole copy and the move by hand, in that order; giving up refuses too', async (t) => {
  const s = scene(t, 'container');
  await s.runImport();
  const newest = join(s.paths.graphBackupDir, s.copies()[0]);
  // A newer copy that lacks a graph: importing it would be refused, so the whole one comes first.
  const partial = join(s.paths.graphBackupDir, 'before-import-9999-personal-only');
  mkdirSync(partial);
  writeFileSync(join(partial, 'manifest.json'), JSON.stringify({ instances: [{ id: 'personal', file: 'personal.dump' }] }));
  const marker = join(s.paths.dataDir, 'graph-import-unfinished-container.json');
  writeFileSync(marker, '{ not json');
  const move = moveCommand(marker, `${marker}.abandoned`);
  await assert.rejects(s.start(), (error) => {
    assert.ok(error.message.includes(`没有启动：记录上次向容器模式的图谱导入数据的文件 ${marker} 坏了，读不出来：那次导入没有完成，FULI 不知道哪个图谱可能只写了一半，所以不敢启动`));
    assert.ok(error.message.includes(`先用最近一份导入前的副本导回（${newest}）：${graphImportCommand(newest, 'container')}`));
    assert.ok(error.message.includes(`最后的办法是把这个文件挪走：这样 FULI 会启动，但不保证图谱完整，所以能导回的话先导回。命令是 ${move}。`));
    return true;
  });
  await assert.rejects(s.abandon(), (error) => {
    assert.ok(error.message.includes(`没有放弃那次导入：记录它的文件 ${marker} 坏了`));
    // The copy back first (it clears the record), then what moving the record means, then the move.
    const [back, means, command] = [graphImportCommand(newest, 'container'), '不保证图谱完整', move].map(part => error.message.indexOf(part));
    assert.ok(back >= 0 && back < means && means < command, error.message);
    assert.match(error.message, /导回成功后这条记录会自动清掉/);
    return true;
  });
  assert.equal(s.marker().readable, false, 'nothing was given up');
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

test('the import command takes its path literally in PowerShell and in a POSIX shell', () => {
  assert.equal(graphImportCommand('C:\\Users\\a$b\\backups\\graph\\before-import-1', 'native', 'win32'),
    "fuli graph import --input 'C:\\Users\\a$b\\backups\\graph\\before-import-1' --target-mode native --yes");
  assert.equal(graphImportCommand("C:\\it's", 'container', 'win32'), "fuli graph import --input 'C:\\it''s' --target-mode container --yes");
  // PowerShell takes the curly single quotes for ' too: each is doubled the same way.
  assert.equal(graphImportCommand('C:\\a\u2018b\u2019c\u201Ad\u201Be', 'native', 'win32'),
    "fuli graph import --input 'C:\\a\u2018\u2018b\u2019\u2019c\u201A\u201Ad\u201B\u201Be' --target-mode native --yes");
  assert.equal(graphImportCommand('/a\u2019b', 'native', 'linux'), "fuli graph import --input '/a\u2019b' --target-mode native --yes");
  assert.equal(graphImportCommand('/data/backups/graph/x', 'native', 'darwin'), "fuli graph import --input '/data/backups/graph/x' --target-mode native --yes");
  assert.equal(graphImportCommand('/data/a $HOME `id` "q" it\'s/x', 'container', 'linux'),
    "fuli graph import --input '/data/a $HOME `id` \"q\" it'\\''s/x' --target-mode container --yes");
});

// An import killed while writing workspace: the marker says workspace may be half written.
async function killedWhileWritingWorkspace(s) {
  s.runImport().catch(() => {});
  await s.kill;
  return join(s.paths.graphBackupDir, s.copies()[0]);
}

for (const mode of ['native', 'container']) {
  test(`${mode} without a lock: a second import that fails before it writes keeps the first one's marker, says its copy, and starts nothing`, async (t) => {
    // The second import fails at its copy step: docker cp for containers, staging the dump for native.
    let failCopy = false;
    const s = scene(t, mode, { killAt: name => name === 'half new:workspace',
      cpFails: () => failCopy,
      beforeLoad: async () => { if (failCopy && mode === 'native') throw new Error('ENOSPC: no space left on device, copyfile'); } });
    const first = await killedWhileWritingWorkspace(s);
    const before = s.marker();
    failCopy = true;
    await assert.rejects(s.runImport(await s.bundle('second')), (error) => {
      assert.equal(error.code, 'graph_import_incomplete');
      assert.match(error.message, /the workspace graph was left half written by an earlier unfinished import and this import did not write it whole/);
      // The way back is the first import's copy, the one that holds workspace; never the second one's own.
      assert.ok(error.message.includes(`导入前的副本在 ${first}，用 ${graphImportCommand(first, mode)} 导回。`));
      for (const copy of s.copies().map(name => join(s.paths.graphBackupDir, name)).filter(copy => copy !== first)) {
        assert.ok(!error.message.includes(copy), 'the second import\'s own copy lacks workspace');
      }
      assert.ok(error.message.includes(`fuli graph abandon-import --target-mode ${mode}`));
      return true;
    });
    const after = s.marker();
    assert.deepEqual([after.partial, after.copy, after.startedAt], [['workspace'], first, before.startedAt]);
    assert.equal(after.graphStates.workspace, 'importFailed');
    assert.equal(s.holds('workspace'), 'half:new:workspace');
    await assert.rejects(s.start(), /图谱 workspace 可能只写入了一半/);
    // Bringing the first copy back clears it.
    failCopy = false;
    await s.runImport(first);
    assert.deepEqual([s.holds('personal'), s.holds('workspace'), s.marker()], ['old:personal', 'old:workspace', null]);
    await assert.rejects(s.start(), /reached the runtime/);
  });

  test(`${mode} without a lock: a second import killed before it writes keeps the graph the first one left half written as half written`, async (t) => {
    let second = false;
    let killSecond;
    const killedSecond = new Promise(resolve => { killSecond = resolve; });
    let firstKill = true;
    const s = scene(t, mode, { killAt: name => { const now = firstKill && name === 'half new:workspace'; if (now) firstKill = false; return now; },
      beforeLoad: async () => { if (second) { killSecond(); await never(); } } });
    const first = await killedWhileWritingWorkspace(s);
    second = true;
    s.runImport(await s.bundle('second')).catch(() => {});
    await killedSecond;
    const marker = s.marker();
    assert.deepEqual([marker.partial, marker.graphStates.workspace, marker.copy], [['workspace'], 'importFailed', first]);
    await assert.rejects(s.start(), (error) => {
      assert.match(error.message, /图谱 workspace 可能只写入了一半/);
      assert.doesNotMatch(error.message, /新数据已经写完/);
      return true;
    });
    // A later import still never takes the half-written graph for whole data: its copy holds personal only.
    second = false;
    const result = await s.runImport(await s.bundle('third'));
    assert.equal(result.earlierCopy, first, 'the first copy is still kept, and said');
    const copy = JSON.parse(readFileSync(join(result.rollbackDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(copy.instances.map(({ id }) => id), ['personal']);
    assert.equal(s.marker(), null);
  });
}

test('container: a graph empty before an import of a backup neo4j-admin cannot read is emptied again in its volume, and FULI starts', async (t) => {
  const s = scene(t, 'container', { empty: ['workspace'], admin: async (id, body) => { if (id === 'workspace' && body.startsWith('new:')) throw new Error('neo4j-admin: unsupported store format'); } });
  await assert.rejects(s.runImport(), (error) => {
    assert.match(error.message, /每个图谱都已退回导入前的数据。图谱 workspace 导入前是空的，已经重新清空：它写了一半的库挪到了 \/data\/recovered-[0-9TZ-]+（容器 workspace-neo4j 的 Docker 数据卷里），没有删除/);
    // The move back first sets a new empty database in the way aside itself, into another recovered- folder.
    assert.match(error.message, /要搬回去：先退出 FULI（fuli stop），再运行 docker compose --env-file '.+' -f '.+' run --rm --no-deps -T workspace-neo4j sh -c 'if \[ -e \/data\/databases\/neo4j \]; then mkdir -p (\/data\/recovered-[0-9TZ-]+)-replaced\/databases && mv \/data\/databases\/neo4j \1-replaced\/databases\/neo4j; fi && mkdir -p \/data\/databases && mv \1\/databases\/neo4j \/data\/databases\/neo4j'；原位置已经有新建的空库时，这条命令先把它挪进 \/data\/recovered-[0-9TZ-]+-replaced（不删除）。/);
    assert.match(error.message, /if a new empty database is already there, the command first moves it into \/data\/recovered-[0-9TZ-]+-replaced \(not deleted\)\./);
    return true;
  });
  assert.deepEqual([s.holds('personal'), s.holds('workspace'), s.marker()], ['old:personal', null, null]);
  assert.equal(s.asides().length, 1, 'the half-written database is moved, never deleted');
  await assert.rejects(s.start(), /reached the runtime/);
});

test('container: a graph that cannot be emptied again keeps the marker and says to give the import up; giving up moves it once it can', async (t) => {
  let asideFails = true;
  const s = scene(t, 'container', { empty: ['workspace'], asideFails: () => asideFails,
    admin: async (id, body) => { if (id === 'workspace' && body.startsWith('new:')) throw new Error('neo4j-admin: unsupported store format'); } });
  await assert.rejects(s.runImport(), (error) => {
    assert.equal(error.code, 'graph_import_incomplete');
    assert.match(error.message, /图谱 workspace 导入前是空的，这次没能把写了一半的库挪开（Cannot connect to the Docker daemon）。处理好之后运行 fuli graph abandon-import --target-mode container 放弃这次导入：FULI 把可能只写了一半的图谱 workspace 挪开（不删除）、清掉这条记录，之后它是空的。/);
    return true;
  });
  assert.deepEqual(s.marker().partial, ['workspace']);
  await assert.rejects(s.start(), /图谱 workspace 可能只写入了一半/);
  // Giving up while the graph still cannot be moved: the marker stays, and the words end with the way by hand.
  await assert.rejects(s.abandon(), (error) => {
    const path = join(s.paths.dataDir, 'graph-import-unfinished-container.json');
    assert.match(error.message, /没有放弃那次导入：图谱 workspace 没能挪开（Cannot connect to the Docker daemon）。这条记录还在，FULI 仍然不会启动。处理好之后再运行 fuli graph abandon-import --target-mode container。/);
    assert.ok(error.message.includes(`最后的办法是手动把这条记录挪走（标记文件是 ${path}）：这样 FULI 就会启动，但不保证图谱完整。命令是 ${moveCommand(path, `${path}.abandoned`)}。`));
    return true;
  });
  assert.deepEqual(s.marker().partial, ['workspace']);
  asideFails = false;
  const given = await s.abandon();
  assert.equal(given.status, 'abandoned');
  assert.match(given.words, /^已放弃那次没完成的导入，清掉了它的记录，FULI 可以启动了。图谱 workspace 可能只写了一半，已经清空：它写了一半的库挪到了 \/data\/recovered-/);
  assert.deepEqual([s.holds('personal'), s.holds('workspace'), s.marker(), s.asides().length], ['old:personal', null, null, 1]);
  await assert.rejects(s.start(), /reached the runtime/);
});

test('a graph that cannot be moved because a process holds it names that process and how to end it', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-import-unfinished-held-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const paths = resolveSetupPaths({ dataDir, packageRoot: '/package' });
  const input = join(dataDir, 'bundle');
  await exportGraphData({ outputDir: input, sourceMode: 'native', instances: ['personal'],
    adapter: { async stop() { return { resume: false }; }, async dump(id, to) { writeFileSync(to, `new:${id}`); }, async start() {} } });
  await assert.rejects(importGraphData({ inputDir: input, targetMode: 'native', rollbackDir: paths.graphBackupDir, adapter: {
    instances: ['personal'], announcesWrites: true,
    stop: async () => ({ resume: false }), start: async () => {}, dump: async () => {}, hasData: async () => false,
    load: async (_id, _from, { beforeWrite }) => { await beforeWrite(); throw new Error('neo4j-admin failed'); },
    setAside: async () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { holders: [{ pid: 4242, name: 'java' }] }); },
    holdImport: details => markUnfinishedImport(paths, 'native', details),
    unfinishedImport: () => readUnfinishedImport(paths, 'native')
  } }), (error) => {
    assert.match(error.message, /图谱 personal 导入前是空的，这次没能把写了一半的库挪开（EBUSY: resource busy or locked）；还有进程在用它的目录：4242（java），先结束它（kill 4242|Stop-Process -Id 4242）。之后运行 fuli graph abandon-import --target-mode native 放弃这次导入/);
    return true;
  });
  assert.deepEqual(readUnfinishedImport(paths, 'native').partial, ['personal']);
});

test('native without a lock: giving the import up moves the half-written graph into the recovery folder, says how to move it back, and FULI starts', async (t) => {
  const s = scene(t, 'native', { killAt: name => name === 'half new:workspace' });
  await killedWhileWritingWorkspace(s);
  const database = join(s.paths.nativeWorkspaceDir, 'data', 'databases', 'neo4j');
  mkdirSync(database, { recursive: true });
  writeFileSync(join(database, 'store'), 'half');
  const given = await s.abandon();
  assert.equal(given.status, 'abandoned');
  assert.equal(existsSync(database), false);
  const moved = readdirSync(join(s.paths.nativeRuntimeDir, 'recovered'));
  assert.equal(moved.length, 1, 'moved, never deleted');
  const from = join(s.paths.nativeRuntimeDir, 'recovered', moved[0], 'workspace', 'data', 'databases', 'neo4j');
  assert.ok(existsSync(join(from, 'store')));
  assert.ok(given.words.includes(`要搬回去：先退出 FULI（fuli stop），原位置已经有新建的空库时先把它改名挪开，再运行 ${moveCommand(from, database)}。`));
  assert.match(given.words, /导入前的副本还在 .+before-import-/);
  assert.equal(s.marker(), null);
  await assert.rejects(s.start(), /reached the runtime/);
});

for (const mode of ['native', 'container']) {
  test(`${mode} without a lock: a second import killed while finishing names its own input to run again, never the first one's`, async (t) => {
    let firstKill = true;
    let atReconcile;
    const reconciling = new Promise(resolve => { atReconcile = resolve; });
    const s = scene(t, mode, { killAt: name => {
      if (firstKill && name === 'half new:workspace') { firstKill = false; return true; }
      if (name === 'reconcile') { atReconcile(); return true; }
      return false;
    } });
    const first = await killedWhileWritingWorkspace(s);
    const firstInput = join(s.paths.dataDir, 'bundle');
    const second = await s.bundle('second');
    s.runImport(second).catch(() => {});
    await reconciling;
    const marker = s.marker();
    assert.deepEqual([marker.partial, marker.copy, marker.inputDir], [[], first, second], 'the first copy stays; the input is this import\'s');
    await assert.rejects(s.start(), (error) => {
      assert.ok(error.message.includes(`重新运行那次导入，把收尾做完：${graphImportCommand(second, mode)}。`));
      assert.ok(!error.message.includes(graphImportCommand(firstInput, mode)), 'the first import\'s input would overwrite what the second wrote');
      const facts = JSON.parse(startupFailureLine(error).slice('FULI_STARTUP_FAILURE '.length));
      assert.deepEqual([facts.way, facts.command], ['input', graphImportCommand(second, mode)]);
      return true;
    });
  });

  test(`${mode} without a lock: a second import that writes the half-written graph whole and then rolls back says the first import's copy is still kept`, async (t) => {
    let failReconcile = false;
    const s = scene(t, mode, { killAt: name => name === 'half new:workspace' && !failReconcile, reconcileFails: () => failReconcile });
    const first = await killedWhileWritingWorkspace(s);
    failReconcile = true;
    await assert.rejects(s.runImport(await s.bundle('second')), (error) => {
      assert.match(error.message, /图谱 workspace 被上次没完成的导入只写了一半，这次已经把它完整导入/);
      assert.ok(error.message.includes(`上次没完成的那次导入之前的副本还留着：${first}，用不着时可以自己删掉。`));
      assert.ok(error.message.includes(`The copy taken before the earlier unfinished import is still kept at ${first}`));
      return true;
    });
    assert.equal(s.marker(), null);
  });
}

test('container: moving the transaction logs aside fails after the database moved: the words say where it went, and a rerun uses the same folder', async (t) => {
  let logsFail = true;
  const s = scene(t, 'container', { killAt: name => name === 'half new:workspace', logsFail: () => logsFail });
  await killedWhileWritingWorkspace(s);
  await assert.rejects(s.abandon(), (error) => {
    assert.match(error.message, /图谱 workspace 没能挪开（moving transactions\/neo4j into (\/data\/recovered-[0-9TZ-]+) failed \(mv: cannot move: Permission denied\); already moved, not deleted: \/data\/databases\/neo4j to \1\/databases\/neo4j \(in the volume of the workspace-neo4j container\); running it again moves the rest into the same folder）/);
    return true;
  });
  assert.equal(s.marker().partial.length, 1, 'the marker stays');
  logsFail = false;
  assert.equal((await s.abandon()).status, 'abandoned');
  assert.equal(new Set(s.asideFolders).size, 1, 'one folder for one unfinished import');
});
