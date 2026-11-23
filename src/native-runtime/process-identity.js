import { execFile } from 'node:child_process';

// Whether a recorded PID is still the process FULI recorded, as `ps` shows it.
// A PID the system has since given to another program does not match, so a
// record is never kept alive by a stranger that happens to reuse its number.

function psField(pid, field) {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', `${field}=`], { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout.trim() || null));
  });
}

// The recorded command is part of the running one (native services record their executable).
export async function processMatchesCommand(pid, command) {
  const running = await psField(pid, 'command');
  return running !== null && running.includes(command);
}

// When the process started, as `ps` prints it; null when it is not running or
// cannot be read. Two reads of the same process give the same text.
export function processStartTime(pid) {
  return psField(pid, 'lstart');
}

// The full command line of a running process, or null.
export function processCommand(pid) {
  return psField(pid, 'command');
}
