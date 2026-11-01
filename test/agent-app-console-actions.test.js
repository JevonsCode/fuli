import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAppConsoleActions } from '../src/agent-apps/console-actions.js';
import { revealPath } from '../src/desktop/reveal-path.js';
import { openTerminalWindow } from '../src/desktop/terminal-window.js';
import { createServer } from '../src/server.js';
import { appRegistry, verifiedApp } from '../test-support/agent-app-hosts.js';
import { closeServer, requestJson } from '../test-support/server.js';

// The console's Apps buttons that would otherwise send the person to a
// terminal (#346): a terminal window for the typed confirmation, and an export
// folder FULI picks. Synthetic apps; no terminal, Explorer or Finder is opened.

const CLI = ['/synthetic/node', '/synthetic/fuli/src/cli.js'];
const RUNTIME = '/synthetic/data/graph-runtime.json';

function fakeSpawn({ fail = false } = {}) {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { unref() { child.unrefed = true; } });
    setImmediate(() => child.emit(fail ? 'error' : 'spawn', fail ? new Error('synthetic spawn failure') : undefined));
    return child;
  };
  return { calls, spawnProcess };
}

function consoleActions(t, host) {
  const exportsRoot = mkdtempSync(join(tmpdir(), 'fuli-app-exports-'));
  t.after(() => rmSync(exportsRoot, { recursive: true, force: true }));
  const opened = [];
  const revealed = [];
  const actions = createAppConsoleActions({ agentApps: host.service, cli: CLI, runtimeConfigPath: RUNTIME, exportsRoot,
    openTerminal: async (command) => { opened.push(command); return { opened: true }; },
    reveal: async (path) => { revealed.push(path); return { revealed: true }; },
    clock: () => new Date('2026-11-01T09:30:12.345Z') });
  return { actions, exportsRoot, opened, revealed };
}

test('the confirm button opens the terminal confirmation for a stored version only', async (t) => {
  const host = appRegistry(t).host({ pid: 101 });
  const { appId } = await verifiedApp(host);
  const { actions, opened } = consoleActions(t, host);

  assert.deepEqual(await actions.confirmInTerminal({ appId, action: 'approve', version: '1.0.0' }), { opened: true });
  assert.deepEqual(opened, [[...CLI, 'app', 'approve', appId, '1.0.0', '--runtime-config', RUNTIME]]);
  assert.throws(() => actions.confirmInTerminal({ appId, action: 'approve', version: '9.9.9' }), { code: 'version_not_found' });
  assert.throws(() => actions.confirmInTerminal({ appId, action: 'delete', version: '1.0.0' }), { code: 'invalid_action' });
  assert.throws(() => actions.confirmInTerminal({ appId: 'no-such-app', action: 'approve', version: '1.0.0' }),
    { code: 'app_not_found' });
  assert.equal(opened.length, 1);
});

test('the export button copies the data into a new folder, which only that app\'s reveal can show', async (t) => {
  const host = appRegistry(t).host({ pid: 101 });
  const { appId } = await verifiedApp(host);
  const { actions, exportsRoot, revealed } = consoleActions(t, host);
  await host.service.start({ appId });
  await assert.rejects(actions.exportData({ appId }));
  await host.service.stop({ appId });

  const exported = await actions.exportData({ appId });
  assert.equal(exported.path, join(exportsRoot, `${appId}-20261101T093012Z`));
  assert.equal(existsSync(exported.path), true);
  assert.equal(typeof exported.files, 'number');
  assert.equal(typeof exported.bytes, 'number');

  assert.deepEqual(await actions.revealExport({ appId, path: exported.path }), { revealed: true });
  assert.deepEqual(revealed, [exported.path]);
  for (const path of [exportsRoot, join(exportsRoot, '..'), join(exportsRoot, 'other-app-20261101T093012Z'), tmpdir()]) {
    assert.throws(() => actions.revealExport({ appId, path }), { code: 'export_not_found' }, path);
  }
});

test('the terminal window runs the command in a new Windows console, and refuses what cmd would expand', async () => {
  const { calls, spawnProcess } = fakeSpawn();
  const command = ['C:\\Program Files\\Fuli\\FuliNode.exe', 'C:\\Fuli\\src\\cli.js', 'app', 'approve', 'app-1', '1.0.0'];
  assert.deepEqual(await openTerminalWindow(command, { platform: 'win32', spawnProcess }), { opened: true });
  assert.equal(calls[0].command, 'cmd.exe');
  assert.deepEqual(calls[0].args, ['/d', '/k',
    '""C:\\Program Files\\Fuli\\FuliNode.exe" "C:\\Fuli\\src\\cli.js" "app" "approve" "app-1" "1.0.0""']);
  assert.equal(calls[0].options.detached, true);
  await assert.rejects(openTerminalWindow(['C:\\%TEMP%\\node.exe'], { platform: 'win32', spawnProcess }),
    { code: 'terminal_unavailable' });
  await assert.rejects(openTerminalWindow(command, { platform: 'win32', spawnProcess: fakeSpawn({ fail: true }).spawnProcess }),
    { code: 'terminal_unavailable' });
  await assert.rejects(openTerminalWindow(command, { platform: 'linux', spawnProcess }), { code: 'terminal_unavailable' });
  assert.equal(calls.length, 1);
});

test('on macOS the terminal window is a one-shot script opened in Terminal', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-terminal-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { calls, spawnProcess } = fakeSpawn();
  await openTerminalWindow(['/Applications/Fuli.app/node', "/it's/cli.js", 'app', 'rollback', 'app-1', '1.0.0'],
    { platform: 'darwin', spawnProcess, directory: () => directory });
  const script = join(directory, 'fuli-confirm.command');
  assert.deepEqual([calls[0].command, calls[0].args], ['open', ['-a', 'Terminal', script]]);
  assert.equal(readFileSync(script, 'utf8'), "#!/bin/sh\nrm -f -- \"$0\"\n'/Applications/Fuli.app/node' '/it'\\''s/cli.js' "
    + "'app' 'rollback' 'app-1' '1.0.0'\n");
});

test('reveal selects the folder in Explorer or Finder', async () => {
  const { calls, spawnProcess } = fakeSpawn();
  await revealPath('C:\\Users\\synthetic\\Downloads\\FULI app exports\\app-1', { platform: 'win32', spawnProcess });
  await revealPath('/Users/synthetic/Downloads/FULI app exports/app-1', { platform: 'darwin', spawnProcess });
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['explorer.exe', ['/select,"C:\\Users\\synthetic\\Downloads\\FULI app exports\\app-1"']],
    ['open', ['-R', '/Users/synthetic/Downloads/FULI app exports/app-1']]
  ]);
  assert.throws(() => revealPath('/x', { platform: 'linux', spawnProcess }), { code: 'reveal_unavailable' });
});

test('the console routes reach these buttons only on this computer, and say when the console has none', async (t) => {
  const host = appRegistry(t).host({ pid: 101 });
  const { appId } = await verifiedApp(host);
  const { actions, opened } = consoleActions(t, host);
  const { server, url } = await createServer({ app: { agentApps: host.service, agentAppConsole: actions }, port: 0 });
  t.after(() => closeServer(server));

  const confirmed = await requestJson(`${url}/api/agent-apps/${appId}/confirm`,
    { method: 'POST', body: { action: 'rollback', version: '1.0.0' } });
  assert.deepEqual([confirmed.status, confirmed.body], [200, { opened: true }]);
  assert.equal(opened[0][3], 'rollback');
  // The data directory exists once the app has run.
  await host.service.start({ appId });
  await host.service.stop({ appId });
  const exported = await requestJson(`${url}/api/agent-apps/${appId}/export`, { method: 'POST', body: {} });
  assert.equal(exported.status, 200);
  assert.match(exported.body.path, new RegExp(`${appId}-20261101T093012Z$`));
  const invalid = await requestJson(`${url}/api/agent-apps/${appId}/confirm`,
    { method: 'POST', body: { action: 'delete', version: '1.0.0' } });
  assert.equal(invalid.status, 400);

  const bare = await createServer({ app: { agentApps: host.service }, port: 0 });
  t.after(() => closeServer(bare.server));
  const unavailable = await requestJson(`${bare.url}/api/agent-apps/${appId}/export`, { method: 'POST', body: {} });
  assert.deepEqual([unavailable.status, unavailable.body.code], [409, 'app_console_unavailable']);
});
