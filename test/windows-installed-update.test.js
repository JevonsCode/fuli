import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { installedWindowsFixture as fixture } from './fixtures/windows-installation.js';
import { installationSha256, readWindowsInstallation } from '../src/desktop/windows-installation-context.js';
import { planWindowsUpdate, updateWindowsInstallation } from '../src/desktop/windows-update.js';

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
  assert.equal(readFileSync(join(next.installRoot, 'FuliNode.exe'), 'utf8'), 'node launcher 0.12.5');
});

test('an update from a version without the client launcher places it; a restored switch keeps the newer one', async t => {
  const f = fixture(t);
  rmSync(join(f.current.installRoot, 'FuliNode.exe'));
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, runCli: async (root, args) =>
    ({ code: args[0] === 'start' && root !== f.current.packageRoot ? 1 : 0 }) }), /restored/);
  // Any version's launcher runs the version installation.json names, so the restored record needs no other launcher.
  assert.equal(readFileSync(join(f.current.installRoot, 'FuliNode.exe'), 'utf8'), 'node launcher 0.12.5');
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

// A candidate with another version number, re-signed into its inventory.
function candidateVersion(f, version) {
  writeFileSync(join(f.source, 'package.json'), JSON.stringify({ name: 'fuli-context', version }));
  const inventory = JSON.parse(readFileSync(join(f.source, 'tray-files.sha256.json')));
  for (const entry of inventory) entry[1] = installationSha256(readFileSync(join(f.source, entry[0])));
  writeFileSync(join(f.source, 'tray-files.sha256.json'), JSON.stringify(inventory));
}

test('a lower version needs the explicit downgrade switch; the same version is never an update', async t => {
  const f = fixture(t);
  candidateVersion(f, '0.12.4-beta.1');
  assert.throws(() => planWindowsUpdate({ ...f.options, readShortcut: f.deps.readShortcut }), /--allow-downgrade/);
  const plan = planWindowsUpdate({ ...f.options, allowDowngrade: true, readShortcut: f.deps.readShortcut });
  assert.equal(plan.downgrade, true);
  candidateVersion(f, '0.12.4');
  assert.throws(() => planWindowsUpdate({ ...f.options, allowDowngrade: true, readShortcut: f.deps.readShortcut }), /already installed/);
});

test('a confirmed downgrade lets the new version replace the recorded Provider when it starts and reconnects', async t => {
  const f = fixture(t);
  candidateVersion(f, '0.12.4-beta.1');
  const next = await updateWindowsInstallation({ ...f.options, allowDowngrade: true }, f.deps);
  assert.equal(readWindowsInstallation(next.packageRoot).applicationVersion, '0.12.4-beta.1');
  const start = f.calls.find(call => call.args[0] === 'start' && call.root === next.packageRoot);
  const setup = f.calls.find(call => call.args[0] === 'setup');
  assert.ok(start.args.includes('--allow-provider-downgrade'));
  assert.ok(setup.args.includes('--allow-provider-downgrade'));
  assert.equal(readFileSync(join(f.current.dataDir, 'sentinel'), 'utf8'), 'existing user data');
});

test('an ordinary upgrade never passes the downgrade switch', async t => {
  const f = fixture(t);
  await updateWindowsInstallation(f.options, f.deps);
  assert.ok(f.calls.every(call => !call.args.includes('--allow-provider-downgrade')));
});

test('an open desktop client is closed before the switch, its launch entry follows the new version and it comes back', async t => {
  const f = fixture(t);
  f.client.state = 'exited';
  const next = await updateWindowsInstallation(f.options, f.deps);
  assert.deepEqual(f.client.events, [['close', f.current.dataDir], ['followSwitch', f.current.installRoot, next.packageRoot],
    ['reopen', f.current.installRoot]]);
  assert.equal(next.desktopClient, 'reopened');
  assert.equal(next.loginLaunch, 'unchanged');
});

test('a desktop client that does not close stops the update before the lock or any service action', async t => {
  const f = fixture(t);
  let locked = 0;
  const desktopClient = { ...f.deps.desktopClient, close: async () => { throw new Error('The FULI desktop client did not close; nothing was changed.'); } };
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, desktopClient,
    acquireLock: async () => { locked++; return { assertHeld() {}, async release() {} }; } }), /did not close/);
  assert.equal(locked, 0);
  assert.deepEqual(f.calls, []);
  assert.equal(readWindowsInstallation(f.current.packageRoot).applicationVersion, '0.12.4');
});

test('an automatic start under way is waited for before the stop, and no start begins until the record names the new version', async t => {
  const f = fixture(t); const events = []; let held = false, autostart = 'starting';
  const next = await updateWindowsInstallation(f.options, { ...f.deps,
    holdStarts: dataDir => {
      assert.equal(dataDir, f.current.dataDir);
      // The start under way finished and recorded its console while this waited.
      autostart = 'recorded'; held = true; events.push('hold');
      return () => { held = false; events.push('release'); };
    },
    runCli: async (root, args) => {
      const version = readWindowsInstallation(root).applicationVersion;
      events.push(`${args[0]} ${version}`);
      if (args[0] === 'stop' && autostart === 'recorded') { autostart = null; events.push('stopped the automatic start\'s console'); }
      if (args[0] === 'start') {
        assert.equal(held, false, 'the new version\'s own start takes the start lock');
        assert.equal(JSON.parse(readFileSync(join(f.current.installRoot, 'installation.json'))).applicationVersion, '0.12.5');
      }
      return { code: 0 };
    } });
  assert.equal(readWindowsInstallation(next.packageRoot).applicationVersion, '0.12.5');
  assert.deepEqual(events.slice(0, 5), ['hold', 'stop 0.12.4', 'stopped the automatic start\'s console', 'release', 'start 0.12.5']);
});

test('a start that never lets go of the start lock ends the update before anything is stopped or switched', async t => {
  const f = fixture(t); f.client.state = 'exited';
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps,
    holdStarts: () => { throw new Error('Another FULI process holds this lock'); } }),
  /^Error: Another start of FULI did not finish, so FULI was not stopped for the update; nothing was changed\./);
  assert.deepEqual(f.calls, []);
  assert.equal(readWindowsInstallation(f.current.packageRoot).applicationVersion, '0.12.4');
  assert.equal(JSON.parse(readFileSync(join(f.current.installRoot, 'installation.json'))).applicationVersion, '0.12.4');
  assert.equal(readdirSync(join(f.current.installRoot, 'versions')).length, 1);
  assert.deepEqual(f.client.events.at(-1), ['reopen', f.current.installRoot]);
});

// The new version upgrades a store the stopped one used, then its first start fails.
function upgradingStart(f, { secondStartWorks }) {
  const settingsPath = join(f.current.dataDir, 'runtime-settings.json');
  writeFileSync(settingsPath, JSON.stringify({ version: 1, graphRuntimeMode: 'native' }));
  const commands = []; let newStarts = 0;
  const runCli = async (root, args) => {
    const version = readWindowsInstallation(root).applicationVersion;
    commands.push(`${args[0]} ${version}`);
    if (args[0] === 'start' && version === '0.12.5') {
      newStarts += 1;
      writeFileSync(settingsPath, JSON.stringify({ version: 2, graphRuntimeMode: 'native' }));
      return { code: newStarts === 1 || !secondStartWorks ? 1 : 0 };
    }
    return { code: 0 };
  };
  return { commands, runCli };
}

test('on data the new version already upgraded the previous one never comes back; the new one is started once more', async t => {
  const f = fixture(t); const { commands, runCli } = upgradingStart(f, { secondStartWorks: true });
  const next = await updateWindowsInstallation(f.options, { ...f.deps, runCli });
  assert.equal(readWindowsInstallation(next.packageRoot).applicationVersion, '0.12.5');
  assert.deepEqual(commands.slice(0, 5), ['stop 0.12.4', 'start 0.12.5', 'stop 0.12.5', 'start 0.12.5', 'status 0.12.5']);
  assert.equal(commands.includes('start 0.12.4'), false);
});

test('a new version that does not start on upgraded data stays selected, and the failure names both starts', async t => {
  const f = fixture(t); const { commands, runCli } = upgradingStart(f, { secondStartWorks: false });
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, runCli }), error => error.code === 'kept_new_version'
    && error.message === 'v0.12.5 did not start (Fuli 0.12.5 did not start.); the previous version cannot run on this data '
      + '(stores the new version changed: runtime-settings.json 1 → 2), so the new one was kept; started again, it did not run (Fuli 0.12.5 did not start.).');
  assert.equal(JSON.parse(readFileSync(join(f.current.installRoot, 'installation.json'))).applicationVersion, '0.12.5');
  assert.equal(commands.includes('start 0.12.4'), false);
});

test('a new version that does not stop after a failed start keeps the first error and says it stays', async t => {
  const f = fixture(t); let oldStarts = 0;
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, runCli: async (root, args) => {
    if (root === f.current.packageRoot) { if (args[0] === 'start') oldStarts++; return { code: 0 }; }
    return { code: 1 };
  } }), error => error.code === 'kept_new_version' && error.message === 'v0.12.5 did not start (Fuli 0.12.5 did not start.); '
    + 'it did not stop either, so it was left installed and nothing was switched back '
    + '(Fuli 0.12.5 could not be stopped; automatic rollback was not attempted.).');
  assert.equal(oldStarts, 0);
  assert.equal(JSON.parse(readFileSync(join(f.current.installRoot, 'installation.json'))).applicationVersion, '0.12.5');
});

test('a start lock that cannot be had after a failed start keeps the new version selected and stops nothing', async t => {
  const f = fixture(t); const commands = []; let holds = 0;
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps,
    holdStarts: () => { if (++holds === 2) throw new Error('Another FULI process holds this lock'); return () => {}; },
    runCli: async (root, args) => { commands.push(`${args[0]} ${readWindowsInstallation(root).applicationVersion}`);
      return { code: args[0] === 'start' && root !== f.current.packageRoot ? 1 : 0 }; } }),
  error => error.code === 'kept_new_version' && /\); another start of FULI did not finish, so it was left installed/.test(error.message));
  assert.deepEqual(commands, ['stop 0.12.4', 'start 0.12.5']);
});

test('a console the failed start left running keeps the new version selected; the data is not judged and nothing is restored', async t => {
  const f = fixture(t); const commands = [];
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps,
    consolesLeft: async dataDir => { assert.equal(dataDir, f.current.dataDir); return 'a FULI console still runs (process 4242)'; },
    runCli: async (root, args) => { commands.push(`${args[0]} ${readWindowsInstallation(root).applicationVersion}`);
      return { code: args[0] === 'start' && root !== f.current.packageRoot ? 1 : 0 }; } }),
  error => error.code === 'kept_new_version'
    && error.message.endsWith('; a FULI console still runs (process 4242), so it was left installed and nothing was switched back.'));
  assert.deepEqual(commands, ['stop 0.12.4', 'start 0.12.5', 'stop 0.12.5']);
  assert.equal(JSON.parse(readFileSync(join(f.current.installRoot, 'installation.json'))).applicationVersion, '0.12.5');
});

test('no start can begin while the recovery reads the data or restores the record; the update releases the lock for its own start', async t => {
  const f = fixture(t); let held = false; const seen = [];
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps,
    holdStarts: () => { held = true; return () => { held = false; }; },
    consolesLeft: async () => { seen.push(['consolesLeft', held]); return null; },
    runCli: async (root, args) => {
      const version = readWindowsInstallation(root).applicationVersion;
      seen.push([`${args[0]} ${version}`, held]);
      return { code: args[0] === 'start' && version === '0.12.5' ? 1 : 0 };
    } }), /restored/);
  assert.deepEqual(seen.slice(0, 6), [['stop 0.12.4', true], ['start 0.12.5', false], ['stop 0.12.5', true], ['consolesLeft', true],
    ['start 0.12.4', false], ['status 0.12.4', false]]);
  assert.equal(held, false);
});
