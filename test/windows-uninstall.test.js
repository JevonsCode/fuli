import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { installedWindowsFixture } from './fixtures/windows-installation.js';
import { runWindowsUninstallCommand } from '../src/desktop/windows-uninstall-command.js';
import { planWindowsUninstall, uninstallWindowsInstallation } from '../src/desktop/windows-uninstall.js';
import { updateWindowsInstallation } from '../src/desktop/windows-update.js';

function installed(t) {
  const f = installedWindowsFixture(t);
  const removedLater = [];
  return { ...f, removedLater, uninstall: { env: f.env },
    deps: { ...f.deps, runningFrom: join(f.root, 'elsewhere', 'node.exe'),
      removeAfterExit: (directories, containers) => removedLater.push({ directories, containers }) } };
}

test('uninstall stops services, disconnects clients, removes every version and shortcut, and keeps data', async t => {
  const f = installed(t);
  const next = await updateWindowsInstallation(f.options, f.deps);
  f.calls.length = 0;
  const plan = planWindowsUninstall({ ...f.uninstall, readShortcut: f.deps.readShortcut });
  assert.equal(plan.slots.length, 2);
  const result = await uninstallWindowsInstallation(f.uninstall, f.deps);
  assert.equal(result.status, 'removed');
  assert.deepEqual(f.calls.map(({ root, args }) => [root, args[0]]),
    [[next.packageRoot, 'stop'], [next.packageRoot, 'uninstall']]);
  assert.deepEqual(f.calls[1].args, ['uninstall', '--yes', '--data-dir', f.current.dataDir]);
  assert.equal(existsSync(f.current.installRoot), false);
  for (const path of f.current.shortcuts) assert.equal(existsSync(path), false);
  assert.equal(readFileSync(join(f.current.dataDir, 'sentinel'), 'utf8'), 'existing user data');
  assert.deepEqual(result.keptShortcuts, []);
  assert.deepEqual(f.removedLater, []);
});

test('the slot of the running uninstaller is removed after it exits', async t => {
  const f = installed(t);
  const result = await uninstallWindowsInstallation(f.uninstall, { ...f.deps,
    runningFrom: join(f.current.packageRoot, 'runtime', 'node', 'node.exe') });
  assert.equal(result.status, 'removing_after_exit');
  assert.equal(existsSync(join(f.current.installRoot, 'installation.json')), false);
  assert.deepEqual(f.removedLater, [{ directories: [f.current.packageRoot],
    containers: [join(f.current.installRoot, 'versions'), f.current.installRoot] }]);
});

test('a failed stop or client disconnect removes nothing', async t => {
  for (const failing of ['stop', 'uninstall']) {
    const f = installed(t);
    await assert.rejects(uninstallWindowsInstallation(f.uninstall, { ...f.deps,
      runCli: async (_root, args) => ({ code: args[0] === failing ? 1 : 0 }) }), failing === 'stop' ? /nothing was removed/ : /application was kept/);
    assert.ok(existsSync(join(f.current.installRoot, 'installation.json')));
    assert.ok(existsSync(f.current.packageRoot));
    for (const path of f.current.shortcuts) assert.ok(existsSync(path));
  }
});

test('shortcuts that launch something else and unrelated files are left in place', async t => {
  const f = installed(t);
  writeFileSync(f.current.shortcuts[0], join(f.root, 'other', 'Fuli.exe'));
  mkdirSync(join(f.current.installRoot, 'versions', 'notes'));
  writeFileSync(join(f.current.installRoot, 'readme.txt'), 'mine');
  const result = await uninstallWindowsInstallation(f.uninstall, f.deps);
  assert.deepEqual(result.keptShortcuts, [f.current.shortcuts[0]]);
  assert.equal(readFileSync(f.current.shortcuts[0], 'utf8'), join(f.root, 'other', 'Fuli.exe'));
  assert.equal(existsSync(f.current.shortcuts[1]), false);
  assert.deepEqual(readdirSync(join(f.current.installRoot, 'versions')), ['notes']);
  assert.equal(result.leftover, f.current.installRoot);
});

test('a stale confirmation or busy tray prevents every action', async t => {
  const f = installed(t); let locked = 0;
  const deps = { ...f.deps, acquireLock: async () => { locked++; throw Error('tray busy'); } };
  await assert.rejects(uninstallWindowsInstallation({ ...f.uninstall, expectedInstallationId: 'stale' }, deps), /confirmation/);
  assert.equal(locked, 0);
  await assert.rejects(uninstallWindowsInstallation(f.uninstall, deps), /tray busy/);
  assert.equal(f.calls.length, 0);
  assert.ok(existsSync(join(f.current.installRoot, 'installation.json')));
});

test('the uninstall command previews, asks, and binds the reviewed installation', async () => {
  const plan = { installRoot: '/install', slots: ['/install/versions/a'], current: { installationId: 'id', applicationVersion: '1.0.0', dataDir: '/data' } };
  const calls = []; const lines = [];
  const deps = { platform: 'win32', arch: 'x64', write: line => lines.push(line), plan: () => plan, confirm: async () => false,
    uninstall: async options => { calls.push(options); return { status: 'removed', dataDir: '/data', keptShortcuts: [], leftover: null }; } };
  assert.equal((await runWindowsUninstallCommand(['--preview'], deps)).status, 'preview');
  assert.equal((await runWindowsUninstallCommand([], deps)).status, 'cancelled');
  assert.equal(calls.length, 0);
  assert.match(lines[0], /\/data/);
  await runWindowsUninstallCommand(['--yes', '--install-root', '/custom'], deps);
  assert.equal(calls[0].installRoot, '/custom');
  assert.equal(calls[0].expectedInstallationId, 'id');
  await assert.rejects(runWindowsUninstallCommand(['--data-dir', '/x'], deps), /option/);
  await assert.rejects(runWindowsUninstallCommand([], { ...deps, platform: 'darwin' }), /Windows/);
});

test('the deferred removal deletes the running slot without following a junction', { skip: process.platform !== 'win32' && 'Windows only' }, async t => {
  const f = installedWindowsFixture(t);
  const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'keep');
  symlinkSync(outside, join(f.current.packageRoot, 'link'), 'junction');
  const result = await uninstallWindowsInstallation({ env: f.env }, { ...f.deps,
    runningFrom: join(f.current.packageRoot, 'runtime', 'node', 'node.exe') });
  assert.equal(result.status, 'removing_after_exit');
  for (let attempt = 0; attempt < 30 && existsSync(f.current.installRoot); attempt++) await delay(1000);
  assert.equal(existsSync(f.current.installRoot), false);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('uninstall returns only after the deferred removal has been launched', async t => {
  const f = installed(t); let launched = false;
  const result = await uninstallWindowsInstallation(f.uninstall, { ...f.deps,
    runningFrom: join(f.current.packageRoot, 'runtime', 'node', 'node.exe'),
    removeAfterExit: async () => { await delay(50); launched = true; } });
  assert.equal(result.status, 'removing_after_exit');
  assert.equal(launched, true);
});

test('an install root given in different case is the same installation on Windows', { skip: process.platform !== 'win32' && 'Windows paths only' }, async t => {
  const f = installed(t);
  const plan = planWindowsUninstall({ ...f.uninstall, installRoot: f.current.installRoot.toUpperCase(), readShortcut: f.deps.readShortcut });
  assert.equal(plan.current.installationId, f.current.installationId);
});

test('uninstall closes the desktop client first and removes its Windows entries without reopening it', async t => {
  const f = installed(t);
  f.client.state = 'exited';
  const result = await uninstallWindowsInstallation(f.uninstall, f.deps);
  assert.deepEqual(f.client.events, [['close', f.current.dataDir], ['unregister', f.current.installRoot]]);
  assert.equal(result.registrations, 'removed');
});
