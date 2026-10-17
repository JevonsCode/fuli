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

export function stopProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already stopped.
  }
}
