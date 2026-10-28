import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { windowsDesktopClient, withWindowsClientClosed } from '../src/desktop/windows-desktop-client.js';

// The desktop client as updates, rollbacks and uninstalls see it. Every
// registry call goes to a fake reg.exe over an in-memory registry; nothing
// touches the real HKCU, a real client or a real installation.

const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function fakeReg(values = {}) {
  const calls = [];
  const reg = async (args) => {
    calls.push(args);
    const [verb, key] = args;
    const name = args[args.indexOf('/v') + 1];
    const id = args.includes('/v') ? key + '|' + name : key;
    if (verb === 'query') {
      if (!(id in values)) return { code: 1, stdout: '' };
      return { code: 0, stdout: args.includes('/v') ? `\r\n${key}\r\n    ${name}    REG_SZ    ${values[id]}\r\n\r\n` : `\r\n${key}\r\n` };
    }
    if (verb === 'add') { values[id] = args[args.indexOf('/d') + 1]; return { code: 0, stdout: '' }; }
    if (verb === 'delete') { delete values[id]; return { code: 0, stdout: '' }; }
    return { code: 1, stdout: '' };
  };
  return { reg, calls, values };
}

function installRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-desktop-client-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const install = join(root, 'Programs', 'Fuli');
  const slot = name => {
    const packageRoot = join(install, 'versions', name);
    mkdirSync(join(packageRoot, 'client'), { recursive: true });
    return packageRoot;
  };
  return { root, install, slot };
}

test('a launch-at-login entry of this installation follows the switch to the installed client', async (t) => {
  const f = installRoot(t);
  const before = f.slot('old'), after = f.slot('new');
  writeFileSync(join(after, 'client', 'FULI.exe'), '');
  const registry = fakeReg({ [RUN + '|FULI']: `"${join(before, 'Fuli.exe')}" --background` });
  assert.equal(await windowsDesktopClient.followSwitch(f.install, after, registry), 'retargeted');
  assert.equal(registry.values[RUN + '|FULI'], `"${join(after, 'Fuli.exe')}" --background`);
  assert.equal(await windowsDesktopClient.followSwitch(f.install, after, registry), 'unchanged');
});

test('switching to a version without the desktop client removes the entry: the old tray takes no arguments', async (t) => {
  const f = installRoot(t);
  const before = f.slot('new'), kept = f.slot('old');
  const registry = fakeReg({ [RUN + '|FULI']: `"${join(before, 'Fuli.exe')}" --background` });
  assert.equal(await windowsDesktopClient.followSwitch(f.install, kept, registry), 'removed');
  assert.equal(RUN + '|FULI' in registry.values, false);
});

test('no entry, or an entry that starts another FULI, is left alone; a refused write is reported, never thrown', async (t) => {
  const f = installRoot(t);
  const target = f.slot('new');
  writeFileSync(join(target, 'client', 'FULI.exe'), '');
  const empty = fakeReg();
  assert.equal(await windowsDesktopClient.followSwitch(f.install, target, empty), 'unchanged');
  assert.deepEqual(empty.calls.map(([verb]) => verb), ['query']);

  const foreign = fakeReg({ [RUN + '|FULI']: `"${join(f.root, 'elsewhere', 'Fuli.exe')}" --background` });
  assert.equal(await windowsDesktopClient.followSwitch(f.install, target, foreign), 'unchanged');
  assert.equal(foreign.values[RUN + '|FULI'], `"${join(f.root, 'elsewhere', 'Fuli.exe')}" --background`);

  const refusing = fakeReg({ [RUN + '|FULI']: `"${join(f.slot('old'), 'Fuli.exe')}" --background` });
  const reg = async (args) => args[0] === 'add' ? { code: 1, stdout: '' } : refusing.reg(args);
  assert.equal(await windowsDesktopClient.followSwitch(f.install, target, { reg }), 'failed');
});

test('uninstall removes this installation\'s entry, the client settings and its notification identity', async (t) => {
  const f = installRoot(t);
  const settings = 'HKCU\\Software\\Fuli\\DesktopClient';
  const identity = 'HKCU\\Software\\Classes\\AppUserModelId\\FULI';
  const registry = fakeReg({ [RUN + '|FULI']: `"${join(f.slot('a'), 'Fuli.exe')}" --background`, [settings]: '', [identity]: '' });
  assert.equal(await windowsDesktopClient.unregister(f.install, registry), 'removed');
  assert.deepEqual(registry.values, {});

  const foreign = fakeReg({ [RUN + '|FULI']: `"${join(f.root, 'elsewhere', 'Fuli.exe')}" --background` });
  assert.equal(await windowsDesktopClient.unregister(f.install, foreign), 'removed');
  assert.equal(RUN + '|FULI' in foreign.values, true, 'another FULI keeps its entry');
  assert.equal(foreign.calls.some(([verb]) => verb === 'delete'), false, 'absent keys are not deleted');
});

test('a client that does not close refuses the change; one that closed or was not open lets it go on', async () => {
  const asked = [];
  const exitTray = state => async (dataDir, { timeoutMs }) => { asked.push([dataDir, timeoutMs > 0]); return state; };
  await assert.rejects(windowsDesktopClient.close('D:\\data', { exitTray: exitTray('busy') }), /did not close; nothing was changed/);
  assert.equal(await windowsDesktopClient.close('D:\\data', { exitTray: exitTray('exited') }), 'exited');
  assert.equal(await windowsDesktopClient.close('D:\\data', { exitTray: exitTray('absent') }), 'absent');
  assert.deepEqual(asked, [['D:\\data', true], ['D:\\data', true], ['D:\\data', true]]);
});

test('the client reopens from the version installation.json names now', async (t) => {
  const f = installRoot(t);
  const packageRoot = f.slot('new');
  writeFileSync(join(f.install, 'installation.json'), JSON.stringify({ packageRoot }));
  const launched = [];
  windowsDesktopClient.reopen(f.install, { launch: root => launched.push(root) });
  windowsDesktopClient.reopen(join(f.root, 'missing'), { launch: root => launched.push(root) });
  assert.deepEqual(launched, [packageRoot]);
});

test('a switch closes an open client first, reopens it afterwards even on failure, and only then', async () => {
  const plan = { installRoot: 'C:\\Fuli', current: { dataDir: 'D:\\data' } };
  const fake = (state, events) => ({
    close: async dataDir => { events.push(['close', dataDir]); return state; },
    followSwitch: async (root, packageRoot) => { events.push(['follow', packageRoot]); return 'retargeted'; },
    reopen: root => events.push(['reopen', root])
  });
  const events = [];
  const result = await withWindowsClientClosed(plan, fake('exited', events), async () => {
    events.push(['change']);
    return { packageRoot: 'C:\\Fuli\\versions\\new' };
  });
  assert.deepEqual(result, { packageRoot: 'C:\\Fuli\\versions\\new', desktopClient: 'reopened', loginLaunch: 'retargeted' });
  assert.deepEqual(events, [['close', 'D:\\data'], ['change'], ['follow', 'C:\\Fuli\\versions\\new'], ['reopen', 'C:\\Fuli']]);

  const failed = [];
  await assert.rejects(withWindowsClientClosed(plan, fake('exited', failed), async () => { throw new Error('switch failed'); }), /switch failed/);
  assert.deepEqual(failed, [['close', 'D:\\data'], ['reopen', 'C:\\Fuli']]);

  const closed = [];
  const quiet = await withWindowsClientClosed(plan, fake('absent', closed), async () => ({ packageRoot: 'C:\\Fuli\\versions\\new' }));
  assert.equal(quiet.desktopClient, 'not_open');
  assert.equal(closed.some(([name]) => name === 'reopen'), false);
});
