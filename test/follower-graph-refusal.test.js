import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { openRoutes } from '../src/runner/call-routes.js';
import { refuseOnFollower } from '../src/cli/follower-graph-refusal.js';
import { runGraphDataCommand } from '../src/cli/graph-data-command.js';
import { runTrayAction } from '../src/desktop/desktop-controller.js';
import { runGraphMigrateCommand } from '../src/cli/graph-migrate-command.js';
import { localRuntimeControl } from '../src/cli/local-runtime-control.js';
import { runMigrateCommand } from '../src/cli/migrate-command.js';
import { runNativeRuntimeCommand } from '../src/cli/native-runtime-command.js';
import { routesUnavailableAnswer } from '../src/runner/routed-calls.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';
import { resolveSetupPaths } from '../src/setup/paths.js';

// Nothing here starts a real process: every command is refused before it would.
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  mock.method(childProcess, name, () => { throw new Error(`a test of this file started a real process (${name})`); });
}
syncBuiltinESMExports();

// docs/runner-roles-design.md §12: on a follower, the commands that would start its own graph
// runtime as an ordinary FULI's, or write its graph, refuse before anything happens. Synthetic data only.
function dataDir(t, { follows }) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-follower-refusal-')));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  if (follows) {
    const store = new RunnerStore(path.join(dir, RUNNER_FILE));
    store.saveHost({ name: 'Host A', fingerprint: 'a'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['192.0.2.20'] });
    store.close();
  }
  return dir;
}

const untouched = {
  readSettings: () => assert.fail('nothing read'), confirm: async () => assert.fail('nothing asked'),
  plan: async () => assert.fail('nothing planned'), manage: async () => assert.fail('nothing managed'),
  setup: async () => assert.fail('nothing set up'), planRecovery: async () => assert.fail('nothing planned'),
  graph: { preview: async () => assert.fail('nothing asked of the graph') }, consoleRunning: async () => assert.fail('nothing asked'),
  interactive: true, platform: 'darwin', env: {}, write: () => {}
};
const REFUSED = { code: 'follower_graph_managed', message: /这台电脑跟随主机，本机图谱由 FULI 自己管理.*fuli runner leave/s };

test('each command that would start or write a follower\'s graph refuses there, before anything happens', async (t) => {
  const dir = dataDir(t, { follows: true });
  await assert.rejects(runGraphDataCommand('import', ['--input', dir, '--yes', '--data-dir', dir], untouched), REFUSED);
  await assert.rejects(runGraphDataCommand('export', ['--output', dir, '--data-dir', dir], untouched), REFUSED);
  await assert.rejects(runGraphDataCommand('abandon-import', ['--yes', '--data-dir', dir], untouched), REFUSED);
  for (const action of ['install', 'update', 'rollback', 'uninstall']) {
    await assert.rejects(runNativeRuntimeCommand([action, '--yes', '--data-dir', dir], untouched), REFUSED);
  }
  await assert.rejects(runGraphMigrateCommand(['--to', 'native', '--yes', '--data-dir', dir], untouched), REFUSED);
  await assert.rejects(runMigrateCommand(['reconcile-knowledge', '--data-dir', dir], untouched), REFUSED);
  await assert.rejects(localRuntimeControl(resolveSetupPaths({ dataDir: dir, env: {} }), {}, () => {}).start(),
    { code: 'follower_graph_managed' });
});

test('recover points a follower at the way out it has, and looking at its plan or releasing a lock is not refused', async (t) => {
  const dir = dataDir(t, { follows: true });
  await assert.rejects(runNativeRuntimeCommand(['recover', '--yes', '--data-dir', dir], untouched),
    { code: 'follower_graph_managed', message: /有「重新准备」就按；没有的话用 `fuli runner leave`.*native-runtime\/recovered\//s });
  const preview = await runNativeRuntimeCommand(['recover', '--preview', '--data-dir', dir],
    { ...untouched, planRecovery: async () => ({ kind: 'nothing' }) });
  assert.equal(preview.status, 'nothing');
  const unlock = await runNativeRuntimeCommand(['unlock', '--preview', '--data-dir', dir], untouched);
  assert.equal(unlock.status, 'preview');
});

test('a computer that follows no one is not refused, and nothing is made for asking', (t) => {
  const dir = dataDir(t, { follows: false });
  assert.doesNotThrow(() => refuseOnFollower(dir, 'fuli graph import'));
  assert.doesNotThrow(() => refuseOnFollower(null, 'fuli graph import'));
  assert.deepEqual(readdirSync(dir), []);
});

// Its own stores still need `fuli migrate` (a follower's console sends the data format page to the
// host), so only the graph step is left out there, and no provider is asked.
const noProvider = async () => assert.fail('no provider asked');
const noGraph = { preview: async () => assert.fail('nothing asked of the graph'),
  prune: async () => assert.fail('nothing asked of the graph') };

test('fuli migrate works on a follower\'s own stores and leaves the graph out', async (t) => {
  const dir = dataDir(t, { follows: true });
  const lines = [];
  const deps = { ...untouched, graph: noGraph, fetchImpl: noProvider, write: (line) => lines.push(line) };
  const status = await runMigrateCommand(['status', '--data-dir', dir], deps);
  assert.ok(status.report.stores.length > 0);
  assert.ok(status.report.stores.every((store) => store.store !== 'graph'));
  assert.match(lines.join('\n'), /这台电脑跟随主机，本机图谱由 FULI 自己管理，这里不包含图谱。.*graph is not included/s);
  const json = await runMigrateCommand(['status', '--json', '--data-dir', dir], { ...deps, write: (line) => lines.push(line) });
  assert.equal(JSON.parse(lines.at(-1)).graph.status, 'managed_by_fuli');
  assert.equal(json.exitCode, 0);
  const preview = await runMigrateCommand(['preview', '--data-dir', dir], deps);
  assert.ok([...preview.plan.stores, ...preview.plan.blocked, ...preview.plan.undoable].every((store) => store.label !== 'graph (personal)'));
  const apply = await runMigrateCommand(['apply', '--digest', 'f'.repeat(64), '--data-dir', dir], deps);
  assert.equal(apply.status, 'stale');
  const prune = await runMigrateCommand(['prune', '--dry-run', '--data-dir', dir], deps);
  assert.equal(prune.status, 'pruned');
  await assert.rejects(runMigrateCommand(['rollback', '--store', 'graph (personal)', '--migration', 'm1', '--data-dir', dir],
    deps), REFUSED);
});

test('fuli migrate on a computer that follows no one still asks the graph', async (t) => {
  const dir = dataDir(t, { follows: false });
  const lines = [];
  let asked = 0;
  const graph = { preview: async () => { asked += 1; return { plan: null, undoable: [] }; } };
  const status = await runMigrateCommand(['status', '--data-dir', dir], { ...untouched, write: (line) => lines.push(line) });
  assert.ok(status.report.stores.some((store) => store.label === 'graph (personal)'));
  await runMigrateCommand(['preview', '--data-dir', dir], { ...untouched, graph, write: (line) => lines.push(line) });
  assert.equal(asked, 1);
  assert.doesNotMatch(lines.join('\n'), /跟随主机/);
});

test('the command an unreadable routes store points a follower at works there', async (t) => {
  const dir = dataDir(t, { follows: true });
  const hint = JSON.stringify(routesUnavailableAnswer(Object.assign(new Error('synthetic'), { code: 'x' })));
  const [, command] = hint.match(/`(fuli migrate [a-z]+)`/);
  const result = await runMigrateCommand([command.split(' ')[2], '--data-dir', dir], { ...untouched, fetchImpl: noProvider });
  assert.equal(command, 'fuli migrate status');
  assert.equal(result.exitCode, 0);
});

test('the desktop app\'s recovery actions refuse on a follower with the words recover gives', async (t) => {
  const dir = dataDir(t, { follows: true });
  const status = async () => ({ code: 0, stdout: JSON.stringify({ status: 'stopped' }), stderr: '' });
  const recovery = { plan: async () => assert.fail('nothing planned'), apply: async () => assert.fail('nothing recovered') };
  const graphData = async () => assert.fail('nothing imported');
  for (const action of ['recover-preview', 'recover-start', 'abandon-import-preview', 'abandon-import-start',
    'keep-newer-preview', 'keep-newer-start']) {
    const reply = await runTrayAction(action, { dataDir: dir }, { runCli: status, recovery, graphData,
      recoveryDigest: '0'.repeat(16) });
    assert.equal(reply.ok, false, action);
    assert.match(reply.error, /^fuli graph runtime recover：这台电脑跟随主机.*有「重新准备」就按；没有的话用 `fuli runner leave`/s, action);
  }
});

test('a follower with an explicit local project previews graph migrations and can recover locally', async t => {
  const dir = dataDir(t, { follows: true });
  const routes = openRoutes(dir);
  routes.setLocalProject('project:sample', null);
  routes.close();
  let asked = 0;
  await runMigrateCommand(['preview', '--data-dir', dir], { ...untouched,
    graph: { preview: async () => { asked++; return { plan: null, undoable: [] }; } } });
  assert.equal(asked, 1);
  assert.doesNotThrow(() => refuseOnFollower(dir, 'fuli graph runtime recover', { recover: true }));
  await assert.rejects(runMigrateCommand(['reconcile-knowledge', '--data-dir', dir], untouched), REFUSED);
});
