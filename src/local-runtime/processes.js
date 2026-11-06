import { setTimeout as delay } from 'node:timers/promises';

// Liveness and stop signals for local processes Fuli started or adopted.

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
export async function waitForExit(pid, timeoutMs, { isAlive = isProcessAlive, wait = delay, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!isAlive(pid)) return true;
    await wait(100);
  }
  return !isAlive(pid);
}
