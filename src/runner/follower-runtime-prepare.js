import { existsSync } from 'node:fs';

import { FULI_VERSION } from '../package-metadata.js';
import { isProcessAlive } from '../local-runtime/processes.js';
import { diskFree } from '../native-runtime/recovered-dir.js';
import { ensureGraphRuntime, stopGraphProviders } from '../setup/graph-runtime.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { recoverBlockedPorts } from '../system/blocked-port-recovery.js';
import { readRuntimeSettings } from '../system/runtime-settings.js';
import { openRoutes } from './call-routes.js';
import { readRecord, writeRecord } from './follower-local-runtime.js';
import { localGraphProjects } from './local-graph-projects.js';
import { LOCAL_OWNER } from './routes-store.js';

// `fuli runner prepare-local`: prepares a follower's own runtime
// (follower-local-runtime.js), the work the console starts in the background.
// The same setup a first start does (setup/graph-runtime.js), personal graph
// only, without a console: on a follower the console port is its follower
// console's, the one listener there. Then the graph is asked which projects it
// holds, and, while no scope is this computer's, Neo4j and the Provider are
// stopped again: a follower may be a light computer, and nothing reads that
// graph until a scope is made local (step 3c).
//
// Neo4j, a Java runtime and the Provider take about a gigabyte, and the graph
// needs room to grow: below this much free space nothing is downloaded.
export const LEAST_FREE_BYTES = 3 * 1024 ** 3;

export async function prepareFollowerRuntime({ dataDir, env = process.env, now = Date.now, pid = process.pid,
  alive = isProcessAlive, free = diskFree, ensure = ensureGraphRuntime, stop = stopGraphProviders,
  listProjects = localGraphProjects, ownsAnyScope = ownsScopeHere, write = () => {} }) {
  const before = readRecord(dataDir);
  if (before?.state === 'preparing' && before.pid !== pid && alive(before.pid)) {
    write(`Another preparation (process ${before.pid}) is under way; this one leaves it to finish.`);
    return { state: 'preparing' };
  }
  const paths = resolveSetupPaths({ dataDir, env });
  // Kept from an earlier attempt: one that wrote graph-runtime.json and failed later made that graph too.
  const createdHere = typeof before?.createdHere === 'boolean' ? before.createdHere : !existsSync(paths.graphRuntimeConfigPath);
  const at = () => new Date(now()).toISOString();
  const ended = (record) => {
    writeRecord(dataDir, { ...record, at: at(), version: FULI_VERSION, createdHere });
    return readRecord(dataDir);
  };
  writeRecord(dataDir, { state: 'preparing', pid, startedAt: at(), createdHere });

  let freeBytes = null;
  try { freeBytes = await free(dataDir); } catch { freeBytes = null; }
  if (freeBytes !== null && freeBytes < LEAST_FREE_BYTES) {
    write('Not enough free disk space to prepare this computer\'s own runtime; nothing was downloaded.');
    return ended({ state: 'failed', code: 'disk_low', message: 'Not enough free disk space.',
      freeBytes, needBytes: LEAST_FREE_BYTES });
  }
  const settings = readRuntimeSettings(paths.runtimeSettingsPath);
  // A graph that is already here keeps the mode it was made in; a new one is native, as FULI.app makes it.
  const runtimeMode = createdHere ? 'native' : settings.graphRuntimeMode;
  try {
    await ensure({ paths, runtimeSettings: { ...settings, graphRuntimeMode: runtimeMode }, runtimeMode,
      savedRuntimeMode: runtimeMode, personalOnly: true, noStart: true, env, onProgress: write },
    { recoverPorts: keepFollowerConsolePort });
    const listed = await listProjects(paths.graphRuntimeConfigPath, {});
    if (!listed.projects) throw Object.assign(new Error('This computer\'s graph did not answer which projects it holds.'),
      { code: 'local_graph_unanswered' });
    const running = ownsAnyScope(dataDir);
    if (!running) await stop(paths, paths.graphEnvPath, { runtimeMode, personalOnly: true, env });
    write(running ? 'This computer\'s own runtime is prepared and keeps running: a scope is this computer\'s.'
      : 'This computer\'s own runtime is prepared, checked and stopped again: no scope is this computer\'s yet.');
    return ended({ state: 'ready', running, projects: listed.projects });
  } catch (error) {
    // Whatever was started is stopped again; a stop that fails too is in the log.
    await Promise.resolve().then(() => stop(paths, paths.graphEnvPath, { runtimeMode, personalOnly: true, env })).catch(() => {});
    write(`Preparing this computer's own runtime did not succeed: ${String(error?.message ?? error)}`);
    return ended({ state: 'failed', code: typeof error?.code === 'string' ? error.code : 'prepare_failed',
      message: String(error?.message ?? error).slice(0, 300) });
  }
}

// The console port is this computer's follower console's (follower-console.js),
// which a port check would take for another program or another FULI and move
// away from: it is this data directory's own listener, so it stays.
function keepFollowerConsolePort(settings, options) {
  return recoverBlockedPorts(settings, { ...options, recordedConsolePort: settings.ports.console });
}

// Neo4j stays running only while a scope is this computer's (step 3c makes one).
function ownsScopeHere(dataDir) {
  const routes = openRoutes(dataDir);
  try { return routes.all().some((row) => row.owner === LOCAL_OWNER); } finally { routes.close(); }
}
