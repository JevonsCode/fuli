import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import test from 'node:test';

import { installedWindowsFixture as fixture } from './fixtures/windows-installation.js';
import { readWindowsInstallation } from '../src/desktop/windows-installation-context.js';
import { updateWindowsInstallation } from '../src/desktop/windows-update.js';

// Update-Fuli stopped the running FULI with one `cli.js stop` and gave up on
// any non-zero exit. That stop leaves a console it cannot identify in time
// running ("unverified") and exits 1 (root cause: test/data-format-notices.test.js).
// Synthetic installations, recorded state and process identities only:
// nothing here starts, inspects or stops a real process.

// The installed CLI refuses `stop` the first `refusals` times.
function refusingStop(f, refusals, output = {}) {
  let refused = 0;
  return async (root, args) => {
    f.calls.push({ root, args });
    if (args[0] === 'stop' && refused < refusals) { refused += 1; return { code: 1, ...output }; }
    return { code: 0 };
  };
}

// What the running FULI recorded in the data folder, and what Windows reports
// for each PID now. Console 50 runs this installation's own Node and server;
// 51 is an npm FULI serving the same data; 52 is a reused PID. Native
// database 60 still matches its recorded identity; 61 has exited.
function runningFuli(f, consolePid) {
  const config = win32.normalize(join(f.current.dataDir, 'graph-runtime.json'));
  const node = win32.join(f.current.packageRoot, 'runtime', 'node', 'node.exe');
  const observed = {
    50: { pid: 50, createdFileTime: '1', executable: node,
      commandLine: `"${node}" ${win32.join(f.current.packageRoot, 'src', 'server.js')} --runtime-config ${config} --port 2727` },
    51: { pid: 51, createdFileTime: '133000000000000000', executable: 'C:\\Program Files\\nodejs\\node.exe',
      commandLine: `node C:\\Users\\p\\AppData\\Roaming\\npm\\node_modules\\fuli-context\\src\\server.js --runtime-config ${config}` },
    52: { pid: 52, createdFileTime: '3', executable: 'C:\\Windows\\notepad.exe', commandLine: 'notepad.exe' }
  };
  const ownership = { pid: 60, executable: 'java.exe', createdFileTime: '4', commandLine: 'java' };
  writeFileSync(join(f.current.dataDir, 'graph-runtime-state.json'), JSON.stringify({ version: 4, pid: consolePid, url: 'http://127.0.0.1:2727' }));
  mkdirSync(join(f.current.dataDir, 'native-runtime'), { recursive: true });
  writeFileSync(join(f.current.dataDir, 'native-runtime', 'processes.json'), JSON.stringify({ version: 1, mode: 'native',
    databases: { personal: { pid: 60, command: 'java.exe', ownership }, workspace: { pid: 61, command: 'java.exe', ownership } },
    providers: {} }));
  const stopped = [];
  const stopping = { ...f.deps.stopping, alive: pid => pid !== 61, inspect: async pid => observed[pid] ?? null,
    matches: async (pid, command, entry) => pid === 60 && command === 'java.exe' && entry.ownership.createdFileTime === '4',
    stopProcess: async (pid, entry) => { stopped.push([pid, entry]); } };
  return { observed, stopped, stopping };
}

test('a refused stop is tried once more before anything else, as a manual stop afterwards succeeded', async t => {
  const f = fixture(t); let waits = 0;
  const next = await updateWindowsInstallation(f.options, { ...f.deps, runCli: refusingStop(f, 1),
    stopping: { wait: async () => { waits += 1; }, inspect: async () => assert.fail('the second stop succeeded') } });
  assert.equal(readWindowsInstallation(next.packageRoot).applicationVersion, '0.12.5');
  assert.deepEqual(f.calls.slice(0, 3).map(call => call.args[0]), ['stop', 'stop', 'start']);
  assert.equal(waits, 1);
});

test('this installation\'s own console and graph database, still running after two refused stops, are stopped by handle', async t => {
  const f = fixture(t);
  const { observed, stopped, stopping } = runningFuli(f, 50);
  const next = await updateWindowsInstallation(f.options, { ...f.deps, runCli: refusingStop(f, 2), stopping });
  assert.deepEqual(stopped.map(([pid]) => pid), [50, 60]);
  assert.deepEqual(stopped[0][1], { command: observed[50].executable, ownership: observed[50] });
  assert.equal(stopped[1][1].ownership.createdFileTime, '4');
  // The third stop clears the stale console state and stops the rest.
  assert.deepEqual(f.calls.slice(0, 4).map(call => call.args[0]), ['stop', 'stop', 'stop', 'start']);
  assert.equal(readWindowsInstallation(next.packageRoot).applicationVersion, '0.12.5');
});

test('a FULI console this installation did not start blocks the switch by PID and program until the person picks it', async t => {
  const f = fixture(t);
  const { stopped, stopping } = runningFuli(f, 51);
  const blocked = await updateWindowsInstallation(f.options, { ...f.deps, runCli: refusingStop(f, 2), stopping })
    .then(() => assert.fail('must be blocked'), error => error);
  assert.equal(blocked.code, 'fuli_processes_running');
  assert.equal(blocked.message, 'Another Fuli program runs on this data folder, so nothing was switched: '
    + 'console PID 51 (C:\\Program Files\\nodejs\\node.exe)');
  assert.deepEqual(blocked.blockers, [{ role: 'console', pid: 51, createdFileTime: '133000000000000000',
    executable: 'C:\\Program Files\\nodejs\\node.exe' }]);
  assert.deepEqual(stopped, [], 'nothing is stopped while another program blocks the switch');
  assert.equal(readdirSync(join(f.current.installRoot, 'versions')).length, 1);
  assert.equal(readWindowsInstallation(f.current.packageRoot).applicationVersion, '0.12.4');

  // The pick names the PID and its creation time; the same PID started again does not match.
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, runCli: refusingStop(f, 2),
    stopping: { ...stopping, stopPids: ['51:1'] } }), /Another Fuli program/);
  const next = await updateWindowsInstallation(f.options, { ...f.deps, runCli: refusingStop(f, 2),
    stopping: { ...stopping, stopPids: ['51:133000000000000000'] } });
  assert.deepEqual(stopped.map(([pid]) => pid), [51, 60]);
  assert.equal(readWindowsInstallation(next.packageRoot).applicationVersion, '0.12.5');
});

test('at the terminal the person is asked about a FULI console this installation did not start', async t => {
  const f = fixture(t); const asked = [];
  const { stopping } = runningFuli(f, 51);
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, runCli: refusingStop(f, 2),
    stopping: { ...stopping, stopProcess: async () => assert.fail('declined'),
      confirmStop: async blockers => { asked.push(blockers.map(b => b.pid)); return false; } } }), /Another Fuli program/);
  assert.deepEqual(asked, [[51]]);
});

test('a reused PID is never stopped; with nothing of FULI\'s still running the refusal names the stop\'s own first line', async t => {
  const f = fixture(t);
  const { stopping } = runningFuli(f, 52);
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps,
    runCli: refusingStop(f, 3, { stdout: 'The local Fuli Provider stopped, but the unverified UI process was left running.\nRun fl status to inspect it.\n' }),
    stopping: { ...stopping, matches: async () => false, stopProcess: async () => assert.fail('nothing of FULI\'s runs') } }),
  error => error.message === 'The running Fuli could not be stopped; nothing was switched. '
    + 'The local Fuli Provider stopped, but the unverified UI process was left running.');
  assert.equal(readWindowsInstallation(f.current.packageRoot).applicationVersion, '0.12.4');
  assert.equal(JSON.parse(readFileSync(join(f.current.dataDir, 'graph-runtime-state.json'))).pid, 52, 'recorded state is only read');
});
