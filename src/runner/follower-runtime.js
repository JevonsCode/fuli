import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { openChildProcessLog } from '../local-runtime/child-process-log.js';
import { externalOpenInvocation } from '../local-runtime/lifecycle.js';
import { isProcessAlive, waitForExit } from '../local-runtime/processes.js';
import { startFollowerConsole, STATUS_PATH } from './follower-console.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { createHostConnection } from './host-connection.js';
import { FULI_VERSION } from '../package-metadata.js';
import { mcpSessionsLine } from './protocol.js';
import { createRunnerClients } from './runner-clients.js';
import { versionSkew, versionSkewLine } from './version-skew.js';
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
    return ours
      ? { status: 'running', role: 'runner', url, pid: state.pid, version: state.version ?? FULI_VERSION,
        host: state.host, outbox: state.outbox }
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
    if (isProcessAlive(state.pid)) process.kill(state.pid, 'SIGTERM');
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

// What each runner command prints.
export function formatFollowerResult(command, result) {
  if (command === 'stop') return result.console === 'not_running' ? 'The runner console was not running.'
    : result.status === 'partial' ? 'The runner console did not stop in time; run fl status.' : 'The runner console stopped.';
  if (command === 'open') return `Opened: ${result.url}`;
  const host = result.host ? `${result.host.name}, ${result.host.reachable ? 'answering' : 'not reachable now'}` : 'not paired';
  const lines = [result.status === 'stopped' ? 'This computer is a runner; its console is not running.'
    : `This computer is a runner. Console: ${result.url} (the host's FULI; 客户端接入 lists this computer's clients)`,
  ...(result.status === 'stopped' ? [] : [`Host: ${host}`,
    ...(result.host?.mcpSessions ? [mcpSessionsLine(result.host.mcpSessions)] : []),
    ...(skewLine(result) ? [skewLine(result)] : []), `Outbox: ${result.outbox ?? 0} waiting.`])];
  return lines.join('\n');
}

// The host and this runner on different FULI versions (rec#144): said, never enforced.
function skewLine(result) {
  const skew = versionSkew({ hostVersion: result.host?.version ?? null, runnerVersion: result.version ?? FULI_VERSION });
  return skew ? versionSkewLine(skew, result.host?.name ?? null) : null;
}

// This runner's host as it is now, for its own 客户端接入 page.
export async function pairedHost(store, connection) {
  const host = store.host();
  if (!host) return null;
  const reached = await connection.connect();
  const hello = reached ? await connection.hello() : null;
  return { name: host.name, reachable: Boolean(reached), version: hello?.version ?? null };
}

// The long-running process `fuli runner console` starts.
export async function serveFollowerConsole({ dataDir, port }) {
  const store = new RunnerStore(join(dataDir, RUNNER_FILE));
  const identity = await loadDeviceIdentity(join(dataDir, 'peer'));
  const connection = createHostConnection({ store, identity });
  const served = await startFollowerConsole({ dataDir, port, store, connection,
    clients: createRunnerClients({ paths: resolveSetupPaths({ dataDir }), host: () => pairedHost(store, connection) }) });
  let closing = null;
  const close = () => closing ??= served.close().finally(() => {
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
