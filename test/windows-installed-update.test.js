import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { windowsInstallationFixture } from './fixtures/windows-installation.js';
import { installWindowsForCurrentUser } from '../src/desktop/windows-installation.js';
import { installationSha256, readWindowsInstallation } from '../src/desktop/windows-installation-context.js';
import { planWindowsUpdate, updateWindowsInstallation } from '../src/desktop/windows-update.js';

function fixture(t) {
  const f = windowsInstallationFixture(t);
  const current = installWindowsForCurrentUser(f.options, f.deps);
  mkdirSync(current.dataDir, { recursive: true });
  writeFileSync(join(current.dataDir, 'sentinel'), 'existing user data');
  writeFileSync(join(current.dataDir, 'runtime-settings.json'), JSON.stringify({ graphRuntimeMode: 'native' }));
  const source = join(f.root, 'upgrade');
  cpSync(f.source, source, { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'fuli-context', version: '0.12.5' }));
  const inventory = JSON.parse(readFileSync(join(source, 'tray-files.sha256.json')));
  for (const entry of inventory) entry[1] = installationSha256(readFileSync(join(source, entry[0])));
  writeFileSync(join(source, 'tray-files.sha256.json'), JSON.stringify(inventory));
  const calls = [];
  return { ...f, current, source, calls, options: { source, env: f.env },
    deps: { ...f.deps, acquireLock: async () => ({ assertHeld() {}, async release() {} }), runCli: async (root, args) => { calls.push({ root, args }); return { code: 0 }; } } };
}

test('update preview is read-only; successful switch preserves data and keeps the previous version', async t => {
  const f = fixture(t);
  const plan = planWindowsUpdate({ ...f.options, readShortcut: f.deps.readShortcut });
  assert.equal(plan.current.packageRoot, f.current.packageRoot);
  assert.equal(readdirSync(join(f.current.installRoot, 'versions')).length, 1);
  const next = await updateWindowsInstallation(f.options, f.deps);
  assert.equal(readWindowsInstallation(next.packageRoot).applicationVersion, '0.12.5');
  assert.equal(next.previousInstallation.packageRoot, f.current.packageRoot);
  assert.equal(readFileSync(join(f.current.dataDir, 'sentinel'), 'utf8'), 'existing user data');
  assert.equal(readdirSync(join(f.current.installRoot, 'versions')).length, 2);
  assert.equal(f.calls[0].root, f.current.packageRoot);
  assert.equal(f.calls[0].args[0], 'stop');
  for (const path of next.shortcuts) assert.equal(readFileSync(path, 'utf8'), join(next.packageRoot, 'Fuli.exe'));
});

test('failed start stops the new version before restoring the old receipt and runtime', async t => {
  const f = fixture(t); const commands = [];
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, runCli: async (root, args) => {
    commands.push(args[0]);
    assert.equal(readWindowsInstallation(root).packageRoot, root);
    return { code: args[0] === 'start' && root !== f.current.packageRoot ? 1 : 0 };
  } }), /restored/);
  assert.deepEqual(commands, ['stop', 'start', 'stop', 'start', 'status']);
  assert.equal(readWindowsInstallation(f.current.packageRoot).applicationVersion, '0.12.4');
  for (const path of f.current.shortcuts) assert.equal(readFileSync(path, 'utf8'), join(f.current.packageRoot, 'Fuli.exe'));
});

test('failed stop leaves the current installation and shortcuts unchanged', async t => {
  const f = fixture(t);
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, runCli: async () => ({ code: 1 }) }), /could not be stopped/);
  assert.equal(readWindowsInstallation(f.current.packageRoot).applicationVersion, '0.12.4');
  assert.equal(readdirSync(join(f.current.installRoot, 'versions')).length, 1);
});

test('failure to stop the new runtime must not start the previous runtime on the same data', async t => {
  const f = fixture(t); let oldStarts = 0;
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, runCli: async (root, args) => {
    if(root === f.current.packageRoot && args[0] === 'start') oldStarts++;
    return { code: root !== f.current.packageRoot ? 1 : 0 };
  } }), /could not be stopped|stop.*failed/i);
  assert.equal(oldStarts, 0);
});

test('shortcut arguments and an inconsistent installation root fail before service actions', async t => {
  const f = fixture(t);
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, readShortcut: (...args) => ({ ...f.deps.readShortcut(...args), arguments: '--foreign-data' }) }), /shortcut/i);
  assert.equal(f.calls.length, 0);
  const decoy = join(f.root, 'decoy'); mkdirSync(decoy);
  writeFileSync(join(decoy, 'installation.json'), readFileSync(join(f.current.installRoot, 'installation.json')));
  await assert.rejects(updateWindowsInstallation({ ...f.options, installRoot: decoy }, f.deps), /installation/i);
  assert.equal(f.calls.length, 0);
});

test('changed shortcuts during staging are preserved and prevent switching', async t => {
  const f = fixture(t);
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, createShortcut(path, target) {
    f.deps.createShortcut(path, target); writeFileSync(f.current.shortcuts[0], 'user replacement');
  } }), /changed|shortcut/i);
  assert.equal(readFileSync(f.current.shortcuts[0], 'utf8'), 'user replacement');
  assert.equal(f.calls.length, 0);
});

test('reconnection failure is reported without rolling back a healthy updated runtime', async t => {
  const f = fixture(t);
  const result = await updateWindowsInstallation(f.options, { ...f.deps, runCli: async (_root, args) => {
    if(args[0] === 'setup') throw Error('reconnect failed'); return { code: 0 };
  } });
  assert.equal(result.clients, 'not_reconnected');
  assert.equal(readWindowsInstallation(result.packageRoot).applicationVersion, '0.12.5');
});

test('confirmation changes and a busy tray lock prevent all service actions', async t => {
  const f = fixture(t); let locked = 0;
  const deps = { ...f.deps, acquireLock: async () => { locked++; throw Error('tray busy'); } };
  await assert.rejects(updateWindowsInstallation({ ...f.options, expectedInstallationId: 'stale' }, deps), /confirmation/);
  await assert.rejects(updateWindowsInstallation({ ...f.options, expectedInventorySha256: 'stale' }, deps), /confirmation/);
  assert.equal(locked, 0);
  await assert.rejects(updateWindowsInstallation(f.options, deps), /tray busy/);
  assert.equal(locked, 1); assert.equal(f.calls.length, 0);
  assert.equal(readdirSync(join(f.current.installRoot, 'versions')).length, 1);
});

test('the update lock is released when the old service cannot stop', async t => {
  const f = fixture(t); let released = 0;
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps,
    acquireLock: async () => ({ assertHeld() {}, async release() { released++; } }),
    runCli: async () => ({ code: 1 }) }), /could not be stopped/);
  assert.equal(released, 1);
});

test('runtime failure after reconnection is not reported as a successful update', async t => {
  const f = fixture(t); let refreshed = false;
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, runCli: async (_root, args) => {
    if (args[0] === 'setup') refreshed = true;
    return { code: refreshed && args[0] === 'status' ? 1 : 0 };
  } }), /installed.*attention/i);
  const record = JSON.parse(readFileSync(join(f.current.installRoot, 'installation.json')));
  assert.equal(record.applicationVersion, '0.12.5');
});

test('rollback restores owned runtime metadata before the old provider downgrade guard runs', async t => {
  const f = fixture(t);
  const { readWindowsNativeBundle, resolveWindowsNativeBundle } = await import('../src/native-runtime/windows-assets.js');
  const manifestPath = join(f.current.dataDir, 'native-runtime', 'manifest.json');
  const descriptor = (root, version) => ({ version: 1, status: 'ready', mode: 'native', providerVersion: version + '+native.7',
    providerFingerprint: 'a'.repeat(64), ...resolveWindowsNativeBundle(readWindowsNativeBundle(root)) });
  const before = JSON.stringify(descriptor(f.current.packageRoot, '0.12.4'));
  mkdirSync(join(f.current.dataDir, 'native-runtime'), { recursive: true }); writeFileSync(manifestPath, before);
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, runCli: async (root, args) => {
    if (args[0] === 'start' && root !== f.current.packageRoot) { writeFileSync(manifestPath, JSON.stringify(descriptor(root, '0.12.5'))); return { code: 1 }; }
    if (args[0] === 'start') assert.equal(readFileSync(manifestPath, 'utf8'), before);
    return { code: 0 };
  } }), /restored/);
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

test('unconfigured or container data cannot enter an installed native update', async t => {
  const f = fixture(t);
  for (const graphRuntimeMode of ['container', undefined]) {
    writeFileSync(join(f.current.dataDir, 'runtime-settings.json'), JSON.stringify({ graphRuntimeMode }));
    await assert.rejects(updateWindowsInstallation(f.options, f.deps), /native mode/);
  }
  assert.equal(f.calls.length, 0);
});

test('lost update ownership during new start performs no further service or rollback actions', async t => {
  const f = fixture(t); let held = true; const commands = [];
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps,
    acquireLock: async () => ({ assertHeld() { if (!held) throw Error('lock lost'); }, async release() {} }),
    runCli: async (_root, args) => { commands.push(args[0]); if (args[0] === 'start') held = false; return { code: 0 }; }
  }), /lock lost/);
  assert.deepEqual(commands, ['stop', 'start']);
  assert.equal(JSON.parse(readFileSync(join(f.current.installRoot, 'installation.json'))).applicationVersion, '0.12.5');
});

test('foreign runtime metadata prevents rollback and remains untouched', async t => {
  const f = fixture(t); const manifestPath = join(f.current.dataDir, 'native-runtime', 'manifest.json');
  let oldStarts = 0;
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, runCli: async (root, args) => {
    if (args[0] === 'start' && root !== f.current.packageRoot) {
      mkdirSync(join(f.current.dataDir, 'native-runtime'), { recursive: true });
      writeFileSync(manifestPath, '{"foreign":true}'); return { code: 1 };
    }
    if (args[0] === 'start') oldStarts++;
    return { code: 0 };
  } }), /does not belong/);
  assert.equal(oldStarts, 0);
  assert.equal(readFileSync(manifestPath, 'utf8'), '{"foreign":true}');
  assert.equal(JSON.parse(readFileSync(join(f.current.installRoot, 'installation.json'))).applicationVersion, '0.12.5');
});
