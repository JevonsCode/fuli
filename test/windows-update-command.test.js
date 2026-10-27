import test from 'node:test';
import assert from 'node:assert/strict';
import { runWindowsUpdateCommand } from '../src/desktop/windows-update-command.js';

const plan = { installRoot: '/install', current: { installationId: 'old', applicationVersion: '1.0.0', dataDir: '/data' }, applicationVersion: '1.1.0', inventorySha256: 'hash' };
function dependencies() {
  const calls = [];
  return { calls, platform: 'win32', arch: 'x64', source: '/candidate', write() {},
    plan: () => plan, confirm: async () => false,
    update: async options => { calls.push(options); return { applicationVersion: '1.1.0', clients: 'reconnected' }; } };
}
test('preview and cancelled confirmation never invoke an update', async () => {
  const deps = dependencies();
  assert.equal((await runWindowsUpdateCommand(['--preview'], deps)).status, 'preview');
  assert.equal((await runWindowsUpdateCommand([], deps)).status, 'cancelled');
  assert.deepEqual(deps.calls, []);
});
test('explicit update binds the reviewed inventory and existing installation', async () => {
  const deps = dependencies();
  await runWindowsUpdateCommand(['--yes', '--install-root', '/custom'], deps);
  assert.equal(deps.calls[0].installRoot, '/custom');
  assert.equal(deps.calls[0].expectedInstallationId, 'old');
  assert.equal(deps.calls[0].expectedInventorySha256, 'hash');
});
test('unsupported platform, unknown, duplicate and missing options fail before planning', async () => {
  const deps = dependencies(); deps.plan = () => assert.fail('must not plan');
  for (const args of [['--other'], ['--install-root'], ['--yes', '--yes'], ['--data-dir', '/other']]) {
    await assert.rejects(runWindowsUpdateCommand(args, deps), /option/i);
  }
  await assert.rejects(runWindowsUpdateCommand([], { ...deps, platform: 'darwin' }), /Windows/);
});
test('the one-click update reads the outcome from --result-file and passes the processes the person picked', async () => {
  const deps = dependencies(); const results = [];
  deps.writeResult = (path, value) => results.push([path, value]);
  deps.update = async (_options, { stopping }) => { deps.calls.push(stopping); return { applicationVersion: '1.1.0', packageRoot: 'C:\\new', clients: 'reconnected' }; };
  await runWindowsUpdateCommand(['--yes', '--result-file', '/out/result.json', '--stop-pid', '40:133,41:7'], deps);
  assert.deepEqual(deps.calls[0].stopPids, ['40:133', '41:7']);
  assert.equal(deps.calls[0].confirmStop, undefined, 'a --yes run never asks');
  assert.deepEqual(results, [['/out/result.json', { status: 'updated', applicationVersion: '1.1.0', packageRoot: 'C:\\new', clients: 'reconnected' }]]);

  const blockers = [{ role: 'console', pid: 40, createdFileTime: '133', executable: 'node.exe' }];
  deps.update = async () => { throw Object.assign(new Error('Another Fuli program runs on this data folder, so nothing was switched: console PID 40\nmore'), { blockers }); };
  await assert.rejects(runWindowsUpdateCommand(['--yes', '--result-file', '/out/result.json'], deps), /Another Fuli program/);
  assert.deepEqual(results[1][1], { status: 'failed',
    error: 'Another Fuli program runs on this data folder, so nothing was switched: console PID 40', blockers });
  await assert.rejects(runWindowsUpdateCommand(['--yes', '--stop-pid', '40'], deps), /option/);
  await assert.rejects(runWindowsUpdateCommand(['--yes', '--result-file', 'relative.json'], deps), /absolute/);
});
test('at the terminal the person is asked before a process FULI did not start is stopped', async () => {
  const deps = dependencies(); const questions = [];
  deps.confirm = async (question) => { questions.push(question); return true; };
  deps.update = async (_options, { stopping }) => ({ applicationVersion: '1.1.0', clients: 'reconnected',
    stopped: await stopping.confirmStop([{ role: 'console', pid: 40, executable: 'node.exe' }]) });
  const result = await runWindowsUpdateCommand([], deps);
  assert.equal(result.stopped, true);
  assert.equal(questions.length, 2);
  assert.match(questions[1], /Stop these Fuli processes/);
});
