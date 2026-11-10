import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configuredInstall } from '../src/agent-kits/configured-install.js';
import { claudeDesktopApp } from '../src/agents/claude-desktop/app-control.js';
import { clientApps } from '../src/agents/client-apps.js';
import { createClientConnectionObserver } from '../src/system/client-connection-status.js';
import { createClientRestart } from '../src/system/client-restart.js';

// rec#106. Everything is synthetic: a temporary home with made-up client files
// and FULI folders, a fake agent-installer and a fake app. No real client is
// read, quit or opened.

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-overwrite-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fuliPackage(root, version) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fuli', version }));
  return { node: join(root, 'runtime', 'node'), script: join(root, 'src', 'mcp-server.js') };
}
function writeConfig(dir, relative, value) {
  const file = join(dir, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
const desktopEntry = ({ node, script }) => ({ mcpServers: { other: { command: 'x', args: ['y'] },
  fuli: { command: node, args: [script, '--runtime-config', '/data/graph-runtime.json', '--source-application', 'claude'] } } });

test('the installation a client entry names is read from JSON, Codex TOML and OpenCode files', (t) => {
  const dir = home(t);
  const old = fuliPackage(join(dir, 'Apps', 'FULI.app', 'Contents', 'Resources', 'fuli'), '0.23.0');
  writeConfig(dir, 'claude/claude_desktop_config.json', desktopEntry(old));
  const desktop = configuredInstall(['~/claude/claude_desktop_config.json'], { homeDir: dir, platform: 'darwin' });
  assert.equal(desktop.root, join(dir, 'Apps', 'FULI.app', 'Contents', 'Resources', 'fuli'));
  assert.deepEqual([desktop.version, desktop.exists], ['0.23.0', true]);

  const toml = `[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.fuli]\ncommand = ${JSON.stringify(old.node)}\nargs = [${JSON.stringify(old.script)}, "--runtime-config", "/d"]\n\n[profile]\nx = 1\n`;
  writeConfig(dir, 'codex/config.toml', toml);
  assert.equal(configuredInstall(['~/codex/config.toml'], { homeDir: dir }).version, '0.23.0');

  writeConfig(dir, 'opencode/opencode.json', { mcp: { fuli: { type: 'local', command: [old.node, old.script, '--runtime-config', '/d'] } } });
  assert.equal(configuredInstall(['~/opencode/opencode.json'], { homeDir: dir }).version, '0.23.0');

  // The installed Windows launcher runs a package-relative script: the installation is the launcher's folder.
  const launcher = join(dir, 'Programs', 'FULI', 'FuliNode.exe');
  writeConfig(dir, 'cursor/mcp.json', { mcpServers: { fuli: { command: launcher, args: ['src/mcp-server.js', '--runtime-config', '/d'] } } });
  const windows = configuredInstall(['~/cursor/mcp.json'], { homeDir: dir });
  assert.deepEqual([windows.root, windows.version, windows.exists], [join(dir, 'Programs', 'FULI'), null, false]);

  // Missing or foreign files say nothing.
  writeConfig(dir, 'none.json', { mcpServers: { other: { command: 'x', args: [] } } });
  assert.equal(configuredInstall(['~/none.json', '~/absent.json', 'relative.json'], { homeDir: dir }), null);
});

function observerFixture(t) {
  const dir = home(t);
  const current = fuliPackage(join(dir, 'fuli-prerelease', 'FULI.app', 'Contents', 'Resources', 'fuli'), '0.25.0');
  const old = fuliPackage(join(dir, 'Apps', 'FULI.app', 'Contents', 'Resources', 'fuli'), '0.23.0');
  let clock = Date.parse('2026-11-10T10:00:00Z');
  let mcp = 'outdated';
  let running = true;
  const make = () => createClientConnectionObserver({
    installer: { status: async () => ({ status: 'available', extensionErrors: [], clients: [{
      id: 'claude-desktop', name: 'Claude Desktop', builtin: true, detected: true, platformSupported: true, evidence: [], components: ['mcp'],
      state: mcp === 'current' ? 'connected' : 'update_available',
      componentStates: [{ component: 'mcp', state: mcp, paths: ['~/claude/claude_desktop_config.json'] }] }] }) },
    customClients: { removable: () => new Set() },
    historyPath: join(dir, 'data', 'client-connection-observations.json'),
    now: () => new Date(clock),
    consoleInstall: { nodePath: current.node, mcpServerPath: current.script, version: '0.25.0' },
    apps: { 'claude-desktop': { running: async () => running } },
    homeDir: dir,
    platform: 'darwin'
  });
  return {
    make, current, old,
    // What the client's file names now, and agent-installer's verdict on it.
    names: (install) => { writeConfig(dir, 'claude/claude_desktop_config.json', desktopEntry(install)); mcp = install === current ? 'current' : 'outdated'; },
    after: (minutes) => { clock += minutes * 60_000; },
    stopApp: () => { running = false; }
  };
}

test('an update that the client writes back within the window is reported as overwritten, with both installations', async (t) => {
  const { make, current, old, names, after } = observerFixture(t);
  const observer = make();
  names(old);
  const before = (await observer.observe()).clients[0];
  assert.equal(before.status, 'changed');
  assert.equal(before.overwritten, false, 'an outdated entry alone is not an overwrite');
  assert.deepEqual(before.configuredInstall, { path: join('~', 'Apps', 'FULI.app'), version: '0.23.0', exists: true, sameAsConsole: false });
  assert.deepEqual(before.restart, { running: true });

  after(1); names(current);
  const updated = (await observer.observe()).clients[0];
  assert.equal(updated.status, 'connected');
  assert.equal(updated.configuredInstall, undefined);
  assert.equal(updated.restart, undefined, 'a current entry does not ask whether the app runs');

  after(3); names(old);
  const result = await observer.observe();
  const reverted = result.clients[0];
  assert.equal(reverted.overwritten, true);
  assert.deepEqual(reverted.changes.map(({ from, to, overwritten }) => [from, to, overwritten ?? false]),
    [['changed', 'connected', false], ['connected', 'changed', true]]);
  // Two FULIs on this machine: the console's, and the one the client still names.
  assert.deepEqual(result.installs, { console: { path: join('~', 'fuli-prerelease', 'FULI.app'), version: '0.25.0' },
    others: [{ path: join('~', 'Apps', 'FULI.app'), version: '0.23.0', clients: ['Claude Desktop'] }] });

  // History keeps it for a new observer (a restarted console).
  const again = (await make().observe()).clients[0];
  assert.equal(again.overwritten, true);
});

test('a change to a different installation, or long after the update, is not an overwrite', async (t) => {
  const { make, current, old, names, after } = observerFixture(t);
  const observer = make();
  names(old); await observer.observe();
  after(1); names(current); await observer.observe();
  // A third installation, as a newer FULI elsewhere would write.
  const other = fuliPackage(join(current.script, '..', '..', '..', 'other-fuli'), '0.26.0');
  after(3); names(other);
  assert.equal((await observer.observe()).clients[0].overwritten, false);

  const late = observerFixture(t);
  const second = late.make();
  late.names(late.old); await second.observe();
  late.after(1); late.names(late.current); await second.observe();
  late.after(3 * 60); late.names(late.old);
  assert.equal((await second.observe()).clients[0].overwritten, false);
});

function fakeApp({ running = true, quits = true, opens = true } = {}) {
  const calls = [];
  const state = { running };
  return { calls, state, app: {
    running: async () => { calls.push('running'); return state.running; },
    quit: async () => { calls.push('quit'); if (quits) state.running = false; },
    open: async () => { calls.push('open'); if (!opens) throw new Error('cannot open'); state.running = true; }
  } };
}
function restartWith(app, { connected = true, current = true, connectThrows = false } = {}) {
  const log = [];
  let clock = 0;
  const restart = createClientRestart({
    apps: { 'claude-desktop': app },
    connect: async (input) => {
      log.push(['connect', input, app.running ? 'checked' : '']);
      if (connectThrows) throw new TypeError('busy');
      return { id: input.clientId, status: connected ? 'connected' : 'failed', restartRequired: connected };
    },
    inspect: async (id) => { log.push(['inspect', id]); return { id, integrationStatus: current ? 'connected' : 'update_available' }; },
    wait: async (ms) => { clock += ms; },
    now: () => clock
  });
  return { restart, log };
}

test('restart quits the app, updates while it is closed, reopens it and checks the entry', async () => {
  const { app, calls, state } = fakeApp();
  const { restart, log } = restartWith(app);
  assert.deepEqual(await restart({ clientId: 'claude-desktop' }), { id: 'claude-desktop', status: 'connected' });
  assert.deepEqual(calls.slice(0, 3), ['running', 'quit', 'running']);
  assert.equal(calls.at(-1), 'open');
  assert.deepEqual(log.map(([step]) => step), ['connect', 'inspect']);
  assert.equal(state.running, true);
});

test('an app that will not quit is left open and nothing is written', async () => {
  const { app, calls } = fakeApp({ quits: false });
  const { restart, log } = restartWith(app);
  assert.equal((await restart({ clientId: 'claude-desktop' })).status, 'quit_failed');
  assert.deepEqual(log, []);
  assert.equal(calls.includes('open'), false);
  // An app that cannot say whether it runs counts as running.
  const unknown = { running: async () => { throw new Error('osascript failed'); }, quit: async () => {}, open: async () => {} };
  const second = restartWith(unknown);
  assert.equal((await second.restart({ clientId: 'claude-desktop' })).status, 'quit_failed');
  assert.deepEqual(second.log, []);
});

test('a failed write or check still reopens the app and says which step failed', async () => {
  for (const [options, status] of [[{ connected: false }, 'connect_failed'], [{ connectThrows: true }, 'connect_failed'],
    [{ current: false }, 'check_failed']]) {
    const { app, calls } = fakeApp();
    const { restart } = restartWith(app, options);
    assert.equal((await restart({ clientId: 'claude-desktop' })).status, status);
    assert.equal(calls.at(-1), 'open', status);
  }
  const { app } = fakeApp({ opens: false });
  assert.equal((await restartWith(app).restart({ clientId: 'claude-desktop' })).status, 'reopen_failed');
});

test('only a client FULI can restart here is accepted, with only its id', async () => {
  const { app } = fakeApp();
  const { restart } = restartWith(app);
  await assert.rejects(restart({ clientId: 'codex' }), TypeError);
  await assert.rejects(restart({ clientId: 'claude-desktop', force: true }), TypeError);
  await assert.rejects(restart({ clientId: '__proto__' }), TypeError);
});

test('Claude Desktop is quit and reopened by its own commands on macOS only, never killed', async () => {
  assert.equal(claudeDesktopApp({ platform: 'win32' }), null);
  assert.deepEqual(Object.keys(clientApps({ platform: 'linux' })), []);
  const runs = [];
  const app = claudeDesktopApp({ platform: 'darwin', run: async (command, args) => { runs.push([command, ...args]); return { stdout: 'true\n' }; } });
  assert.deepEqual(Object.keys(clientApps({ platform: 'darwin', run: async () => ({ stdout: '' }) })), ['claude-desktop']);
  assert.equal(await app.running(), true);
  await app.quit();
  await app.open();
  assert.deepEqual(runs, [
    ['osascript', '-e', 'application id "com.anthropic.claudefordesktop" is running'],
    ['osascript', '-e', 'tell application id "com.anthropic.claudefordesktop" to quit'],
    ['open', '-b', 'com.anthropic.claudefordesktop']
  ]);
  assert.equal(runs.some(([command]) => /kill/.test(command)), false);
});
