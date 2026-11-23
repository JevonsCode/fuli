import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { clientFirstRun } from '../src/agents/client-first-run.js';
import { approveFuliInFolder, CURSOR_APPROVE_COMMAND, cursorFirstRunPending, fuliApprovedSomewhere } from '../src/agents/cursor/first-run.js';
import { createClientConnectionObserver } from '../src/system/client-connection-status.js';
import { createClientFirstRunAction } from '../src/system/client-first-run-action.js';

const state = (component, value) => ({ component, state: value });
const scratch = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-cursor-first-run-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
// Cursor's CLI approval file for one folder, as cursor-agent 2026.01.23 writes it.
const approve = (home, folderSlug, entries) => {
  mkdirSync(join(home, '.cursor', 'projects', folderSlug), { recursive: true });
  writeFileSync(join(home, '.cursor', 'projects', folderSlug, 'mcp-approvals.json'), JSON.stringify(entries));
};
const cursor = (connected) => ({ id: 'cursor', name: 'Cursor', builtin: true, detected: true, platformSupported: true,
  state: connected ? 'connected' : 'not_connected',
  componentStates: [state('mcp', connected ? 'current' : 'missing'), state('hooks', connected ? 'current' : 'missing')] });
const installerWith = (clients) => ({ status: async () => ({ status: 'available', extensionErrors: [], clients }) });

test('Cursor\'s first-run step is only for a computer with its CLI where FULI is approved in no folder yet', async (t) => {
  const home = scratch(t);
  const found = (answer) => async (command) => (command === 'cursor-agent' ? answer : null);
  assert.equal(await cursorFirstRunPending({ commandFound: found('native'), homeDir: home }), true);
  // Only the desktop app (no CLI), or a CLI only inside WSL: the CLI's question never comes up here.
  assert.equal(await cursorFirstRunPending({ commandFound: found(null), homeDir: home }), false);
  assert.equal(await cursorFirstRunPending({ commandFound: found('wsl'), homeDir: home }), false);
  // Another server approved somewhere is not FULI.
  approve(home, 'work-blue-kettle', ['demo-05d6568c2d0004dd']);
  assert.equal(fuliApprovedSomewhere({ homeDir: home }), false);
  // Once FULI is approved in one folder, the person has met the question: the card stops repeating it.
  approve(home, 'work-green-teapot', ['fuli-1a2b3c4d5e6f7a8b']);
  assert.equal(fuliApprovedSomewhere({ homeDir: home }), true);
  assert.equal(await cursorFirstRunPending({ commandFound: found('native'), homeDir: home }), false);
});

test('the step runs Cursor\'s own command in the folder named, and says honestly how it went', async () => {
  const runs = [];
  const run = (answer) => async (program, args, options) => { runs.push([program, args, options.cwd]); return answer; };
  const locate = async () => '/opt/cursor/bin/cursor-agent';
  const approved = await approveFuliInFolder('/work/blue-kettle', { locate,
    run: run({ code: 0, output: '\u001b[2KEnabling MCP server \'fuli\'...\n\u001b[2K✓ Enabled and approved MCP server: fuli\n' }) });
  assert.deepEqual(approved, { status: 'approved', command: CURSOR_APPROVE_COMMAND, folder: '/work/blue-kettle',
    output: '✓ Enabled and approved MCP server: fuli' });
  assert.deepEqual(runs[0], ['/opt/cursor/bin/cursor-agent', ['mcp', 'enable', 'fuli'], '/work/blue-kettle']);
  assert.equal(CURSOR_APPROVE_COMMAND, 'cursor-agent mcp enable fuli');
  // No answer in time: most likely a question nobody sees; it is said, not waited on forever.
  assert.deepEqual(await approveFuliInFolder('/work/blue-kettle', { locate, timeoutMs: 50, run: run({ timedOut: true, code: 1, output: '' }) }),
    { status: 'no_answer', command: CURSOR_APPROVE_COMMAND, folder: '/work/blue-kettle', waitedMs: 50 });
  // A refusal repeats the CLI's own last line, never a deprecation warning.
  assert.deepEqual(await approveFuliInFolder('/work/blue-kettle', { locate,
    run: run({ code: 1, output: 'Error: no MCP server named fuli\n(node:1) DeprecationWarning: url.parse()\n' }) }),
  { status: 'failed', command: CURSOR_APPROVE_COMMAND, folder: '/work/blue-kettle', output: 'Error: no MCP server named fuli' });
  assert.deepEqual(await approveFuliInFolder('/work/blue-kettle', { locate: async () => null, run: run({ code: 0 }) }),
    { status: 'not_installed', command: CURSOR_APPROVE_COMMAND, folder: '/work/blue-kettle' });
});

test('the console offers it only on a connected Cursor whose question is still ahead, with the command it will run', async (t) => {
  const home = scratch(t);
  const presence = { command: async (command) => (command === 'cursor-agent' ? 'native' : null), find: async () => ({ installed: new Set(), inWsl: new Set(), pending: new Set() }) };
  const observe = (clients) => createClientConnectionObserver({ installer: installerWith(clients), customClients: { removable: () => new Set() },
    historyPath: join(scratch(t), 'history.json'), homeDir: home, presence }).observe();
  const connected = (await observe([cursor(true)])).clients[0];
  assert.deepEqual(connected.firstRun, { id: 'cursor', command: 'cursor-agent mcp enable fuli' });
  assert.equal((await observe([cursor(false)])).clients[0].firstRun, undefined);
  approve(home, 'work-blue-kettle', ['fuli-1a2b3c4d5e6f7a8b']);
  assert.equal((await observe([cursor(true)])).clients[0].firstRun, undefined);
});

test('the action takes one existing folder and a client that has a step, nothing else', async (t) => {
  const folder = scratch(t);
  const action = createClientFirstRunAction({ locate: async () => null });
  assert.equal(clientFirstRun('codex'), null);
  await assert.rejects(() => action({ clientId: 'codex', folder }), /no first-run step/);
  await assert.rejects(() => action({ clientId: 'cursor', folder: 'relative/folder' }), /existing absolute folder/);
  await assert.rejects(() => action({ clientId: 'cursor', folder: join(folder, 'missing') }), /existing absolute folder/);
  await assert.rejects(() => action({ clientId: 'cursor', folder, extra: true }), /only a clientId and a folder/);
  // A computer without Cursor's CLI: nothing runs, and it says so.
  assert.deepEqual(await action({ clientId: 'cursor', folder }),
    { id: 'cursor', status: 'not_installed', command: 'cursor-agent mcp enable fuli', folder });
});
