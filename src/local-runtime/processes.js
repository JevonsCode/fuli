import { setTimeout as delay } from 'node:timers/promises';

// Liveness and stop signals for local processes Fuli started or adopted.

// Whether a process with this PID exists. A process of another user (EPERM)
// exists too: only ESRCH means it is gone, so a lock or record held by a
// process started with sudo is never mistaken for an abandoned one.
export function isProcessAlive(pid) {
  return processState(pid) !== 'gone';
}

// Whether a process FULI itself started (a console, a runner, its services)
// still runs. FULI starts them as this user, so a PID now held by another
// user's process is not one of them: such a record is stale, and waiting on it
// would last until the timeout.
export function isOwnProcessRunning(pid) {
  return processState(pid) === 'running';
}

// 'running' (this user's), 'other_user' (exists, not this user's to signal) or 'gone'.
export function processState(pid, { signal = (target) => process.kill(target, 0) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return 'gone';
  try {
    signal(pid);
    return 'running';
  } catch (error) {
    return error?.code === 'EPERM' ? 'other_user' : 'gone';
  }
}

// SIGTERM asks a POSIX process to stop; on Windows any signal ends it at once.
export function stopProcess(pid, signal = 'SIGTERM') {
  try {
    process.kill(pid, signal);
  } catch {
    // Already stopped.
  }
}

// Whether the process ended within timeoutMs.
export async function waitForExit(pid, timeoutMs, { isAlive = isOwnProcessRunning, wait = delay, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!isAlive(pid)) return true;
    await wait(100);
  }
  return !isAlive(pid);
}
