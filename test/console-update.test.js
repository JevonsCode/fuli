import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleApiRequest } from '../src/http/api-router.js';
import { FULI_VERSION } from '../src/package-metadata.js';
import { consoleUpdate, runConsoleUpdate } from '../src/system/console-update.js';

// The console's one-click update: the same update `fuli update --yes` runs,
// in a detached worker because it stops the console. Synthetic data
// directories only; no package is installed and nothing is stopped.

function dataDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-console-update-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeWorker(spawned) {
  return (command, args, options) => { spawned.push({ command, args, options }); return { pid: 4343, once() {}, unref() {} }; };
}

test('the console starts the update in a detached worker and refuses a second one meanwhile', (t) => {
  const root = dataDir(t);
  const spawned = [];
  const update = consoleUpdate(root, { platform: 'linux', spawnWorker: fakeWorker(spawned) });
  assert.equal(update.kind(), 'npm');
  assert.equal(update.status(), null);
  const started = update.start();
  assert.deepEqual({ status: started.status, fromVersion: started.fromVersion }, { status: 'updating', fromVersion: FULI_VERSION });
  assert.match(spawned[0].args[0], /console-update-worker\.js$/);
  assert.deepEqual(spawned[0].args.slice(1), [root, started.id]);
  assert.equal(spawned[0].options.detached, true);
  assert.throws(() => update.start(), /already running/);
});

const TRAY = { kind: 'windows-user-installation', installRoot: 'C:\\Users\\p\\AppData\\Local\\Programs\\Fuli',
  packageRoot: 'C:\\Users\\p\\AppData\\Local\\Programs\\Fuli\\versions\\a', dataDir: 'C:\\Users\\p\\AppData\\Local\\Fuli' };

test('a Windows per-user installation updates from the release\'s tray package, to the newer version found', (t) => {
  const root = dataDir(t);
  const spawned = [];
  const update = consoleUpdate(root, { platform: 'win32', installation: () => TRAY, spawnWorker: fakeWorker(spawned) });
  assert.equal(update.kind(), 'windows-tray');
  assert.throws(() => update.start({ version: null }), /No newer FULI version/);
  assert.equal(spawned.length, 0);
  const started = update.start({ version: '99.0.0' });
  assert.deepEqual({ kind: started.kind, targetVersion: started.targetVersion, status: started.status },
    { kind: 'windows-tray', targetVersion: '99.0.0', status: 'updating' });
  assert.equal(spawned.length, 1);
});

test('the tray worker journals each real step, the new version, and nothing about the console it stopped', async (t) => {
  const root = dataDir(t);
  const update = consoleUpdate(root, { platform: 'win32', installation: () => TRAY, spawnWorker: fakeWorker([]) });
  const { id } = update.start({ version: '99.0.0' });
  const steps = [];
  await runConsoleUpdate({ dataDir: root }, id, { env: {}, installation: () => TRAY,
    update: async () => assert.fail('a tray installation never runs the npm update'),
    updateTray: async ({ installation, version, stopPids, progress }) => {
      assert.deepEqual({ installation, version, stopPids }, { installation: TRAY, version: '99.0.0', stopPids: [] });
      for (const step of ['downloading', 'verifying', 'exitingTray', 'installing']) { progress(step); steps.push(update.status().step); }
      return { status: 'updated', version: '99.0.0' };
    },
    control: { consoleRunning: async () => assert.fail('the update started it'), start: async () => assert.fail('the update started it') } });
  assert.deepEqual(steps, ['downloading', 'verifying', 'exitingTray', 'installing']);
  assert.deepEqual({ status: update.status().status, version: update.status().version }, { status: 'updated', version: '99.0.0' });
});

test('a tray update blocked by a FULI process names it, and only that process may be picked to stop on the next try', async (t) => {
  const root = dataDir(t);
  const spawned = [];
  const update = consoleUpdate(root, { platform: 'win32', installation: () => TRAY, spawnWorker: fakeWorker(spawned) });
  const { id } = update.start({ version: '99.0.0' });
  const blockers = [{ role: 'console', pid: 40, createdFileTime: '133', executable: 'C:\\Program Files\\nodejs\\node.exe' }];
  await runConsoleUpdate({ dataDir: root }, id, { env: {}, installation: () => TRAY,
    updateTray: async () => { throw Object.assign(new Error('Another Fuli program runs on this data folder, so nothing was switched: console PID 40'), { blockers }); },
    control: { consoleRunning: async () => true, start: async () => assert.fail('it is running') } });
  const failed = update.status();
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.blockers, blockers);
  assert.equal(failed.started, true);

  assert.throws(() => update.start({ version: '99.0.0', stopProcesses: ['41:133'] }), /only processes the last update reported/);
  const retry = update.start({ version: '99.0.0', stopProcesses: ['40:133'] });
  assert.equal(retry.status, 'updating');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'console-update.json'), 'utf8')).stopPids, ['40:133']);
  assert.equal(spawned.length, 2);
});

test('the worker runs the update and journals the new version', async (t) => {
  const root = dataDir(t);
  const update = consoleUpdate(root, { platform: 'linux', spawnWorker: fakeWorker([]) });
  const { id } = update.start();
  const calls = [];
  await runConsoleUpdate({ dataDir: root }, id, { env: {},
    update: async (args) => { calls.push(args); return { status: 'updated', previousVersion: FULI_VERSION, version: '99.0.0' }; },
    control: { consoleRunning: async () => assert.fail('not checked after a success'), start: async () => assert.fail('setup starts it') } });
  assert.deepEqual(calls, [['--yes', '--data-dir', root]]);
  assert.deepEqual({ status: update.status().status, version: update.status().version }, { status: 'updated', version: '99.0.0' });
});

test('a failed update keeps only its first line, never a command, and starts FULI again', async (t) => {
  const root = dataDir(t);
  const update = consoleUpdate(root, { platform: 'linux', spawnWorker: fakeWorker([]) });
  const { id } = update.start();
  const events = [];
  await runConsoleUpdate({ dataDir: root }, id, { env: {},
    update: async () => { throw new Error('Global package installation failed (exit code 1). Knowledge data was not deleted.\n'
      + 'Local services were stopped and have not been restarted.\nRun npm install --global fuli-context@99.0.0, then run fuli setup.'); },
    control: { consoleRunning: async () => { events.push('running?'); return false; }, start: async () => { events.push('start'); } } });
  const status = update.status();
  assert.equal(status.status, 'failed');
  assert.equal(status.error, 'Global package installation failed (exit code 1). Knowledge data was not deleted.');
  assert.equal(status.started, true);
  assert.deepEqual(events, ['running?', 'start']);
});

test('the update route reads the state from anywhere the console serves, and starts only from this computer', async () => {
  const sent = [];
  const response = { setHeader() {}, writeHead(status) { sent.push(status); return this; }, end(body) { sent.push(JSON.parse(body)); } };
  let starts = 0;
  const inputs = [];
  const system = { updateStatus: () => null,
    startUpdate: async (input) => { starts += 1; inputs.push(input); return { id: 'u1', status: 'updating' }; } };
  const request = (method, remoteAddress, body = '') => ({ method, url: '/api/system/update', headers: {}, socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } });
  await handleApiRequest({ request: request('GET', '127.0.0.1'), response, app: {}, system });
  await handleApiRequest({ request: request('POST', '192.168.1.20'), response, app: {}, system });
  await handleApiRequest({ request: request('POST', '127.0.0.1', '{"stopProcesses":["40:133"]}'), response, app: {}, system });
  assert.deepEqual(sent, [200, { update: null }, 403, { error: 'FULI is updated only on this computer', code: 'local_user_only' },
    200, { id: 'u1', status: 'updating' }]);
  assert.equal(starts, 1);
  assert.deepEqual(inputs, [{ stopProcesses: ['40:133'] }]);
});
