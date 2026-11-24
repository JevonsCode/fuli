import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { refuseOnFollower } from '../src/cli/follower-graph-refusal.js';
import { runGraphDataCommand } from '../src/cli/graph-data-command.js';
import { runGraphMigrateCommand } from '../src/cli/graph-migrate-command.js';
import { localRuntimeControl } from '../src/cli/local-runtime-control.js';
import { runMigrateCommand } from '../src/cli/migrate-command.js';
import { runNativeRuntimeCommand } from '../src/cli/native-runtime-command.js';
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
  await assert.rejects(runMigrateCommand(['status', '--data-dir', dir], untouched), REFUSED);
  await assert.rejects(runMigrateCommand(['apply', '--digest', 'f'.repeat(64), '--data-dir', dir], untouched), REFUSED);
  await assert.rejects(localRuntimeControl(resolveSetupPaths({ dataDir: dir, env: {} }), {}, () => {}).start(),
    { code: 'follower_graph_managed' });
});

test('recover points a follower at the way out it has, and looking at its plan or releasing a lock is not refused', async (t) => {
  const dir = dataDir(t, { follows: true });
  await assert.rejects(runNativeRuntimeCommand(['recover', '--yes', '--data-dir', dir], untouched),
    { code: 'follower_graph_managed', message: /「重新准备」.*fuli runner leave.*native-runtime\/recovered\//s });
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
