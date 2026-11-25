import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isOwnProcessRunning } from '../local-runtime/processes.js';
import { acquireFileLock } from '../storage/file-lock.js';
import { readJsonFile, writeTextFileAtomic } from '../storage/json-file.js';

// The first project made this computer's needs this computer's graph running
// before any project is routed here (make-project-local.js step 3), while the
// follower console starts that graph only for a computer that owns a project
// (follower-runtime.js). This file says a project is being made: the console
// starts its graph for it as for an owned one, and the process making it (the
// console itself, `fuli routes local`, or the follower's MCP entry for the
// person's AI) waits until that graph answers. A file, so all three ask the
// one console the same way; one left behind by an ended process counts only
// while fresh, and the console then stops the graph by itself again.
export const MAKING_PROJECT_MARKER = join('runner', 'making-project');
const MAKING_FRESH_MS = 10 * 60_000;
// How long the maker waits for the console to have started this computer's graph.
export const RUNTIME_WAIT_MS = 120_000;
const LOOK_EVERY_MS = 500;

export function makingProject(dataDir, now = Date.now()) {
  const stat = statSync(join(dataDir, MAKING_PROJECT_MARKER), { throwIfNoEntry: false });
  return Boolean(stat && now - stat.mtimeMs < MAKING_FRESH_MS);
}

export function startMakingProject(dataDir, scope) {
  const marker = join(dataDir, MAKING_PROJECT_MARKER);
  let release;
  try { release = acquireFileLock(marker + '.lock'); } catch (error) {
    if (error.code === 'file_lock_busy') return null;
    throw error;
  }
  try { writeTextFileAtomic(marker, scope); } catch (error) { release(); throw error; }
  return () => {
    try { rmSync(marker, { force: true }); } finally { release(); }
  };
}

// Whether the follower console of this data directory runs this computer's
// graph now (follower-runtime-broker.js records it), waited for at most withinMs.
export async function ownRuntimeRunning(dataDir, { withinMs = RUNTIME_WAIT_MS, everyMs = LOOK_EVERY_MS,
  isAlive = isOwnProcessRunning, now = Date.now } = {}) {
  const deadline = now() + withinMs;
  for (;;) {
    let state = null;
    try { state = readJsonFile(join(dataDir, 'graph-runtime-state.json'), null); } catch { /* being written: looked at again */ }
    if (state?.follower === true && Number.isInteger(state.pid) && isAlive(state.pid)) return true;
    if (now() >= deadline) return false;
    await delay(everyMs, null, { ref: false });
  }
}
