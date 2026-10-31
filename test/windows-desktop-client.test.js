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
const SCHEME = 'HKCU\\Software\\Classes\\fuli';
const SCHEME_COMMAND = SCHEME + '\\shell\\open\\command';
const login = root => `"${join(root, 'Fuli.exe')}" --background`;
const link = root => `"${join(root, 'Fuli.exe')}" "%1"`;

// Values are '<key>|<name>' (the default value has an empty name); a key
// without values is '<key>'. Deleting a key removes everything under it.
function fakeReg(values = {}) {
  const calls = [];
  const reg = async (args) => {
    calls.push(args);
    const [verb, key] = args;
    const name = args.includes('/ve') ? '' : args.includes('/v') ? args[args.indexOf('/v') + 1] : null;
    const id = name === null ? key : key + '|' + name;
    if (verb === 'query') {
      if (name === null) return Object.keys(values).some(k => k === key || k.startsWith(key + '|') || k.startsWith(key + '\\')) ? { code: 0, stdout: `\r\n${key}\r\n` } : { code: 1, stdout: '' };
      if (!(id in values)) return { code: 1, stdout: '' };
      return { code: 0, stdout: `\r\n${key}\r\n    ${name || '(Default)'}    REG_SZ    ${values[id]}\r\n\r\n` };
    }
    if (verb === 'add') { values[id] = args[args.indexOf('/d') + 1]; return { code: 0, stdout: '' }; }
    if (verb === 'delete') {
      for (const k of Object.keys(values)) {
        if (k === id || (name === null && (k.startsWith(key + '|') || k.startsWith(key + '\\')))) delete values[k];
      }
      return { code: 0, stdout: '' };
    }
    return { code: 1, stdout: '' };
  };
  return { reg, calls, values };
}

// The scheme as the client registers it (windows_url_scheme.dart).
const scheme = root => ({ [SCHEME + '|']: 'URL:FULI', [SCHEME + '|URL Protocol']: '', [SCHEME_COMMAND + '|']: link(root) });

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

test('the entries of this installation follow the switch to the installed client', async (t) => {
  const f = installRoot(t);
  const before = f.slot('old'), after = f.slot('new');
  writeFileSync(join(after, 'client', 'FULI.exe'), '');
  const registry = fakeReg({ [RUN + '|FULI']: login(before), ...scheme(before) });
  assert.deepEqual(await windowsDesktopClient.followSwitch(f.install, after, registry), { loginLaunch: 'retargeted', urlScheme: 'retargeted' });
  assert.deepEqual(registry.values, { [RUN + '|FULI']: login(after), ...scheme(after) });
  assert.deepEqual(await windowsDesktopClient.followSwitch(f.install, after, registry), { loginLaunch: 'unchanged', urlScheme: 'unchanged' });
});

test('switching to a version without the desktop client removes the entries: the old tray takes no arguments', async (t) => {
  const f = installRoot(t);
  const before = f.slot('new'), kept = f.slot('old');
  const registry = fakeReg({ [RUN + '|FULI']: login(before), ...scheme(before) });
  assert.deepEqual(await windowsDesktopClient.followSwitch(f.install, kept, registry), { loginLaunch: 'removed', urlScheme: 'removed' });
  assert.deepEqual(registry.values, {}, 'the whole fuli scheme key goes');
});

test('no entry, or an entry that starts another FULI, is left alone; a refused write is reported, never thrown', async (t) => {
  const f = installRoot(t);
  const target = f.slot('new');
  writeFileSync(join(target, 'client', 'FULI.exe'), '');
  const empty = fakeReg();
  assert.deepEqual(await windowsDesktopClient.followSwitch(f.install, target, empty), { loginLaunch: 'unchanged', urlScheme: 'unchanged' });
  assert.deepEqual(empty.calls.map(([verb]) => verb), ['query', 'query']);

  const elsewhere = join(f.root, 'elsewhere');
  const foreign = fakeReg({ [RUN + '|FULI']: login(elsewhere), ...scheme(elsewhere) });
  assert.deepEqual(await windowsDesktopClient.followSwitch(f.install, target, foreign), { loginLaunch: 'unchanged', urlScheme: 'unchanged' });
  assert.deepEqual(foreign.values, { [RUN + '|FULI']: login(elsewhere), ...scheme(elsewhere) });

  const old = f.slot('old');
  const refusing = fakeReg({ [RUN + '|FULI']: login(old), ...scheme(old) });
  const reg = async (args) => args[0] === 'add' && args[1] === SCHEME_COMMAND ? { code: 1, stdout: '' } : refusing.reg(args);
  assert.deepEqual(await windowsDesktopClient.followSwitch(f.install, target, { reg }), { loginLaunch: 'retargeted', urlScheme: 'failed' },
    'each entry is reported on its own');
});

test('the scheme command is read from the default value whatever its localized name', async (t) => {
  const f = installRoot(t);
  const before = f.slot('old'), after = f.slot('new');
  writeFileSync(join(after, 'client', 'FULI.exe'), '');
  const registry = fakeReg(scheme(before));
  const reg = async (args) => {
    const result = await registry.reg(args);
    return args.includes('/ve') && args[0] === 'query' ? { ...result, stdout: result.stdout.replace('(Default)', '(默认)') } : result;
  };
  assert.equal((await windowsDesktopClient.followSwitch(f.install, after, { reg })).urlScheme, 'retargeted');
  assert.equal(registry.values[SCHEME_COMMAND + '|'], link(after));
});

test('uninstall removes this installation\'s entries, the client settings and its notification identity', async (t) => {
  const f = installRoot(t);
  const settings = 'HKCU\\Software\\Fuli\\DesktopClient';
  const identity = 'HKCU\\Software\\Classes\\AppUserModelId\\FULI';
  const slot = f.slot('a');
  const registry = fakeReg({ [RUN + '|FULI']: login(slot), ...scheme(slot), [settings]: '', [identity]: '' });
  assert.equal(await windowsDesktopClient.unregister(f.install, registry), 'removed');
  assert.deepEqual(registry.values, {});

  const elsewhere = join(f.root, 'elsewhere');
  const foreign = fakeReg({ [RUN + '|FULI']: login(elsewhere), ...scheme(elsewhere) });
  assert.equal(await windowsDesktopClient.unregister(f.install, foreign), 'removed');
  assert.deepEqual(foreign.values, { [RUN + '|FULI']: login(elsewhere), ...scheme(elsewhere) }, 'another FULI keeps its entries');
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
    followSwitch: async (root, packageRoot) => { events.push(['follow', packageRoot]); return { loginLaunch: 'retargeted', urlScheme: 'retargeted' }; },
    reopen: root => events.push(['reopen', root])
  });
  const events = [];
  const result = await withWindowsClientClosed(plan, fake('exited', events), async () => {
    events.push(['change']);
    return { packageRoot: 'C:\\Fuli\\versions\\new' };
  });
  assert.deepEqual(result, { packageRoot: 'C:\\Fuli\\versions\\new', desktopClient: 'reopened', loginLaunch: 'retargeted', urlScheme: 'retargeted' });
  assert.deepEqual(events, [['close', 'D:\\data'], ['change'], ['follow', 'C:\\Fuli\\versions\\new'], ['reopen', 'C:\\Fuli']]);

  const failed = [];
  await assert.rejects(withWindowsClientClosed(plan, fake('exited', failed), async () => { throw new Error('switch failed'); }), /switch failed/);
  assert.deepEqual(failed, [['close', 'D:\\data'], ['reopen', 'C:\\Fuli']]);

  const closed = [];
  const quiet = await withWindowsClientClosed(plan, fake('absent', closed), async () => ({ packageRoot: 'C:\\Fuli\\versions\\new' }));
  assert.equal(quiet.desktopClient, 'not_open');
  assert.equal(closed.some(([name]) => name === 'reopen'), false);
});
