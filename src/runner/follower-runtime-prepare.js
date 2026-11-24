import { existsSync, readFileSync } from 'node:fs';

import { FULI_VERSION } from '../package-metadata.js';
import { diskFree } from '../native-runtime/recovered-dir.js';
import { ensureGraphRuntime, stopGraphProviders } from '../setup/graph-runtime.js';
import { DEFAULT_PERSONAL_SPACE_NAME } from '../setup/options.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { recoverBlockedPorts } from '../system/blocked-port-recovery.js';
import { managedProviderUrls, readRuntimeSettings } from '../system/runtime-settings.js';
import { keepDataDirectoryPrivate } from '../system/windows-data-acl.js';
import { openRoutes } from './call-routes.js';
import { dropPreparationClaim, holdPreparationLock, readRecord, spaceAwaitsHost, spaceOf, writeRecord }
  from './follower-local-runtime.js';
import { setGraphAside } from './follower-graph-aside.js';
import { askHostSpace } from './host-space.js';
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
// The graph is made under the personal space ID of the host this computer
// follows (host-space.js), so a copy of the host's `global` can land in it,
// and its Provider is started as a follower's: `global` is the host's, so no
// default record of it is written here (graph-provider global_replica.py).
// While the host does not say its space (away, or an earlier FULI), the
// runtime is installed and checked but no graph is made; the follower console
// starts the preparation again once the host says it. A graph an earlier
// preparation made under a space of its own is looked into again: with no
// project in it, it is set aside (follower-graph-aside.js, never deleted) and
// made again under the host's; with one, it is the person's and stays.
//
// Neo4j, a Java runtime and the Provider take about a gigabyte, and the graph
// needs room to grow: below this much free space nothing is downloaded.
export const LEAST_FREE_BYTES = 3 * 1024 ** 3;

export async function prepareFollowerRuntime({ dataDir, env = process.env, now = Date.now, pid = process.pid,
  lock = holdPreparationLock, free = diskFree, keepPrivate = keepDataDirectoryPrivate, ensure = ensureGraphRuntime,
  stop = stopGraphProviders, listProjects = localGraphProjects, ownsAnyScope = ownsScopeHere, askHost = askHostSpace,
  health = providerHealth, setAside = setGraphAside, write = () => {} }) {
  const release = lock(dataDir);
  if (!release) {
    dropPreparationClaim(dataDir);
    write('Another preparation is under way; this one leaves it to finish.');
    return { state: 'preparing' };
  }
  try {
    return await prepareHoldingLock({ dataDir, env, now, pid, free, keepPrivate, ensure, stop, listProjects, ownsAnyScope,
      askHost, health, setAside, write });
  } finally {
    release();
  }
}

async function prepareHoldingLock({ dataDir, env, now, pid, free, keepPrivate, ensure, stop, listProjects, ownsAnyScope,
  askHost, health, setAside, write }) {
  const before = readRecord(dataDir);
  // Another start's preparation finished while this one waited to be spawned: nothing left to do.
  if (before?.state === 'existing' || (before?.state === 'ready' && !spaceAwaitsHost({ state: 'ready', space: spaceOf(before) }))) {
    dropPreparationClaim(dataDir);
    write('This computer\'s own runtime was already prepared; nothing was done.');
    return before;
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
  dropPreparationClaim(dataDir);

  // A graph that was here before (a FULI of its own) is the person's: starting it would run its
  // identity upgrade, and could meet a format step only the person confirms, with nowhere on a
  // follower to confirm it. It is not started, upgraded or changed, nor given the host's space:
  // its records are under its own (docs/runner-roles-design.md §12).
  if (!createdHere) {
    write('This computer already has a graph of its own; the preparation left it alone (not started, upgraded or changed).');
    return ended({ state: 'existing', space: { state: 'different' } });
  }
  // Whose space this graph is made under: the host's, as its hello says (host-space.js).
  const host = await askHost(dataDir, { ownFormats: before?.formats ?? null });
  const madeSpace = graphSpaceId(paths.graphRuntimeConfigPath);
  // A graph an earlier preparation made, or a runtime it installed and checked, and the host does
  // not say its space now: nothing to start (Neo4j is not run again at every start for nothing).
  if (!host.known && (madeSpace || before?.state === 'ready')) {
    write(host.reason === 'host_too_old'
      ? 'The host\'s FULI does not say its personal space yet; this computer\'s graph is made again under it once the host is updated.'
      : 'The host did not answer; this computer\'s graph is made under the host\'s personal space once it does.');
    return ended({ state: 'ready', running: false, projects: Array.isArray(before?.projects) ? before.projects : [],
      space: { state: 'later', reason: host.reason }, ...(before?.formats ? { formats: before.formats } : {}) });
  }
  let freeBytes = null;
  try { freeBytes = await free(dataDir); } catch { freeBytes = null; }
  if (freeBytes !== null && freeBytes < LEAST_FREE_BYTES) {
    write('Not enough free disk space to prepare this computer\'s own runtime; nothing was downloaded.');
    return ended({ state: 'failed', code: 'disk_low', message: 'Not enough free disk space.',
      freeBytes, needBytes: LEAST_FREE_BYTES });
  }
  const runtimeMode = 'native';
  const settings = readRuntimeSettings(paths.runtimeSettingsPath);
  // `global` is the host's on every follower (D1): this graph's Provider writes none of its defaults.
  const start = (graph) => ensure({ paths, personalSpaceName: DEFAULT_PERSONAL_SPACE_NAME,
    runtimeSettings: { ...settings, graphRuntimeMode: runtimeMode }, runtimeMode, savedRuntimeMode: runtimeMode,
    personalOnly: true, noStart: true, env, onProgress: write, globalReplica: true, ...graph },
  { recoverPorts: keepFollowerConsolePort });
  const halt = () => stop(paths, paths.graphEnvPath, { runtimeMode, personalOnly: true, env });
  const projectsHere = async () => {
    const listed = await listProjects(paths.graphRuntimeConfigPath, {});
    if (!listed.projects) throw Object.assign(new Error('This computer\'s graph did not answer which projects it holds.'),
      { code: 'local_graph_unanswered' });
    return listed.projects;
  };
  let aside = null;
  try {
    // The graph written next is the person's data too: on Windows only they and SYSTEM open it, as `fuli setup` does.
    await keepPrivate(dataDir);
    if (!host.known) {
      // Installed and checked; the graph is made once the host says its space (follower-console.js asks again).
      await start({ graphSetup: false });
      const formats = await ownFormats(paths, health);
      await halt();
      write('This computer\'s own runtime is installed, checked and stopped again; its graph is made once the host says its personal space.');
      return ended({ state: 'ready', running: false, projects: [], space: { state: 'later', reason: host.reason }, formats });
    }
    if (madeSpace && madeSpace !== host.spaceId) {
      // Made by an earlier preparation under a space of its own. Looked into again before anything moves:
      // a graph with a project in it is the person's, and stays as it is.
      await start({});
      const found = await projectsHere();
      await halt();
      if (found.length) {
        write('This computer\'s graph holds projects under a space of its own; it was left as it is.');
        return ended({ state: 'ready', running: false, projects: found, space: { state: 'different' } });
      }
      aside = await setAside(paths, now(), { spaceId: madeSpace, hostSpaceId: host.spaceId });
      write(`This computer's empty graph, made under a space of its own, was set aside (not deleted) in ${aside.folder}.`);
    }
    await start(madeSpace === host.spaceId ? {} : { personalSpace: { id: host.spaceId, providerId: host.providerId } });
    const projects = await projectsHere();
    const formats = await ownFormats(paths, health, { replica: true });
    const running = ownsAnyScope(dataDir);
    if (!running) await halt();
    write(running ? 'This computer\'s own runtime is prepared and keeps running: a scope is this computer\'s.'
      : 'This computer\'s own runtime is prepared, checked and stopped again: no scope is this computer\'s yet.');
    return ended({ state: 'ready', running, projects, formats,
      space: { state: 'same', id: host.spaceId, ...(aside ? { setAside: aside.folder } : {}) } });
  } catch (error) {
    // Whatever was started is stopped again; a stop that fails too is in the log.
    await Promise.resolve().then(halt).catch(() => {});
    let restored = null;
    if (aside) restored = await aside.restore().then(() => true, () => false);
    write(`Preparing this computer's own runtime did not succeed: ${String(error?.message ?? error)}`
      + (restored === true ? ' The graph set aside was put back.' : restored === false
        ? ` The graph set aside could not be put back; it is in ${aside.folder}.` : ''));
    return ended({ state: 'failed', code: typeof error?.code === 'string' ? error.code : 'prepare_failed',
      message: String(error?.message ?? error).slice(0, 300) });
  }
}

// The personal space ID of the graph a preparation made here, or null when none was made.
function graphSpaceId(configPath) {
  try {
    const spaceId = JSON.parse(readFileSync(configPath, 'utf8'))?.personal?.spaceId;
    return typeof spaceId === 'string' && spaceId ? spaceId : null;
  } catch { return null; }
}

// What this computer's own Provider says of its formats, sent with hello (host-space.js followerReport).
// replica: it was started for a follower, so its `global` must be a copy; a Provider that says otherwise
// (one left running from another start) is not taken for one.
async function ownFormats(paths, health, { replica = false } = {}) {
  const answer = await health(managedProviderUrls(readRuntimeSettings(paths.runtimeSettingsPath)).personal).catch(() => null);
  if (replica && answer?.globalReplica !== true) {
    throw Object.assign(new Error('This computer\'s Provider did not start as a follower\'s (its global would not be a copy).'),
      { code: 'provider_not_follower' });
  }
  return answer ? { graph: answer.data_format?.supported_version ?? null, replicaProtocol: answer.replicaProtocol ?? null } : null;
}

async function providerHealth(url) {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`health ${response.status}`);
  return response.json();
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
