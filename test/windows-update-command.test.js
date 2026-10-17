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
