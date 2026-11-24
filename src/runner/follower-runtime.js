import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { openChildProcessLog } from '../local-runtime/child-process-log.js';
import { externalOpenInvocation } from '../local-runtime/lifecycle.js';
import { isOwnProcessRunning, stopProcess, waitForExit } from '../local-runtime/processes.js';
import { LOCAL_PATH, startFollowerConsole, STATUS_PATH } from './follower-console.js';
import { localRuntimeLine, localRuntimeStep, localSpaceLine, prepareInBackground, readRecord } from './follower-local-runtime.js';
import { followerStatus, SAME_NETWORK_LIMIT } from './follower-status.js';
import { globalCopyLine } from './global-copy-state.js';
import { startGlobalSync } from './global-sync.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { createHostConnection } from './host-connection.js';
import { followerReport } from './host-space.js';
import { mcpSessionsLine } from './protocol.js';
import { createRunnerClients } from './runner-clients.js';
import { versionSkewLine } from './version-skew.js';
import { RUNNER_FILE, RunnerStore } from './runner-store.js';

// `fuli start | stop | restart | status | open` on a runner (docs/runner.md):
// there is no graph runtime to start, only the console entry
// (follower-console.js), a detached process of `fuli runner console` that
// FULI.app and the CLI manage as they manage a console. Which process it is
// comes from its own status answer (its pid and data directory), so nothing is
// recorded beside it and nothing else is ever stopped.
const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));
const READY_WITHIN_MS = 10_000;
const STOP_WITHIN_MS = 5_000;
const LOG_FILE = join('logs', 'runner-console.log');

export function followerRuntimeHandlers({ execPath = process.execPath, fetchImpl = fetch,
  spawnProcess = spawn, openExternal = openInBrowser } = {}) {
  const urlOf = (input) => `http://127.0.0.1:${input.port}`;
  async function inspect(input) {
    const url = urlOf(input);
    let state = null;
    try {
      const answer = await fetchImpl(`${url}${STATUS_PATH}`, { signal: AbortSignal.timeout(6000) });
      state = answer.ok ? await answer.json() : null;
    } catch { state = null; }
    const ours = state?.kind === 'fuli-runner-console' && state.dataDir === input.paths.dataDir;
    // The console entry's own answer is the one description of where this
    // computer stands (follower-status.js), so `fuli status` never disagrees
    // with the console or with a client's calls about the host being reachable.
    return ours
      ? { status: 'running', role: 'runner', url, pid: state.pid, host: state.host, outbox: state.outbox,
        capabilities: state.capabilities, line: state.line, ...(state.versions ? { versions: state.versions } : {}),
        ...(state.localRuntime ? { localRuntime: state.localRuntime } : {}),
        ...(state.globalCopy ? { globalCopy: state.globalCopy } : {}),
        ...(state.projects !== undefined ? { projects: state.projects } : {}) }
      : { status: 'stopped', role: 'runner', url };
  }
  async function start(input) {
    const before = await inspect(input);
    if (before.status === 'running') return before;
    const log = openChildProcessLog(join(input.paths.dataDir, LOG_FILE));
    const child = spawnProcess(execPath, [CLI_PATH, 'runner', 'console', '--data-dir', input.paths.dataDir,
      '--port', String(input.port)], { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    child.unref();
    for (const deadline = Date.now() + READY_WITHIN_MS; Date.now() < deadline; await delay(250)) {
      const state = await inspect(input);
      if (state.status === 'running') {
        if (input.open === true) await openExternal(state.url);
        return { ...state, status: 'started' };
      }
    }
    throw new Error(`The runner console did not start; see ${LOG_FILE} in the data directory.`);
  }
  async function stop(input) {
    const state = await inspect(input);
    if (state.status !== 'running') return { status: 'stopped', role: 'runner', console: 'not_running' };
    if (isOwnProcessRunning(state.pid)) stopProcess(state.pid);
    if (!await waitForExit(state.pid, STOP_WITHIN_MS)) return { status: 'partial', role: 'runner', console: 'running' };
    return { status: 'stopped', role: 'runner', console: 'stopped' };
  }
  return {
    status: inspect,
    start,
    stop,
    async restart(input) {
      await stop(input);
      return start(input);
    },
    async open(input) {
      const state = await inspect(input);
      if (state.status !== 'running') throw new Error('The runner console is not running. Run fl start first.');
      await openExternal(state.url);
      return { status: 'opened', url: state.url };
    }
  };
}

// What each runner command prints: the same facts the console shows, from the
// same answer (follower-status.js).
export function formatFollowerResult(command, result) {
  if (command === 'stop') return result.console === 'not_running' ? 'The runner console was not running.'
    : result.status === 'partial' ? 'The runner console did not stop in time; run fl status.' : 'The runner console stopped.';
  if (command === 'open') return `Opened: ${result.url}`;
  if (result.status === 'stopped') return 'This computer follows a FULI host; its console is not running.';
  return [`This computer follows a FULI host. Console: ${result.url} (this computer's own state at ${result.url}${LOCAL_PATH})`,
    result.line ? result.line.en : 'Host: not known',
    ...(result.host?.mcpSessions ? [mcpSessionsLine(result.host.mcpSessions)] : []),
    // The host and this computer on different FULI versions (rec#144): said, never enforced.
    ...(result.versions?.skew ? [versionSkewLine(result.versions.skew, result.host?.name ?? null)] : []),
    ...ownSideLines(result),
    ...capabilityLines(result.capabilities)].join('\n');
}

// This computer's own runtime, and which computer each project it knows of
// belongs to now (step 3a), from the same answer the console shows.
export function ownSideLines({ localRuntime, globalCopy, projects }) {
  const lines = [];
  const runtime = localRuntimeLine(localRuntime);
  if (runtime) lines.push(runtime.en);
  const space = localSpaceLine(localRuntime);
  if (space) lines.push(space.en);
  const copy = globalCopyLine(globalCopy);
  if (copy) lines.push(copy.en);
  const step = localRuntime ? localRuntimeStep(localRuntime) : null;
  if (step && localRuntime.state !== 'preparing') lines.push(`  ${step}`);
  if (Array.isArray(projects) && projects.length) {
    lines.push('Projects and the computer each belongs to / 项目归哪台电脑:');
    for (const project of projects) {
      lines.push(`  ${project.scope}  ${project.where === 'local' ? '本机 / this computer' : `主机 ${project.ownerName} / host ${project.ownerName}`}`
        + (project.byDefault ? ' (as new folders go / 按默认)' : ''));
    }
  }
  return lines;
}

// Which capability runs where, and what it does while the host is away: the
// table rec#144 asked for, from the same list the console shows.
export function capabilityLines(capabilities) {
  if (!capabilities?.length) return [];
  return ['What runs where / 什么跑在哪里:',
    ...capabilities.map((capability) => `  ${WHERE_LABEL[capability.where] ?? WHERE_LABEL.host}`
      + `${capability.syncedAt ? ` (synced ${capability.syncedAt})` : ''}`
      + ` · ${OFFLINE_LABEL[capability.offline]} — ${capability.en}`),
    `  ${SAME_NETWORK_LIMIT.en}`];
}

// The three answers to whose data it is (docs/runner-roles-design.md §3).
const WHERE_LABEL = { host: 'the host', local: 'this computer', replica: 'a read-only copy here' };

const OFFLINE_LABEL = { cached: 'offline: the answer kept here', queued: 'offline: queued for the host',
  works: 'offline: works', unavailable: 'offline: not available' };

// The long-running process `fuli runner console` starts.
export async function serveFollowerConsole({ dataDir, port }) {
  const store = new RunnerStore(join(dataDir, RUNNER_FILE));
  const identity = await loadDeviceIdentity(join(dataDir, 'peer'));
  // Its hello says this computer's versions, its graph's as its own Provider last said them (host-space.js).
  const connection = createHostConnection({ store, identity, report: () => followerReport(readRecord(dataDir)?.formats) });
  const served = await startFollowerConsole({ dataDir, port, store, connection,
    clients: createRunnerClients({ paths: resolveSetupPaths({ dataDir }), status: () => followerStatus({ store, connection, dataDir }) }) });
  // This computer's own runtime, prepared in the background the first time this version starts here
  // (docs/runner-roles-design.md §10): nothing for the person to do, and nothing routed to it yet.
  try { prepareInBackground({ dataDir }); } catch { /* said as not prepared; the next start tries again */ }
  // The host's `global` copied into this computer's graph while its runtime runs anyway, and a copy still owed
  // left to the preparation (global-sync.js): Neo4j is started for it only once the host answers, never in a loop.
  const sync = startGlobalSync({ dataDir, store, connection });
  let closing = null;
  const close = () => closing ??= served.close().finally(() => {
    sync.close();
    connection.close();
    store.close();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close());
  return { url: served.url, close };
}

async function openInBrowser(url) {
  const invocation = externalOpenInvocation(url);
  spawn(invocation.command, invocation.args, { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}
