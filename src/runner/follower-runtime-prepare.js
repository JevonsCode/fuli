import { existsSync } from 'node:fs';

import { FULI_VERSION } from '../package-metadata.js';
import { diskFree } from '../native-runtime/recovered-dir.js';
import { ensureGraphRuntime, stopGraphProviders } from '../setup/graph-runtime.js';
import { DEFAULT_PERSONAL_SPACE_NAME } from '../setup/options.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { recoverBlockedPorts } from '../system/blocked-port-recovery.js';
import { managedProviderUrls, readRuntimeSettings } from '../system/runtime-settings.js';
import { keepDataDirectoryPrivate } from '../system/windows-data-acl.js';
import { openRoutes } from './call-routes.js';
import { copyCatchUp, dropPreparationClaim, holdPreparationLock, readRecord, spaceAwaitsHost, spaceOf, writeRecord }
  from './follower-local-runtime.js';
import { setGraphAside } from './follower-graph-aside.js';
import { globalIsCopyHere } from './global-copy.js';
import { askHostSpace } from './host-space.js';
import { copyWorthStarting, syncFromPreparation } from './global-sync.js';
import { localGraphOwnGlobal, localGraphProjects, localGraphSpaceId } from './local-graph-projects.js';
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
// and its Provider is started as a follower's while the routes store sends
// `global` to the host (global-copy.js): `global` is the host's then, so no
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
  health = providerHealth, setAside = setGraphAside, globalReplica = globalIsCopyHere, countOwnGlobal = localGraphOwnGlobal,
  firstSync = syncFromPreparation, owed = copyCatchUp, worthStarting = copyWorthStarting, write = () => {} }) {
  const release = lock(dataDir);
  if (!release) {
    dropPreparationClaim(dataDir);
    write('Another preparation is under way; this one leaves it to finish.');
    return { state: 'preparing' };
  }
  try {
    return await prepareHoldingLock({ dataDir, env, now, pid, free, keepPrivate, ensure, stop, listProjects, ownsAnyScope,
      askHost, health, setAside, globalReplica, countOwnGlobal, firstSync, owed, worthStarting, write });
  } finally {
    release();
  }
}

async function prepareHoldingLock({ dataDir, env, now, pid, free, keepPrivate, ensure, stop, listProjects, ownsAnyScope,
  askHost, health, setAside, globalReplica, countOwnGlobal, firstSync, owed, worthStarting, write }) {
  const before = readRecord(dataDir);
  // A runtime prepared under the host's space that still owes the copy of the host's `global`
  // (no copy arrived yet, or FULI changed since): prepared once more, below, only when the host answers.
  const catchUp = before?.state === 'ready' ? owed(dataDir, before) : null;
  // Another start's preparation finished while this one waited to be spawned: nothing left to do.
  if (before?.state === 'existing'
    || (before?.state === 'ready' && !spaceAwaitsHost({ state: 'ready', space: spaceOf(before) }) && !catchUp)) {
    dropPreparationClaim(dataDir);
    write('This computer\'s own runtime was already prepared; nothing was done.');
    return before;
  }
  const paths = resolveSetupPaths({ dataDir, env });
  // Asked with nothing started (the host's hello and digest only): a host that is away, or one that
  // would only say the same refusal or version mismatch again, starts no Neo4j; the record stays as it was.
  let asked = null;
  if (catchUp) {
    asked = await worthStarting({ dataDir, why: catchUp, ownFormats: before.formats ?? null,
      localSpaceId: localGraphSpaceId(paths.graphRuntimeConfigPath), now });
    if (!asked.start) {
      dropPreparationClaim(dataDir);
      write(`The copy of the host's global is owed (${catchUp}) but was not tried now (${asked.outcome}`
        + `${asked.reason ? `: ${asked.reason}` : asked.code ? `: ${asked.code}` : ''}); nothing was started. The state says why.`);
      return before;
    }
    write(catchUp === 'upgrade' ? 'FULI changed since this computer\'s graph was prepared: its runtime is started once to '
      + 'bring the graph format up to date and the copy of the host\'s global, then stopped again.'
      : 'No copy of the host\'s global arrived here yet: this computer\'s runtime is started once for it, then stopped again.');
  }
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
  const host = asked?.hostSpace ?? await askHost(dataDir, { ownFormats: before?.formats ?? null });
  const madeSpace = localGraphSpaceId(paths.graphRuntimeConfigPath);
  // A graph an earlier preparation made, or a runtime it installed and checked, and the host does
  // not say its space now: nothing to start (Neo4j is not run again at every start for nothing).
  if (!host.known && (madeSpace || before?.state === 'ready')) {
    write(host.reason === 'host_too_old'
      ? 'The host\'s FULI does not say its personal space yet; this computer\'s graph is made again under it once the host is updated.'
      : host.reason === 'host_space_pending'
        ? 'The host answered, but its Provider has not said its personal space yet; this computer\'s graph is made under it once it does.'
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
  // While the routes store sends `global` to the host (D1, global-copy.js), it is the host's:
  // this graph's Provider writes none of its defaults.
  const replica = globalReplica(dataDir);
  const start = (graph) => ensure({ paths, personalSpaceName: DEFAULT_PERSONAL_SPACE_NAME,
    runtimeSettings: { ...settings, graphRuntimeMode: runtimeMode }, runtimeMode, savedRuntimeMode: runtimeMode,
    personalOnly: true, noStart: true, env, onProgress: write, globalReplica: replica, ...graph },
  { recoverPorts: keepFollowerConsolePort });
  const halt = () => stop(paths, paths.graphEnvPath, { runtimeMode, personalOnly: true, env });
  const projectsHere = async () => {
    const listed = await listProjects(paths.graphRuntimeConfigPath, {});
    if (!listed.projects) throw Object.assign(new Error('This computer\'s graph did not answer which projects it holds.'),
      { code: 'local_graph_unanswered' });
    return listed.projects;
  };
  // The records of `global` besides the defaults its Provider made by itself (habits, knowledge, FLAs the person hired).
  const ownGlobalHere = async () => {
    const counted = await countOwnGlobal(paths.graphRuntimeConfigPath, {});
    if (!Number.isInteger(counted.count)) throw Object.assign(new Error('This computer\'s graph did not answer what of global it holds.'),
      { code: 'local_graph_unanswered' });
    return counted.count;
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
      // a graph with a project, or any record of `global` besides the defaults, is the person's, and stays as it is.
      await start({});
      const found = await projectsHere();
      const ownGlobal = await ownGlobalHere();
      await halt();
      if (found.length || ownGlobal > 0) {
        write(`This computer's graph holds ${found.length} project(s) and ${ownGlobal} record(s) of global of its own, `
          + 'under a space of its own; it was left as it is.');
        return ended({ state: 'ready', running: false, projects: found, ownGlobal, space: { state: 'different' } });
      }
      aside = await setAside(paths, now(), { spaceId: madeSpace, hostSpaceId: host.spaceId });
      write(`This computer's empty graph, made under a space of its own, was set aside (not deleted) in ${aside.folder}.`);
    }
    const underHostSpace = { personalSpace: { id: host.spaceId, providerId: host.providerId } };
    await start(madeSpace === host.spaceId ? {} : underHostSpace);
    let projects = await projectsHere();
    // A graph whose format waits for a step the person confirms (graph_format.py) stays read-only,
    // and a follower has no place to confirm it: a graph holding nothing of the person's (only the
    // copy, which the host gives again) is set aside, never deleted, and made again in the current
    // format; one holding the person's data is left as it is and said so.
    if (await formatWaits(paths, health)) {
      const ownGlobal = await ownGlobalHere();
      await halt();
      if (projects.length || ownGlobal > 0) {
        write('This computer\'s graph waits for a data format step a person confirms, and holds data of the person\'s; it was left as it is.');
        return ended({ state: 'failed', code: 'graph_format_waits', message: FORMAT_WAITS });
      }
      aside = await setAside(paths, now(), { spaceId: host.spaceId, hostSpaceId: host.spaceId, kind: 'follower-format-behind',
        why: FORMAT_BEHIND_WHY });
      write(`This computer's graph waited for a data format step a person confirms and held only the host's copy; `
        + `it was set aside (not deleted) in ${aside.folder} and made again.`);
      await start(underHostSpace);
      projects = await projectsHere();
    }
    const formats = await ownFormats(paths, health, { replica });
    // Neo4j runs now anyway: the first copy of the host's `global` comes in before it stops again
    // (global-sync.js). One that does not succeed is said in the state; the preparation goes on.
    if (replica) {
      const synced = await firstSync({ dataDir, configPath: paths.graphRuntimeConfigPath, hostSpace: host, ownFormats: formats, now });
      write(synced.outcome === 'synced' ? 'The host\'s global was copied into this computer\'s graph.'
        : `The host's global was not copied now (${synced.outcome}${synced.reason ? `: ${synced.reason}` : synced.code ? `: ${synced.code}` : ''}); `
          + 'the state says why.');
    }
    const running = ownsAnyScope(dataDir);
    if (!running) await halt();
    write(running ? 'This computer\'s own runtime is prepared and keeps running: a scope is this computer\'s.'
      : 'This computer\'s own runtime is prepared, checked and stopped again: no scope is this computer\'s yet.');
    // setAside names only the empty graph of this computer's own space (follower-local-runtime.js localSpaceLine).
    const ownSpaceAside = aside && madeSpace && madeSpace !== host.spaceId;
    return ended({ state: 'ready', running, projects, formats,
      space: { state: 'same', id: host.spaceId, ...(ownSpaceAside ? { setAside: aside.folder } : {}) } });
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

// What this computer's own Provider says of its formats, sent with hello (host-space.js followerReport).
// replica: it was started with `global` a copy, so it must say so; a Provider that says otherwise
// (one left running from another start) is not taken for one.
async function ownFormats(paths, health, { replica = false } = {}) {
  const answer = await health(managedProviderUrls(readRuntimeSettings(paths.runtimeSettingsPath)).personal).catch(() => null);
  if (replica && answer?.globalReplica !== true) {
    throw Object.assign(new Error('This computer\'s Provider did not start as a follower\'s (its global would not be a copy).'),
      { code: 'provider_not_follower' });
  }
  return answer ? { graph: answer.data_format?.supported_version ?? null, replicaProtocol: answer.replicaProtocol ?? null } : null;
}

// Whether the graph's format waits for a step a person confirms (graph_format.py, said in /health).
async function formatWaits(paths, health) {
  const answer = await health(managedProviderUrls(readRuntimeSettings(paths.runtimeSettingsPath)).personal).catch(() => null);
  return answer?.data_format?.state === 'pending_confirmation';
}

const FORMAT_WAITS = 'This computer\'s graph waits for a data format step a person confirms, and it holds data of the '
  + 'person\'s, so it was not set aside. 这台电脑的图谱在等一个要人确认的数据格式步骤，里面有你的数据，所以没有挪开。'
  + 'A follower has no place to confirm it: `fuli runner leave` makes this a FULI of its own, where `fuli migrate preview` '
  + 'shows the step. 从机上没有确认的地方：`fuli runner leave` 让这台电脑成为自己的 FULI，再用 `fuli migrate preview` 查看这一步。';
const FORMAT_BEHIND_WHY = 'This computer followed another FULI; this graph held only a read-only copy of that computer\'s '
  + 'global, and its data format waited for a step a person confirms, which a follower has no place to confirm. Set aside, '
  + 'not deleted; a graph in the current format was made in its place and the copy brought again from the host. '
  + '这台电脑跟随另一台 FULI；这个图谱里只有那台电脑全局的只读副本，它的数据格式在等一个要人确认的步骤，而从机上没有确认的地方。'
  + '挪到这里，没有删除；原位置用当前格式重建，副本从主机重新取来。';

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
