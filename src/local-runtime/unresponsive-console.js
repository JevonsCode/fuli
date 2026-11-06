import { setTimeout as delay } from 'node:timers/promises';

import { createProcessInspector } from '../agent-services/process-identity.js';
import { checkLocalConsoleHealth } from './console-health.js';
import { isProcessAlive, stopProcess, waitForExit } from './processes.js';

// Ending the recorded FULI console when it has to go: a start replacing an
// older one, a stop, or a console that stays alive without answering (rec#94:
// after SIGTERM its listener closed but the process kept running, so every
// start refused and no session restarted it). A console that answers as
// itself is ended by its PID; one that does not answer only when the OS shows
// it running FULI's server with this data directory's runtime config, so a
// reused PID or another program is never ended.

export const CONSOLE_STOP_LIMITS = Object.freeze({
  // A busy console may answer late; one shutting down exits meanwhile.
  answerWaitMs: 10_000,
  pollMs: 500,
  // The console ends its own shutdown within 10 s (server/signal-shutdown.js).
  termWaitMs: 12_000,
  killWaitMs: 5_000
});

// SIGTERM, then SIGKILL if it is still running after the console's own
// shutdown deadline. Whether it ended.
export async function terminateConsole(pid, overrides = {}) {
  const deps = dependencies(overrides);
  deps.signal(pid, 'SIGTERM');
  if (await deps.waitForExit(pid, deps.limits.termWaitMs)) return true;
  // Alive at every poll since the SIGTERM, so still the same process.
  deps.signal(pid, 'SIGKILL');
  return deps.waitForExit(pid, deps.limits.killWaitMs);
}

// A recorded console whose process is alive but did not answer:
// exited (gone, or its PID now runs another program) | answering | stopped
// | unverified (the OS could not show the process) | still_running.
export async function endUnresponsiveConsole(state, paths, overrides = {}) {
  const deps = dependencies(overrides);
  const deadline = deps.now() + deps.limits.answerWaitMs;
  for (;;) {
    if (!deps.isAlive(state.pid)) return 'exited';
    if (await deps.health(state.url, state.pid, state.version)) return 'answering';
    if (deps.now() >= deadline) break;
    await deps.wait(deps.limits.pollMs);
  }
  const owner = await deps.owned(state.pid, paths);
  if (owner === 'other' || !deps.isAlive(state.pid)) return 'exited';
  if (owner !== 'owned') return 'unverified';
  return await terminateConsole(state.pid, deps) ? 'stopped' : 'still_running';
}

// Whether the OS shows pid running this data directory's console, whose
// command line runs FULI's server.js with this data directory's runtime
// config (from any installed version): owned | other | unknown.
export async function consoleProcessOwned(pid, paths, {
  inspect = pids => createProcessInspector().inspect(pids), platform = process.platform
} = {}) {
  const configPath = paths?.graphRuntimeConfigPath;
  if (typeof configPath !== 'string' || !configPath) return 'unknown';
  const found = await inspect([pid]);
  if (!found) return 'unknown';
  if (!found.has(pid)) return 'other';
  const commandLine = found.get(pid).commandLine;
  if (typeof commandLine !== 'string' || !commandLine) return 'unknown';
  // Windows paths compare without case and separator differences.
  const fold = platform === 'win32' ? value => value.replaceAll('/', '\\').toLowerCase() : value => value;
  const line = fold(commandLine);
  return /server\.js\b/.test(line) && line.includes(fold(configPath)) ? 'owned' : 'other';
}

function dependencies(overrides) {
  const deps = { isAlive: isProcessAlive, health: checkLocalConsoleHealth, owned: consoleProcessOwned,
    signal: stopProcess, wait: delay, now: Date.now, limits: CONSOLE_STOP_LIMITS, ...overrides };
  deps.waitForExit ??= (pid, timeoutMs) => waitForExit(pid, timeoutMs, { isAlive: deps.isAlive, wait: deps.wait, now: deps.now });
  return deps;
}
