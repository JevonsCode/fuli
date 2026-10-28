import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { installedWindowsFixture } from './fixtures/windows-installation.js';
import { readWindowsInstallation } from '../src/desktop/windows-installation-context.js';
import { runWindowsRollbackCommand } from '../src/desktop/windows-rollback-command.js';
import { planWindowsRollback, rollbackWindowsInstallation } from '../src/desktop/windows-rollback.js';
import { updateWindowsInstallation } from '../src/desktop/windows-update.js';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../src/native-runtime/windows-assets.js';

async function updated(t) {
  const f = installedWindowsFixture(t);
  const next = await updateWindowsInstallation(f.options, f.deps);
  f.calls.length = 0;
  return { ...f, next, rollback: { env: f.env } };
}
const descriptor = (root, version) => JSON.stringify({ version: 1, status: 'ready', mode: 'native', providerVersion: version + '+native.7',
  providerFingerprint: 'a'.repeat(64), ...resolveWindowsNativeBundle(readWindowsNativeBundle(root)) });

test('rollback switches the record and shortcuts back to the kept version without touching data', async t => {
  const f = await updated(t);
  const plan = planWindowsRollback({ ...f.rollback, readShortcut: f.deps.readShortcut });
  assert.equal(plan.applicationVersion, '0.12.4');
  assert.equal(plan.target.packageRoot, f.current.packageRoot);
  const result = await rollbackWindowsInstallation(f.rollback, f.deps);
  assert.equal(result.applicationVersion, '0.12.4');
  assert.equal(result.previousInstallation, undefined);
  assert.equal(readWindowsInstallation(f.current.packageRoot).applicationVersion, '0.12.4');
  for (const path of f.current.shortcuts) assert.equal(readFileSync(path, 'utf8'), join(f.current.packageRoot, 'Fuli.exe'));
  assert.deepEqual(f.calls.map(({ root, args }) => [root === f.next.packageRoot ? 'new' : 'old', args[0]]),
    [['new', 'stop'], ['old', 'start'], ['old', 'status'], ['old', 'setup'], ['old', 'status']]);
  assert.equal(readFileSync(join(f.current.dataDir, 'sentinel'), 'utf8'), 'existing user data');
  assert.ok(existsSync(f.next.packageRoot), 'the newer version stays installed until uninstall');
  await assert.rejects(rollbackWindowsInstallation(f.rollback, f.deps), /nothing to roll back/);
});

test('rollback clears the newer runtime descriptor so the older version records its own', async t => {
  const f = await updated(t);
  const path = join(f.current.dataDir, 'native-runtime', 'manifest.json');
  mkdirSync(join(f.current.dataDir, 'native-runtime'), { recursive: true });
  writeFileSync(path, descriptor(f.next.packageRoot, '0.12.5'));
  await rollbackWindowsInstallation(f.rollback, { ...f.deps, runCli: async (root, args) => {
    if (args[0] === 'start') { assert.equal(existsSync(path), false); writeFileSync(path, descriptor(root, '0.12.4')); }
    return { code: 0 };
  } });
  assert.equal(readFileSync(path, 'utf8'), descriptor(f.current.packageRoot, '0.12.4'));
});

test('a failed rollback start stops the older version and restores the newer one with its descriptor', async t => {
  const f = await updated(t);
  const path = join(f.current.dataDir, 'native-runtime', 'manifest.json');
  mkdirSync(join(f.current.dataDir, 'native-runtime'), { recursive: true });
  const newer = descriptor(f.next.packageRoot, '0.12.5');
  writeFileSync(path, newer);
  const commands = [];
  await assert.rejects(rollbackWindowsInstallation(f.rollback, { ...f.deps, runCli: async (root, args) => {
    const who = root === f.next.packageRoot ? 'new' : 'old';
    commands.push(who + ':' + args[0]);
    if (who === 'new' && args[0] === 'start') assert.equal(readFileSync(path, 'utf8'), newer);
    return { code: who === 'old' && args[0] === 'start' ? 1 : 0 };
  } }), /0\.12\.5 was restored/);
  assert.deepEqual(commands, ['new:stop', 'old:start', 'old:stop', 'new:start', 'new:status']);
  assert.equal(readWindowsInstallation(f.next.packageRoot).applicationVersion, '0.12.5');
  for (const path of f.current.shortcuts) assert.equal(readFileSync(path, 'utf8'), join(f.next.packageRoot, 'Fuli.exe'));
});

test('a modified or missing kept version is refused before any service action', async t => {
  const f = await updated(t);
  writeFileSync(join(f.current.packageRoot, 'src', 'cli.js'), 'tampered');
  assert.throws(() => planWindowsRollback({ ...f.rollback, readShortcut: f.deps.readShortcut }), /missing or changed/);
  await assert.rejects(rollbackWindowsInstallation(f.rollback, f.deps), /missing or changed/);
  assert.equal(f.calls.length, 0);
  assert.equal(readWindowsInstallation(f.next.packageRoot).applicationVersion, '0.12.5');
});

test('a record pointing its previous version outside the installation is refused', async t => {
  const f = await updated(t);
  const recordPath = join(f.next.installRoot, 'installation.json');
  const record = JSON.parse(readFileSync(recordPath));
  record.previousInstallation.packageRoot = join(f.root, 'elsewhere');
  writeFileSync(recordPath, JSON.stringify(record));
  await assert.rejects(rollbackWindowsInstallation(f.rollback, f.deps), /missing or changed/);
  assert.equal(f.calls.length, 0);
});

test('a stale confirmation and a busy tray prevent rollback service actions', async t => {
  const f = await updated(t); let locked = 0;
  const deps = { ...f.deps, acquireLock: async () => { locked++; throw Error('tray busy'); } };
  await assert.rejects(rollbackWindowsInstallation({ ...f.rollback, expectedInstallationId: 'stale' }, deps), /confirmation/);
  assert.equal(locked, 0);
  await assert.rejects(rollbackWindowsInstallation(f.rollback, deps), /tray busy/);
  assert.equal(f.calls.length, 0);
});

test('the rollback command previews, asks, and binds the reviewed installation', async () => {
  const plan = { installRoot: '/install', applicationVersion: '1.0.0', current: { installationId: 'id', applicationVersion: '1.1.0', dataDir: '/data' } };
  const calls = []; const lines = [];
  const deps = { platform: 'win32', arch: 'x64', write: line => lines.push(line), plan: () => plan, confirm: async () => false,
    rollback: async options => { calls.push(options); return { applicationVersion: '1.0.0', clients: 'reconnected' }; } };
  assert.equal((await runWindowsRollbackCommand(['--preview'], deps)).status, 'preview');
  assert.match(lines[0], /1\.1\.0 → 1\.0\.0/);
  assert.match(lines[0], /not rolled back/);
  assert.equal((await runWindowsRollbackCommand([], deps)).status, 'cancelled');
  assert.equal(calls.length, 0);
  await runWindowsRollbackCommand(['--yes'], deps);
  assert.equal(calls[0].expectedInstallationId, 'id');
  await assert.rejects(runWindowsRollbackCommand(['--yes', '--yes'], deps), /Duplicate rollback option/);
});

test('rollback closes an open desktop client and reopens the kept version\'s app afterwards', async t => {
  const f = await updated(t);
  f.client.events.length = 0;
  f.client.state = 'exited';
  const result = await rollbackWindowsInstallation(f.rollback, f.deps);
  assert.deepEqual(f.client.events, [['close', f.current.dataDir], ['followSwitch', f.current.installRoot, f.current.packageRoot],
    ['reopen', f.current.installRoot]]);
  assert.equal(result.desktopClient, 'reopened');
});
