import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { consoleProcessOwned, endUnresponsiveConsole } from '../src/local-runtime/unresponsive-console.js';

// Synthetic stand-ins only: a temporary directory and a Node process that
// ignores SIGTERM and never answers, like the console in rec#94.
const FAST = Object.freeze({ answerWaitMs: 200, pollMs: 50, termWaitMs: 500, killWaitMs: 5_000 });
const STUCK_CONSOLE = `process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
process.stdout.write('ready\\n');
`;

function dataDirectory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-stuck-console-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const serverPath = join(dir, 'server.js');
  writeFileSync(serverPath, STUCK_CONSOLE);
  return { dir, paths: { serverPath, graphRuntimeConfigPath: join(dir, 'graph-runtime.json') } };
}

async function startStuckConsole(t, serverPath, configPath) {
  const child = spawn(process.execPath, [serverPath, '--runtime-config', configPath, '--port', '0'],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  return { child, exited };
}

const recorded = pid => ({ version: 4, pid, url: 'http://127.0.0.1:9' });

test('this data directory\'s console that ignores SIGTERM and never answers is ended', async t => {
  const { paths } = dataDirectory(t);
  const { child, exited } = await startStuckConsole(t, paths.serverPath, paths.graphRuntimeConfigPath);
  const asked = [];
  const outcome = await endUnresponsiveConsole(recorded(child.pid), paths, {
    health: async () => { asked.push(Date.now()); return false; }, limits: FAST });
  assert.equal(outcome, 'stopped');
  assert.ok(asked.length > 1, 'it is asked again before it is ended');
  const [, signal] = await exited;
  // POSIX needs SIGKILL for it; on Windows the first signal already ends it.
  if (process.platform !== 'win32') assert.equal(signal, 'SIGKILL');
});

test('a process that runs another data directory\'s console is left running', async t => {
  const { dir, paths } = dataDirectory(t);
  const { child } = await startStuckConsole(t, paths.serverPath, join(dir, 'other', 'graph-runtime.json'));
  const outcome = await endUnresponsiveConsole(recorded(child.pid), paths, { health: async () => false, limits: FAST });
  assert.equal(outcome, 'exited');
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test('a process the system cannot show is left running', async t => {
  const { paths } = dataDirectory(t);
  const { child } = await startStuckConsole(t, paths.serverPath, paths.graphRuntimeConfigPath);
  const outcome = await endUnresponsiveConsole(recorded(child.pid), paths, { health: async () => false, limits: FAST,
    owned: (pid, ownedPaths) => consoleProcessOwned(pid, ownedPaths, { inspect: async () => null }) });
  assert.equal(outcome, 'unverified');
  assert.equal(child.exitCode, null);
});

test('a console that answers late is not ended', async t => {
  const { paths } = dataDirectory(t);
  const { child } = await startStuckConsole(t, paths.serverPath, paths.graphRuntimeConfigPath);
  let checks = 0;
  const outcome = await endUnresponsiveConsole(recorded(child.pid), paths, { health: async () => (checks += 1) > 2, limits: FAST });
  assert.equal(outcome, 'answering');
  assert.equal(child.exitCode, null);
});

test('ownership is read from the command line: the server and this data directory\'s runtime config', async () => {
  const commandLine = '"C:\\Program Files\\FULI\\runtime\\node\\node.exe" C:\\FULI\\versions\\0.24.0\\src\\server.js '
    + '--runtime-config C:\\Users\\Someone\\AppData\\Local\\Fuli\\graph-runtime.json --port 2727';
  const inspect = async () => new Map([[41, { commandLine }]]);
  const paths = { graphRuntimeConfigPath: 'c:/users/someone/appdata/local/fuli/graph-runtime.json' };
  assert.equal(await consoleProcessOwned(41, paths, { inspect, platform: 'win32' }), 'owned');
  assert.equal(await consoleProcessOwned(41, paths, { inspect, platform: 'darwin' }), 'other');
  assert.equal(await consoleProcessOwned(42, paths, { inspect, platform: 'win32' }), 'other');
  assert.equal(await consoleProcessOwned(41, { graphRuntimeConfigPath: 'C:\\Users\\Someone\\Other\\graph-runtime.json' },
    { inspect, platform: 'win32' }), 'other');
  const notServer = async () => new Map([[41, { commandLine: 'vim C:\\Users\\Someone\\AppData\\Local\\Fuli\\graph-runtime.json' }]]);
  assert.equal(await consoleProcessOwned(41, paths, { inspect: notServer, platform: 'win32' }), 'other');
  assert.equal(await consoleProcessOwned(41, paths, { inspect: async () => new Map([[41, { commandLine: null }]]) }), 'unknown');
  assert.equal(await consoleProcessOwned(41, {}, { inspect }), 'unknown');
});
