import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { abandonUnfinishedImport } from '../src/backup/abandon-import.js';
import { exportGraphData } from '../src/backup/graph-backup.js';
import { claimImportRun } from '../src/backup/import-run.js';
import { planUnfinishedImport } from '../src/backup/unfinished-import-plan.js';
import { clearUnfinishedImport, markUnfinishedImport, readUnfinishedImport, unfinishedImportError } from '../src/backup/unfinished-import.js';
import { runTrayAction } from '../src/desktop/desktop-controller.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS, writeRuntimeSettings } from '../src/system/runtime-settings.js';

// An import into a runtime with no lifecycle lock (Windows native, containers)
// left its marker, so every start is refused (backup/unfinished-import.js).
// The desktop window's way out: 「导回到导入前并启动」 (or running that import
// again) and giving the import up, confirmed by the plan's digest and run as
// the same `fuli graph import` / `fuli graph abandon-import` the terminal runs.

async function backup(dir, ids = ['personal', 'workspace']) {
  await exportGraphData({ outputDir: dir, sourceMode: 'native', instances: ids,
    adapter: { async stop() { return { resume: false }; }, async dump(id, to) { writeFileSync(to, `data:${id}`); }, async start() {} } });
  return dir;
}

async function marked(t, mode, { graphStates = { personal: 'writing', workspace: 'untouched' }, copy = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), `fuli-unfinished-window-${mode}-`));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const paths = resolveSetupPaths({ dataDir });
  mkdirSync(paths.graphBackupDir, { recursive: true });
  writeRuntimeSettings(paths.runtimeSettingsPath, { ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: mode });
  const before = copy ? await backup(join(paths.graphBackupDir, 'before-import-2026-11-20T08-00-00-000Z-a')) : null;
  const input = await backup(join(dataDir, 'exports', 'fuli-1'));
  markUnfinishedImport(paths, mode, { restorePoint: { path: before }, graphStates, inputDir: input }, () => new Date('2026-11-20T08:00:00.000Z'));
  return { paths, before, input };
}

test('the way back is planned from the marker: its copy, or its input again, and giving up names the graphs and where they go', async (t) => {
  const { paths, before, input } = await marked(t, 'container');
  const back = await planUnfinishedImport({ paths, mode: 'container' });
  assert.deepEqual([back.kind, back.from, back.instances, back.graphs], ['import_back', before, ['personal', 'workspace'], ['personal']]);
  assert.match(back.digest, /^[0-9a-f]{16}$/);
  assert.ok(back.bytes > 0, 'the copy\'s size is shown');
  const giveUp = await planUnfinishedImport({ paths, mode: 'container', abandon: true });
  assert.deepEqual([giveUp.kind, giveUp.graphs, giveUp.asideTo], ['abandon_import', ['personal'], { folder: '/data/recovered-2026-11-20T08-00-00-000Z', volume: true }]);
  assert.notEqual(giveUp.digest, back.digest);

  // Without the copy, the import's own input runs again; with that gone too, nothing is guessed.
  rmSync(before, { recursive: true });
  const again = await planUnfinishedImport({ paths, mode: 'container' });
  assert.deepEqual([again.kind, again.from], ['import_again', input]);
  rmSync(input, { recursive: true });
  assert.equal(unfinishedImportError(paths, 'container').startupFailure.wayGone, true, 'a refused start says the way back is gone');
  const gone = await planUnfinishedImport({ paths, mode: 'container' });
  assert.deepEqual([gone.kind, gone.reason, gone.code, gone.wayGone], ['refused', 'import_input_missing', undefined, true]);
  assert.match(gone.abandonCommand, /fuli graph abandon-import --target-mode container/, 'a refusal keeps the commands for a terminal');
});

test('a marker that cannot be read goes back to the newest copy from before an import, and is never given up by guessing', async (t) => {
  const { paths, before } = await marked(t, 'native');
  writeFileSync(readUnfinishedImport(paths, 'native').path, '{ not json');
  const back = await planUnfinishedImport({ paths, mode: 'native' });
  assert.deepEqual([back.kind, back.from, back.readable, back.graphs], ['import_back', before, false, ['personal', 'workspace']]);
  const giveUp = await planUnfinishedImport({ paths, mode: 'native', abandon: true });
  assert.deepEqual([giveUp.kind, giveUp.reason], ['refused', 'marker_unreadable']);
  assert.match(giveUp.moveMarkerCommand, /graph-import-unfinished-native\.json/);
});

function tray(paths) {
  const context = { packageRoot: '/x/pkg', dataDir: paths.dataDir, nodePath: '/x/node', cliPath: '/x/cli.js' };
  const calls = [];
  const runCli = async (_context, args) => {
    calls.push(args.slice(0, args.indexOf('--data-dir')).join(' '));
    const running = calls.some(call => call === 'start');
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ status: running ? 'running' : 'stopped' }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  // Native mode with a marker is Windows' (no lifecycle lock); containers are anywhere.
  const options = { runCli, otherConsole: () => null, holdAdoption: () => null, portBlocked: async () => false, platform: 'win32',
    recovery: { plan: async () => assert.fail('not the macOS recovery'), apply: async () => assert.fail('not the macOS recovery') } };
  return { context, calls, options };
}

test('the window imports the copy it showed, then starts; the stage says what it is doing', async (t) => {
  const { paths, before } = await marked(t, 'native');
  writeFileSync(join(paths.dataDir, 'graph-runtime.json'), '{}');
  const { context, calls, options } = tray(paths);
  const preview = await runTrayAction('recover-preview', context, options);
  assert.deepEqual([preview.ok, preview.recoveryPlan.kind, preview.recoveryPlan.from], [true, 'import_back', before]);
  const stages = [];
  const graphData = async (action, args, dependencies) => {
    calls.push(`graph ${action} ${args.join(' ')}`);
    assert.equal(dependencies.interactive, true);
    clearUnfinishedImport(paths, 'native');
    return { status: 'imported' };
  };
  const started = await runTrayAction('recover-start', context, { ...options, graphData, recoveryDigest: preview.recoveryPlan.digest,
    onStage: stage => stages.push(stage) });
  assert.equal(started.ok, true);
  assert.equal(calls.find(call => call.startsWith('graph ')), `graph import --input ${before} --target-mode native --data-dir ${paths.dataDir} --yes`);
  assert.ok(calls.findIndex(call => call.startsWith('graph ')) < calls.indexOf('start'), 'it starts only after the import');
  assert.equal(stages[0], 'graph_import');
});

test('a failed import keeps the marker\'s buttons and says why; a changed plan does nothing; giving up reports where the graphs went', async (t) => {
  const { paths } = await marked(t, 'native');
  const { context, calls, options } = tray(paths);
  const { digest } = await planUnfinishedImport({ paths, mode: 'native' });
  const failing = async () => { throw new Error('导入没有成功：Backup checksum validation failed for personal.\n下一步 / Graph import failed'); };
  const failed = await runTrayAction('recover-start', context, { ...options, graphData: failing, recoveryDigest: digest });
  assert.deepEqual([failed.ok, failed.failure.code, failed.failure.attemptError], [false, 'graph_import_unfinished',
    '导入没有成功：Backup checksum validation failed for personal.']);
  assert.equal(calls.includes('start'), false, 'nothing starts on a graph that may be half written');

  const changed = await runTrayAction('recover-start', context, { ...options, graphData: () => assert.fail('nothing runs'), recoveryDigest: 'ffffffffffffffff' });
  assert.deepEqual([changed.ok, changed.failure.reason], [false, 'plan_changed']);

  const giveUp = await planUnfinishedImport({ paths, mode: 'native', abandon: true });
  const run = [];
  const abandoned = await runTrayAction('abandon-import-start', context, { ...options, recoveryDigest: giveUp.digest,
    graphData: async (action, args, dependencies) => {
      run.push([action, args, dependencies.interactive]);
      clearUnfinishedImport(paths, 'native');
      return { status: 'abandoned', words: '已放弃那次没完成的导入 / The unfinished import was given up' };
    } });
  assert.deepEqual(run, [['abandon-import', ['--target-mode', 'native', '--data-dir', paths.dataDir, '--yes'], true]]);
  assert.equal(abandoned.importAbandoned, '已放弃那次没完成的导入 / The unfinished import was given up');
});

const runRecord = paths => join(paths.dataDir, 'graph-import-running-native.json');

test('while an earlier way back still runs, the window refuses another, and a record whose process ended does not count', async (t) => {
  const { paths } = await marked(t, 'native');
  const { context, options } = tray(paths);
  // This test's own process stands for a controller still importing.
  const run = await claimImportRun(paths, 'native', 'import');
  const preview = await runTrayAction('recover-preview', context, options);
  assert.deepEqual([preview.recoveryPlan.kind, preview.recoveryPlan.reason, preview.recoveryPlan.pid, preview.recoveryPlan.runKind],
    ['refused', 'import_running', process.pid, 'import']);
  assert.equal(preview.recoveryPlan.abandonCommand, undefined, 'nothing to click or copy while it runs');
  const giveUp = await runTrayAction('abandon-import-preview', context, options);
  assert.equal(giveUp.recoveryPlan.reason, 'import_running');
  const { digest } = await planUnfinishedImport({ paths, mode: 'native', identity: { state: () => 'gone' } });
  const started = await runTrayAction('recover-start', context, { ...options, recoveryDigest: digest, graphData: () => assert.fail('no second import') });
  assert.deepEqual([started.ok, started.failure.reason], [false, 'import_running']);
  run.release();

  // A controller killed part way left its record behind: its process is gone, so the way back is open again.
  writeFileSync(runRecord(paths), JSON.stringify({ pid: 2 ** 22 + 12345, command: 'node controller.js', startedAt: 'Fri Nov 20 08:00:00 2026', kind: 'import' }));
  const again = await runTrayAction('recover-preview', context, options);
  assert.equal(again.recoveryPlan.kind, 'import_back');
});

test('the run is recorded while it imports and cleared once it ends, done or failed; a failed one can be tried again', async (t) => {
  const { paths, before } = await marked(t, 'native');
  writeFileSync(join(paths.dataDir, 'graph-runtime.json'), '{}');
  const { context, options } = tray(paths);
  const { digest } = await planUnfinishedImport({ paths, mode: 'native' });
  const seen = [];
  const failed = await runTrayAction('recover-start', context, { ...options, recoveryDigest: digest, graphData: async () => {
    seen.push(existsSync(runRecord(paths)));
    throw new Error('导入没有成功：the store is in use / Graph import failed');
  } });
  assert.deepEqual([failed.ok, failed.failure.code, failed.failure.attemptKind], [false, 'graph_import_unfinished', 'import']);
  assert.equal(existsSync(runRecord(paths)), false, 'a failed run clears its record');
  const retry = await runTrayAction('recover-preview', context, options);
  assert.deepEqual([retry.recoveryPlan.kind, retry.recoveryPlan.from, retry.recoveryPlan.digest], ['import_back', before, digest], 'the same way back is offered again');

  const done = await runTrayAction('recover-start', context, { ...options, recoveryDigest: digest, graphData: async () => {
    seen.push(existsSync(runRecord(paths)));
    clearUnfinishedImport(paths, 'native');
    return { status: 'imported' };
  } });
  assert.equal(done.ok, true);
  assert.deepEqual(seen, [true, true], 'recorded while it runs');
  assert.equal(existsSync(runRecord(paths)), false, 'a finished run clears its record');
});

test('giving up that stops part way says it was not given up and what already moved, and where', async (t) => {
  const { paths } = await marked(t, 'native', { graphStates: { personal: 'writing', workspace: 'writing' } });
  const { context, options } = tray(paths);
  const { digest } = await planUnfinishedImport({ paths, mode: 'native', abandon: true });
  const adapter = { instances: ['personal', 'workspace'], unfinishedImport: () => readUnfinishedImport(paths, 'native'), stop: async () => {},
    setAside: async graph => {
      if (graph === 'workspace') throw new Error('EBUSY: resource busy or locked');
      return { where: 'C:\\FULI\\native-runtime\\recovered\\2026-11-20T08-00-00-000Z\\personal', moveBack: [] };
    },
    clearUnfinishedImport: () => assert.fail('the record stays') };
  const result = await runTrayAction('abandon-import-start', context, { ...options, recoveryDigest: digest,
    graphData: () => abandonUnfinishedImport({ adapter, targetMode: 'native', paths }) });
  assert.deepEqual([result.ok, result.failure.code, result.failure.attemptKind], [false, 'graph_import_unfinished', 'abandon']);
  const [zh, en] = result.failure.attemptError.split(' / ');
  assert.match(zh, /没有放弃那次导入：图谱 workspace 没能挪开（EBUSY.+图谱 personal 已经清空：它写了一半的库挪到了 C:\\FULI\\native-runtime\\recovered\\2026-11-20T08-00-00-000Z\\personal/);
  assert.match(en, /The personal graph is empty now: its half-written database moved to C:\\FULI/);
});

test('on macOS native mode the lifecycle lock\'s recovery is the way, whatever marker was left', async (t) => {
  const { paths } = await marked(t, 'native');
  const { context, options } = tray(paths);
  const preview = await runTrayAction('recover-preview', context, { ...options, platform: 'darwin',
    recovery: { plan: async () => ({ kind: 'nothing', steps: [] }), apply: async () => assert.fail('nothing to apply') } });
  assert.equal(preview.recoveryPlan.kind, 'nothing', 'the lock\'s recovery, not the marker\'s import_back');
  const container = await marked(t, 'container');
  const fromContainer = await runTrayAction('recover-preview', tray(container.paths).context, { ...options, platform: 'darwin' });
  assert.equal(fromContainer.recoveryPlan.kind, 'import_back', 'containers have no lock on macOS either');
});
