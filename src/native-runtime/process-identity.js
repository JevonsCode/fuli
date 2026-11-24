import { execFile } from 'node:child_process';

import { processState } from '../local-runtime/processes.js';

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

// How a recorded holder is checked against the OS; tests pass their own.
export const PROCESS_IDENTITY = Object.freeze({ state: processState, startTime: processStartTime, matches: processMatchesCommand });

// This process as `ps` shows it, so a later reader can tell it from a stranger with its PID.
export async function currentProcessIdentity() {
  const [command, startedAt] = await Promise.all([processCommand(process.pid), processStartTime(process.pid)]);
  return { pid: process.pid, command, startedAt };
}

// A recorded holder ({ pid, startedAt?, command? }) is 'running', 'gone'
// (ended, or its PID is now another program) or 'unknown' (none recorded).
// A holder `ps` cannot read (Windows, a stopped ps) counts as running:
// nothing is taken over on a guess.
export async function recordedProcessState(holder, identity = PROCESS_IDENTITY) {
  if (!holder) return 'unknown';
  if (identity.state(holder.pid) === 'gone') return 'gone';
  if (typeof holder.startedAt === 'string' && typeof holder.command === 'string') {
    const [startedAt, sameCommand] = await Promise.all([identity.startTime(holder.pid), identity.matches(holder.pid, holder.command)]);
    if (startedAt !== null && (startedAt !== holder.startedAt || !sameCommand)) return 'gone';
  }
  return 'running';
}
