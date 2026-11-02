import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openChildProcessLog } from '../local-runtime/child-process-log.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

// Moving an older install's Docker (container) graph into the built-in native
// graph with one click: the console starts `fuli graph migrate --to native
// --yes` as a detached process, because the migration stops and restarts the
// console itself. The command records how it ended (recordGraphMigration), so
// the console that comes back can say so. When it cannot finish, the person
// gets the external migration guide an AI can follow (LEGACY_MIGRATION_GUIDE_URL).
//
//   { status: 'running' | 'migrated' | 'already_native' | 'failed', startedAt, finishedAt?, error?, backupDir?, logPath }

export const LEGACY_MIGRATION_GUIDE_URL =
  'https://github.com/JevonsCode/fuli/blob/main/migration-guides/legacy-graph-data/SKILL.md';
const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));

const statePath = (paths) => join(paths.dataDir, 'graph-migration.json');
export const graphMigrationLogPath = (paths) => join(paths.dataDir, 'logs', 'graph-migration.log');

/** The last one-click migration of this data directory, or null. A run whose process is gone reads as failed. */
export function readGraphMigration(paths, { alive = processAlive } = {}) {
  const state = readJsonFile(statePath(paths), null);
  if (state?.status !== 'running' || alive(state.pid)) return state;
  return { ...state, status: 'failed', error: 'The migration process stopped before it finished.' };
}

/** The migrate command's own outcome, read back by the console that comes back after it. */
export function recordGraphMigration(paths, outcome, { now = () => new Date() } = {}) {
  const previous = readJsonFile(statePath(paths), null);
  writeJsonFileAtomic(statePath(paths), { ...previous, ...outcome, pid: undefined, finishedAt: now().toISOString() });
}

// runtimeMode: the active graph runtime mode ('container' | 'native').
export function startGraphMigration(paths, { runtimeMode, spawnProcess = spawn, alive = processAlive,
  now = () => new Date() } = {}) {
  if (runtimeMode() !== 'container') throw new TypeError('This FULI already uses the built-in graph; nothing to move.');
  if (readGraphMigration(paths, { alive })?.status === 'running') throw new TypeError('The migration is already running.');
  const logPath = graphMigrationLogPath(paths);
  const log = openChildProcessLog(logPath);
  try {
    const child = spawnProcess(process.execPath, [CLI_PATH, 'graph', 'migrate', '--to', 'native', '--yes',
      '--data-dir', paths.dataDir], { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    if (!Number.isInteger(child.pid)) throw new Error('The migration process could not start.');
    const state = { status: 'running', pid: child.pid, startedAt: now().toISOString(), logPath };
    writeJsonFileAtomic(statePath(paths), state);
    child.unref();
    return state;
  } finally {
    closeSync(log);
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
