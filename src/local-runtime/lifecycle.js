import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { ensureGraphRuntime, stopGraphProviders } from '../setup/graph-runtime.js';
import { beginFirstRunCapture } from '../setup/first-run-capture.js';
import { readJsonFile } from '../storage/json-file.js';
import { readAdaptiveRuntimeSettings } from '../adaptive-runtime/settings.js';
import { readAdaptiveRuntimeState } from '../adaptive-runtime/state.js';
import { createWorkspaceProvider } from '../graphiti/workspace-provider-client.js';
import {
  DEFAULT_RUNTIME_SETTINGS,
  managedProviderUrls
} from '../system/runtime-settings.js';
import { FULI_VERSION } from '../package-metadata.js';
import { compareSemanticVersions, parseSemanticVersion } from '../semantic-version.js';
import { checkLocalConsoleHealth } from './console-health.js';
import { isProcessAlive, stopProcess, waitForExit } from './processes.js';
import { CONSOLE_STOP_LIMITS, consoleProcessOwned, endUnresponsiveConsole, terminateConsole } from './unresponsive-console.js';
import {
  acquireConsoleStartLock,
  readConsoleAutostart,
  recordPersonStart,
  recordPersonStop
} from './console-autostart-record.js';

const CONSOLE_VERSION_TIMEOUT_MS = 2_500;
const STOPPING_CONSOLE_GRACE_MS = 3_000;
// Stopping waits longer for the console's identity than status does: a
// console busy for a few seconds is still the one to stop, and an answer
// missed here leaves it running (Update-Fuli: "could not be stopped").
const STOP_IDENTITY_TIMEOUT_MS = 10_000;
// A start waits this long for another one to finish (Neo4j's first start is slow).
const START_LOCK_WAIT_MS = 5 * 60_000;

export async function startLocalRuntime(input, dependencies = {}) {
  const deps = lifecycleDependencies(dependencies);
  // One start at a time per data directory: a later one finds FULI running.
  const release = deps.lockStart(dataDirOf(input.paths));
  try {
    return await startUnlocked(input, deps);
  } finally {
    release();
  }
}

async function startUnlocked(input, deps) {
  const runtimeSettings = input.runtimeSettings ?? DEFAULT_RUNTIME_SETTINGS;
  const config = deps.readConfig(input.paths.graphRuntimeConfigPath);
  const managesDevelopmentWorkspace = hasManagedDevelopmentWorkspace(
    config,
    runtimeSettings
  );
  // A start a client session's MCP process asked for (console-autostart.js)
  // yields to a stop the person made after it decided; any other start is the
  // person wanting FULI again.
  const dataDir = dataDirOf(input.paths);
  if (input.automatic === true) {
    if (dataDir && deps.readAutostart(dataDir).stoppedAt) {
      throw new Error('FULI was stopped on purpose; it is not started automatically.');
    }
  } else {
    deps.recordStart(dataDir);
  }
  const buildProviders = input.rebuild === true || !config ||
    !deps.fileExists(input.paths.graphEnvPath);
  // A first start without setup (the Windows tray) asks the same question (rec#5 C10).
  deps.beginFirstRun(input.paths);
  const runtime = await deps.ensureRuntime({
    paths: input.paths,
    personalSpaceName: input.personalSpaceName,
    port: input.port,
    lan: input.lan === true,
    lanAccessToken: input.lanAccessToken,
    runtimeSettings,
    previousRuntimeMode: input.previousRuntimeMode,
    personalOnly: !managesDevelopmentWorkspace,
    buildProviders,
    noStart: false,
    allowProviderDowngrade: input.allowProviderDowngrade === true,
    env: input.env,
    onProgress: input.onProgress
  });

  if (input.open === true) await deps.openExternal(runtime.url);
  return {
    ...runtime,
    managesDevelopmentWorkspace
  };
}

export async function stopLocalRuntime(input, dependencies = {}) {
  const deps = lifecycleDependencies(dependencies);
  const runtimeSettings = input.runtimeSettings ?? DEFAULT_RUNTIME_SETTINGS;
  const config = deps.readConfig(input.paths.graphRuntimeConfigPath);
  const state = deps.readState(input.paths.graphRuntimeStatePath);
  // Recorded first, so no client session starts it again while it stops.
  deps.recordStop(dataDirOf(input.paths));
  const consoleResult = await stopRecordedConsole(state, input.paths, deps);
  const managesDevelopmentWorkspace = state?.managedProviders?.includes(
    'development-workspace'
  ) || hasManagedDevelopmentWorkspace(config, runtimeSettings);
  const activeRuntimeMode = state?.runtimeSettings?.graphRuntimeMode ??
    runtimeSettings.graphRuntimeMode;

  // A console that could not be identified is still serving; stopping its
  // graph providers would leave it running without a graph (rec#70).
  let providers = 'not_initialized';
  if (consoleResult === 'unverified') {
    providers = 'kept';
  } else if (deps.fileExists(input.paths.graphEnvPath)) {
    await deps.stopProviders(input.paths, input.paths.graphEnvPath, {
      personalOnly: !managesDevelopmentWorkspace,
      runtimeMode: activeRuntimeMode,
      ...(input.env ? { env: input.env } : {})
    });
    providers = 'stopped';
  }

  const partial = consoleResult === 'unverified' || consoleResult === 'still_running';
  return {
    status: partial ? 'partial' : 'stopped',
    console: consoleResult,
    providers,
    managesDevelopmentWorkspace
  };
}

export async function restartLocalRuntime(input, dependencies = {}) {
  const deps = lifecycleDependencies(dependencies);
  const previousRuntimeMode = deps.readState(input.paths.graphRuntimeStatePath)
    ?.runtimeSettings?.graphRuntimeMode;
  const stopped = await stopLocalRuntime(input, dependencies);
  if (stopped.status === 'partial') {
    throw Object.assign(
      new Error('Could not safely verify the existing local UI process; restart was refused.'),
      { nothingStopped: stopped.console === 'unverified' }
    );
  }
  const started = await startLocalRuntime({ ...input, previousRuntimeMode }, dependencies);
  return { stopped, ...started, status: 'restarted' };
}

export async function inspectLocalRuntime(input, dependencies = {}) {
  const deps = lifecycleDependencies(dependencies);
  const runtimeSettings = input.runtimeSettings ?? DEFAULT_RUNTIME_SETTINGS;
  const config = deps.readConfig(input.paths.graphRuntimeConfigPath);
  const state = deps.readState(input.paths.graphRuntimeStatePath);
  const stateLooksOwned = isRuntimeState(state) && isLoopbackConsoleUrl(state.url);
  const processAlive = stateLooksOwned && deps.isProcessAlive(state.pid);
  const consoleReady = processAlive && await deps.consoleHealth(
    state.url,
    state.pid,
    state.version
  );
  const latest = consoleReady ? await deps.consoleLatestVersion(state.url) : null;
  const adaptiveSettings = deps.readAdaptiveSettings(pathsValue(
    input.paths.adaptiveRuntimeSettingsPath
  ));
  const adaptiveState = adaptiveSettings.enabled
    ? deps.readAdaptiveState(pathsValue(input.paths.adaptiveRuntimeStatePath))
    : null;
  const intentionallySleeping = adaptiveSettings.enabled &&
    ['provider-sleeping', 'sleeping'].includes(adaptiveState?.stage);
  const managedUrls = managedProviderUrls(runtimeSettings);
  const personalUrl = config?.personal?.providerUrl ?? managedUrls.personal;
  const personal = config
    ? intentionallySleeping
      ? { url: personalUrl, status: 'sleeping' }
      : await deps.providerHealth(personalUrl)
    : { url: personalUrl, status: 'not_configured' };
  const workspaces = await Promise.all((config?.workspaces ?? []).map(async (workspace) => {
    const managedDevelopment = isManagedDevelopmentUrl(workspace, runtimeSettings);
    return {
      ...(intentionallySleeping && managedDevelopment
        ? { url: workspace.providerUrl, status: 'sleeping' }
        : await deps.providerHealth(workspace.providerUrl, workspace)),
      managedDevelopment
    };
  }));

  let status = 'stopped';
  if (!config && !state) status = 'not_configured';
  else if (consoleReady && ['ready', 'sleeping'].includes(personal.status)) status = 'running';
  else if (processAlive || personal.status === 'ready') status = 'degraded';

  return {
    status,
    console: {
      status: consoleReady ? 'ready' : processAlive ? 'unverified' : 'stopped',
      url: stateLooksOwned ? state.url : `http://127.0.0.1:${input.port}`,
      pid: processAlive ? state.pid : null,
      // A stop removes the state file, so a state left behind by a dead process
      // means nobody asked it to stop: the desktop client starts it again.
      ...(stateLooksOwned && !processAlive ? { crashed: true } : {}),
      ...(stateLooksOwned && state.lan === true
        ? { lan: true, lanUrls: safeLanUrls(state.lanUrls) }
        : {})
    },
    personal,
    public: {
      configured: workspaces.length > 0,
      status: publicProviderStatus(workspaces),
      providers: workspaces
    },
    adaptiveRuntime: {
      enabled: adaptiveSettings.enabled,
      stage: adaptiveSettings.enabled ? adaptiveState?.stage ?? 'unknown' : 'always-on'
    },
    version: installedVersionStatus(latest)
  };
}

// The installed version beside the newest one the running console last heard
// of from npm. Without a running console, or before its first answer, nothing
// is known: status never asks npm itself.
function installedVersionStatus(latest) {
  if (!latest) return { installed: FULI_VERSION, latest: null, updateAvailable: null, checkedAt: null };
  return { installed: FULI_VERSION, latest: latest.latestVersion,
    updateAvailable: compareSemanticVersions(latest.latestVersion, FULI_VERSION) > 0, checkedAt: latest.checkedAt };
}

// The console's last npm answer (GET /api/system/version?cached=1), or null.
async function readConsoleLatestVersion(url) {
  try {
    const response = await fetch(`${url}/api/system/version?cached=1`,
      { signal: AbortSignal.timeout(CONSOLE_VERSION_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.status !== 'ready') return null;
    parseSemanticVersion(body.latestVersion);
    return { latestVersion: body.latestVersion, checkedAt: typeof body.checkedAt === 'string' ? body.checkedAt : null };
  } catch {
    return null;
  }
}

export async function openLocalConsole(input, dependencies = {}) {
  const deps = lifecycleDependencies(dependencies);
  const state = deps.readState(input.paths.graphRuntimeStatePath);
  if (!isRuntimeState(state) || !isLoopbackConsoleUrl(state.url) ||
      !deps.isProcessAlive(state.pid) ||
      !await deps.consoleHealth(state.url, state.pid, state.version)) {
    throw new Error('The local UI is not running. Run fl start first.');
  }
  await deps.openExternal(state.url);
  return { status: 'opened', url: state.url };
}

async function stopRecordedConsole(state, paths, deps) {
  if (!isRuntimeState(state)) return 'not_running';
  if (!deps.isProcessAlive(state.pid)) {
    deps.removeState(paths.graphRuntimeStatePath);
    return 'not_running';
  }
  if (!isLoopbackConsoleUrl(state.url)) return 'unverified';
  if (!await deps.consoleHealth(state.url, state.pid, state.version, STOP_IDENTITY_TIMEOUT_MS)) {
    // A console that is already shutting down stops answering health checks
    // before its process exits; wait for it instead of reporting a failure.
    if (await deps.waitForExit(state.pid, STOPPING_CONSOLE_GRACE_MS)) {
      deps.removeState(paths.graphRuntimeStatePath);
      return 'not_running';
    }
    // Alive without answering (a shutdown that never finished, rec#94): asked
    // once more, then ended only when the OS shows this data directory's console.
    const ended = await endUnresponsiveConsole(state, paths, {
      ...consoleStop(deps, STOP_IDENTITY_TIMEOUT_MS), limits: { ...CONSOLE_STOP_LIMITS, answerWaitMs: 0 } });
    if (ended === 'unverified') return 'unverified';
    if (ended === 'still_running') return 'still_running';
    if (ended !== 'answering') {
      deps.removeState(paths.graphRuntimeStatePath);
      return ended === 'exited' ? 'not_running' : 'stopped';
    }
  }

  if (!await terminateConsole(state.pid, consoleStop(deps))) return 'still_running';
  deps.removeState(paths.graphRuntimeStatePath);
  return 'stopped';
}

// The lifecycle's own process and health checks, so a stubbed runtime stays stubbed.
function consoleStop(deps, healthTimeoutMs) {
  return { signal: deps.stopProcess, isAlive: deps.isProcessAlive, waitForExit: deps.waitForExit, owned: deps.consoleProcessOwned,
    health: (url, pid, version) => deps.consoleHealth(url, pid, version, healthTimeoutMs) };
}

function lifecycleDependencies(overrides) {
  return {
    readConfig: (path) => readJsonFile(path, null),
    readState: safeReadState,
    fileExists: existsSync,
    ensureRuntime: ensureGraphRuntime,
    // Stubbed runtimes in tests never touch the data directory they name.
    beginFirstRun: overrides.ensureRuntime ? () => {} : beginFirstRunCapture,
    stopProviders: stopGraphProviders,
    consoleHealth: checkLocalConsoleHealth,
    // A stubbed console is never asked over the network.
    consoleLatestVersion: overrides.consoleHealth ? async () => null : readConsoleLatestVersion,
    providerHealth,
    readAdaptiveSettings: (path) => path
      ? readAdaptiveRuntimeSettings(path)
      : { enabled: false },
    readAdaptiveState: (path) => path ? readAdaptiveRuntimeState(path) : null,
    isProcessAlive,
    stopProcess,
    waitForExit,
    consoleProcessOwned,
    removeState: (path) => {
      if (existsSync(path)) unlinkSync(path);
    },
    openExternal,
    // The person's intent for client sessions (console-autostart-record.js).
    // Stubbed runtimes in tests leave the data directory they name alone.
    recordStop: overrides.stopProcess || overrides.ensureRuntime ? () => {} : keepIntent(recordPersonStop),
    recordStart: overrides.ensureRuntime ? () => {} : keepIntent(recordPersonStart),
    readAutostart: overrides.ensureRuntime ? () => ({ stoppedAt: null }) : readConsoleAutostart,
    lockStart: overrides.ensureRuntime ? () => () => {} : lockConsoleStart,
    ...overrides
  };
}

// The data directory the paths name, or null for paths that name none.
function dataDirOf(paths) {
  if (typeof paths?.dataDir === 'string' && paths.dataDir) return paths.dataDir;
  return typeof paths?.graphRuntimeStatePath === 'string' ? dirname(paths.graphRuntimeStatePath) : null;
}

function lockConsoleStart(dataDir) {
  if (!dataDir || !existsSync(dataDir)) return () => {};
  try {
    return acquireConsoleStartLock(dataDir, { waitMs: START_LOCK_WAIT_MS });
  } catch (error) {
    if (error?.code !== 'file_lock_busy') throw error;
    throw new Error('Another FULI start is still running for this data directory; try again when it has finished.');
  }
}

// A start or stop never fails over the intent record: at worst a session
// starts FULI once more, or not at all, until the next start or stop.
function keepIntent(record) {
  return (dataDir) => {
    if (!dataDir || !existsSync(dataDir)) return;
    try { record(dataDir); } catch { /* the start or stop itself goes on */ }
  };
}

function pathsValue(value) {
  return typeof value === 'string' && value ? value : null;
}

function safeReadState(path) {
  try {
    return readJsonFile(path, null);
  } catch {
    return null;
  }
}

async function providerHealth(url, workspace = null) {
  try {
    if (workspace) {
      const { client } = createWorkspaceProvider(workspace, { requestTimeoutMs: 2500 });
      const body = await client.health();
      return { url, status: body?.status === 'ready' ? 'ready' : 'unavailable' };
    }
    const response = await fetch(`${String(url).replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) return { url, status: 'unavailable' };
    const body = await response.json();
    return { url, status: body?.status === 'ready' ? 'ready' : 'unavailable' };
  } catch {
    return { url, status: 'unavailable' };
  }
}

async function openExternal(url) {
  const invocation = externalOpenInvocation(url);
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  child.unref();
}

export function externalOpenInvocation(url, platform = process.platform) {
  if (!isLoopbackConsoleUrl(url)) throw new TypeError('Only the local Fuli console can be opened');
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

function hasManagedDevelopmentWorkspace(config, runtimeSettings) {
  return (config?.workspaces ?? []).some((workspace) =>
    isManagedDevelopmentUrl(workspace, runtimeSettings));
}

function isManagedDevelopmentUrl(workspace, runtimeSettings) {
  if (workspace?.managedDevelopment === true) return true;
  try {
    const url = new URL(workspace?.providerUrl);
    return url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) &&
      [8788, runtimeSettings.ports.workspaceProvider].includes(Number(url.port));
  } catch {
    return false;
  }
}

function isLoopbackConsoleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) &&
      url.username === '' && url.password === '' &&
      (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function publicProviderStatus(workspaces) {
  if (!workspaces.length) return 'not_connected';
  const ready = workspaces.filter(({ status }) => ['ready', 'sleeping'].includes(status)).length;
  if (ready === workspaces.length) return 'ready';
  return ready > 0 ? 'degraded' : 'unavailable';
}

function isRuntimeState(state) {
  return (state?.version === 2 || state?.version === 3 || state?.version === 4) &&
    Number.isInteger(state.pid) && typeof state.url === 'string';
}

function safeLanUrls(value) {
  return Array.isArray(value)
    ? value.filter((url) => typeof url === 'string' && url.startsWith('http://'))
    : [];
}
