import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCliPresence } from '../../src/agent-kits/cli-presence.js';
import { createNewSessions } from '../../src/agent-kits/new-sessions.js';
import { handleSessionLaunchRequest } from '../../src/http/session-launch-api-router.js';

// Synthetic launcher answers and synthetic program directories only.
const CLIENTS = [
  { id: 'claude-code', enabled: true, newSession: { kind: 'cli', prompt: 'send', openSupported: true } },
  { id: 'opencode-cli', enabled: true, newSession: { kind: 'cli', prompt: 'send', openSupported: true } },
  { id: 'gemini-cli', enabled: false, newSession: { kind: 'cli', prompt: 'send', openSupported: true } },
  { id: 'kiro-cli', enabled: true, newSession: { kind: 'cli', prompt: null, openSupported: true } },
  { id: 'codex-cli', enabled: true, newSession: { kind: 'cli', prompt: 'send', openSupported: true } },
  { id: 'codex-desktop', enabled: true, newSession: { kind: 'uri', prompt: 'prefill', openSupported: true } }
];
const PROGRAMS = { 'claude-code': 'claude', 'opencode-cli': 'opencode', 'codex-cli': 'codex' };

function fakeLauncher({ clients = { status: 'available', clients: CLIENTS }, open = { status: 'available', outcome: 'launch_requested' } } = {}) {
  const opened = [];
  return {
    opened,
    clients: async () => clients,
    inspectNew: async ({ client }) => ({ status: 'available', plan: { kind: 'cli', executable: PROGRAMS[client] ?? client } }),
    openNew: async (target) => { opened.push(target); return open; }
  };
}
const presence = (found) => ({ find: async (program) => found[program] ?? null });

test('ways name the connected clients whose CLI takes a prompt and is installed here, natively or in WSL', async () => {
  const sessions = createNewSessions({ launcher: fakeLauncher(), presence: presence({ claude: 'native', opencode: 'wsl' }) });
  assert.deepEqual(await sessions.ways(['claude-code', 'opencode', 'codex', 'gemini-cli', 'kiro', 'claude-desktop', 'acme']), {
    launcher: 'available',
    ways: { 'claude-code': { prompt: 'send' }, opencode: { prompt: 'send', environment: 'wsl' } }
  }, 'codex is not installed, gemini is disabled, kiro takes no prompt, Claude Desktop and custom clients have no CLI');
  const offline = createNewSessions({ launcher: fakeLauncher({ clients: { status: 'unavailable', reason: 'offline' } }), presence: presence({}) });
  assert.deepEqual(await offline.ways(['claude-code']), { launcher: 'unavailable', reason: 'offline' });
});

test('open re-checks the way, passes the prompt as data and reports what the launcher said', async () => {
  const launcher = fakeLauncher();
  const sessions = createNewSessions({ launcher, presence: presence({ opencode: 'wsl', claude: 'native' }) });
  const prompt = '#FLA Tonborg 讲讲 "这个"; & 100% $(rm -rf ~)\nnext';
  assert.deepEqual(await sessions.open({ client: 'opencode', prompt }), { status: 'launch_requested' });
  assert.deepEqual(launcher.opened, [{ client: 'opencode-cli', prompt, environment: 'wsl' }]);
  assert.deepEqual(await sessions.open({ client: 'codex', prompt: 'p' }), { status: 'unavailable', reason: 'not_installed' });
  await assert.rejects(sessions.open({ client: 'claude-desktop', prompt: 'p' }), { code: 'invalid_input' });
  await assert.rejects(sessions.open({ client: 'claude-code', prompt: '   ' }), { code: 'invalid_input' });
  await assert.rejects(sessions.open({ client: 'claude-code', prompt: 'x'.repeat(2001) }), { code: 'invalid_input' });
  const refusing = createNewSessions({ launcher: fakeLauncher({ open: { status: 'refused', code: 'invalid_prompt' } }),
    presence: presence({ claude: 'native' }) });
  assert.deepEqual(await refusing.open({ client: 'claude-code', prompt: '-rf' }), { status: 'refused', code: 'invalid_prompt' });
  assert.equal(launcher.opened.length, 1, 'nothing else opened');
});

test('a program counts on PATH, through the login shell, or in WSL on Windows, and answers are kept', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-cli-presence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n');
  chmodSync(join(bin, 'claude'), 0o755);
  writeFileSync(join(bin, 'codex.cmd'), '@echo off\r\n');
  writeFileSync(join(bin, 'wsl.exe'), '');
  const runs = [];
  let clock = 0;
  const posix = createCliPresence({ platform: 'linux', env: { PATH: bin, SHELL: '/bin/zsh' }, now: () => clock,
    run: async (command, args) => { runs.push([command, ...args]); return args.at(-1) === 'gemini'; } });
  assert.equal(await posix.find('claude'), 'native');
  assert.equal(await posix.find('gemini'), 'native', 'found by the person\'s login shell');
  assert.equal(await posix.find('agy'), null);
  assert.deepEqual(runs[0], ['/bin/zsh', '-lic', 'command -v -- "$1" >/dev/null', 'probe', 'gemini']);
  assert.equal(await posix.find('agy'), null);
  assert.equal(runs.length, 2, 'a recent answer is kept');
  clock += 10 * 60_000;
  await posix.find('agy');
  assert.equal(runs.length, 3, 'an old answer is asked again');
  for (const unsafe of ['a b', '../x', '-rf', '$(id)', '']) assert.equal(await posix.find(unsafe), null, unsafe);
  assert.equal(runs.length, 3, 'nothing runs for a name that is not a plain program');

  const windowsRuns = [];
  const windows = createCliPresence({ platform: 'win32', env: { PATH: bin, PATHEXT: '.EXE;.CMD' },
    run: async (command, args) => { windowsRuns.push([command, ...args]); return args.at(-1) === 'opencode'; } });
  assert.equal(await windows.find('codex'), 'native', 'an npm .cmd shim');
  assert.equal(await windows.find('opencode'), 'wsl');
  assert.equal(await windows.find('gemini'), null);
  assert.deepEqual(windowsRuns[0], ['wsl.exe', '--exec', 'bash', '-lic', 'command -v -- "$1" >/dev/null', 'probe', 'opencode']);
  const noWsl = createCliPresence({ platform: 'win32', env: { PATH: join(root, 'missing') }, run: async () => assert.fail('no WSL to ask') });
  assert.equal(await noWsl.find('opencode'), null);
});

function call(path, { method = 'GET', body, remoteAddress = '127.0.0.1', system } = {}) {
  const sent = [];
  const response = { setHeader() {}, writeHead(status) { sent.push(status); return this; }, end(text) { sent.push(JSON.parse(text)); } };
  const request = { method, socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
  return handleSessionLaunchRequest({ request, response, url: new URL(path, 'http://127.0.0.1'), system })
    .then((handled) => ({ handled, sent }));
}

test('only the console on this computer reads ways (a POST) and opens a new session', async () => {
  const asked = [];
  const system = {
    newSessionWays: async (ids) => { asked.push(ids); return { launcher: 'available', ways: {} }; },
    openNewSession: async (request) => { asked.push(request); return { status: 'launch_requested' }; }
  };
  assert.deepEqual(await call('/api/session-launch/new-session/ways', { method: 'POST', body: { clients: ['codex', 'opencode', 'codex'] }, system }),
    { handled: true, sent: [200, { launcher: 'available', ways: {} }] });
  // Reading ways starts shells and may download: never from a GET or a LAN console.
  assert.deepEqual((await call('/api/session-launch/new-session/ways?client=codex', { system })).sent, [405, { error: 'Method not allowed' }]);
  assert.deepEqual((await call('/api/session-launch/new-session?client=codex', { system })).sent, [405, { error: 'Method not allowed' }]);
  assert.deepEqual((await call('/api/session-launch/new-session/ways', { method: 'POST', body: { clients: ['codex'] }, remoteAddress: '192.168.1.20', system })).sent,
    [403, { error: 'A new session can only be opened on this computer' }]);
  assert.deepEqual(await call('/api/session-launch/new-session', { method: 'POST', body: { client: 'opencode', prompt: 'p' }, system }),
    { handled: true, sent: [200, { status: 'launch_requested' }] });
  assert.deepEqual(asked, [['codex', 'opencode'], { client: 'opencode', prompt: 'p' }]);
  assert.deepEqual(await call('/api/session-launch/new-session', { method: 'POST', body: { client: 'opencode', prompt: 'p' },
    remoteAddress: '192.168.1.20', system }), { handled: true, sent: [403, { error: 'A new session can only be opened on this computer' }] });
  assert.equal(asked.length, 2, 'a LAN request opened nothing');
  assert.deepEqual((await call('/api/session-launch/new-session', { method: 'DELETE', system })).sent[0], 405);
  system.openNewSession = async () => ({ status: 'refused', code: 'invalid_prompt' });
  assert.deepEqual((await call('/api/session-launch/new-session', { method: 'POST', body: { client: 'x', prompt: '-' }, system })).sent,
    [400, { status: 'refused', code: 'invalid_prompt' }]);
  system.openNewSession = async () => ({ status: 'unavailable', reason: 'not_installed' });
  assert.equal((await call('/api/session-launch/new-session', { method: 'POST', body: { client: 'x', prompt: 'p' }, system })).sent[0], 503);
});
