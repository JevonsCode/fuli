import { win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isProcessAlive } from '../local-runtime/processes.js';
import { inspectWindowsNativeProcess, stopWindowsNativeProcess, windowsNativeProcessMatches } from '../native-runtime/windows-processes.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { readJsonFile } from '../storage/json-file.js';

// Stopping the installed FULI before an update or rollback switches its
// program. The installed CLI's `stop` decides what it owns: it stops the
// console only after the console answers /api/health with its recorded PID
// within a few seconds. A console busy inspecting its stores (older versions
// scan every store on that request and can wait seconds on another process's
// SQLite lock) is left running as "unverified" and `stop` exits 1. So: try
// twice, then look at the processes FULI recorded for this data directory
// that still run. Those proven to be this installation's own are stopped by
// handle; a FULI console from another program is stopped only when the
// person picked it (PID and creation time), and otherwise blocks the switch
// with its PID and program named.

// After a refused stop the console has cached its store inspection for ten seconds.
const STOP_RETRY_DELAY_MS = 3000;
const STOP_FAILED = 'The running Fuli could not be stopped; nothing was switched.';

class WindowsUpdateBlockedError extends Error {
  constructor(blockers) {
    super('Another Fuli program runs on this data folder, so nothing was switched: '
      + blockers.map(describeProcess).join('; '));
    this.code = 'fuli_processes_running';
    this.blockers = blockers.map(({ role, pid, createdFileTime, executable }) => ({ role, pid, createdFileTime, executable }));
  }
}

const ROLE_NAMES = { console: 'console', database: 'graph database', provider: 'graph Provider' };
const describeProcess = ({ role, pid, executable }) => `${ROLE_NAMES[role]} PID ${pid} (${executable ?? 'unknown program'})`;

// confirmStop(blockers): the person's answer for a FULI console this
// installation did not start; stopPids: those picked earlier as "PID:created".
// inspect, matches and alive read Windows processes (recordedFuliProcesses).
export async function stopInstalledFuli(plan, { runCli, write, wait = delay, stopProcess = stopWindowsNativeProcess,
  confirmStop = async () => false, stopPids = [], ...processes }) {
  const { current } = plan;
  const stop = () => runCli(current.packageRoot, ['stop', '--data-dir', current.dataDir]);
  let result = await stop();
  if (result.code === 0) return;
  write('The running Fuli did not confirm the stop; trying again...');
  await wait(STOP_RETRY_DELAY_MS);
  result = await stop();
  if (result.code === 0) return;
  const running = await recordedFuliProcesses(current, plan.installRoot, processes);
  if (!running.length) throw new Error(STOP_FAILED + reasonOf(result));
  const picked = new Set(stopPids);
  const others = running.filter(item => !item.owned && !picked.has(item.pid + ':' + item.createdFileTime));
  if (others.length && !await confirmStop(others)) throw new WindowsUpdateBlockedError(others);
  for (const item of running) {
    write('Stopping the Fuli ' + describeProcess(item) + '...');
    await stopProcess(item.pid, item.stopEntry);
  }
  // The stopped console's state is stale now; this stop clears it and stops the rest.
  result = await stop();
  if (result.code !== 0) throw new Error(STOP_FAILED + reasonOf(result));
}

// The stop's own first line (its error, or why it left the console running).
// `stop` prints no access code; the lines after the first are terminal advice.
function reasonOf(result) {
  const line = String(result.stderr || result.stdout || '').trim().split(/\r?\n/)[0];
  return line ? ' ' + line.slice(0, 300) : '';
}

// The FULI processes recorded for this data directory that still run, with
// the identity Windows reports now. A console counts when it runs a FULI
// server with this data directory's runtime configuration; it is owned when
// that server and its Node are a version kept under this installation root.
// A native service counts only while it matches its recorded identity (a
// reused PID is someone else's process). stopEntry is what stopping it by
// handle verifies again.
async function recordedFuliProcesses(current, installRoot, {
  inspect = inspectWindowsNativeProcess, matches = windowsNativeProcessMatches, alive = isProcessAlive
} = {}) {
  const paths = resolveSetupPaths({ dataDir: current.dataDir });
  const found = [];
  const state = readJsonFile(paths.graphRuntimeStatePath, null);
  if (Number.isInteger(state?.pid) && alive(state.pid)) {
    const observed = await inspect(state.pid);
    const program = observed ? fuliConsoleProgram(observed, paths.graphRuntimeConfigPath) : null;
    if (program !== null) {
      found.push({ role: 'console', pid: state.pid, createdFileTime: observed.createdFileTime, executable: observed.executable,
        owned: program !== '' && insideVersions(program, installRoot), stopEntry: { command: observed.executable, ownership: observed } });
    }
  }
  const processes = readJsonFile(paths.nativeProcessStatePath, null) ?? {};
  for (const [role, entries] of [['provider', processes.providers], ['database', processes.databases]]) {
    for (const entry of Object.values(entries ?? {})) {
      if (!Number.isInteger(entry?.pid) || typeof entry.command !== 'string' || !alive(entry.pid)) continue;
      if (!await matches(entry.pid, entry.command, entry)) continue;
      found.push({ role, pid: entry.pid, createdFileTime: entry.ownership.createdFileTime, executable: entry.ownership.executable,
        owned: true, stopEntry: entry });
    }
  }
  return found;
}

// For a FULI server with this runtime configuration: the package directory
// whose own Node runs it, or '' for another FULI (an npm install, a portable
// folder) serving the same data. null for any other process.
function fuliConsoleProgram(observed, runtimeConfigPath) {
  const executable = win32.normalize(String(observed.executable ?? '')).toLowerCase();
  const nodeSuffix = win32.join('runtime', 'node', 'node.exe');
  const commandLine = String(observed.commandLine ?? '').toLowerCase();
  if (!commandLine.includes(win32.normalize(runtimeConfigPath).toLowerCase())) return null;
  const packageRoot = executable.endsWith('\\' + nodeSuffix) ? executable.slice(0, -nodeSuffix.length - 1) : null;
  if (packageRoot && commandLine.includes(win32.join(packageRoot, 'src', 'server.js'))) return packageRoot;
  return /[\\/]src[\\/]server\.js\b/.test(commandLine) ? '' : null;
}

function insideVersions(packageRoot, installRoot) {
  return win32.dirname(packageRoot) === win32.join(win32.normalize(installRoot), 'versions').toLowerCase();
}
