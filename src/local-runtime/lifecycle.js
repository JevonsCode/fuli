import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';

import {
  checkLocalConsoleHealth,
  ensureGraphRuntime,
  MANAGED_PERSONAL_PROVIDER_URL,
  MANAGED_WORKSPACE_PROVIDER_URL,
  stopGraphProviders
} from '../setup/graph-runtime.js';
import { readJsonFile } from '../storage/json-file.js';

export async function startLocalRuntime(input, dependencies = {}) {
  const deps = lifecycleDependencies(dependencies);
  const config = deps.readConfig(input.paths.graphRuntimeConfigPath);
  const managesDevelopmentWorkspace = hasManagedDevelopmentWorkspace(config);
  const buildProviders = input.rebuild === true || !config ||
    !deps.fileExists(input.paths.graphEnvPath);
  const runtime = await deps.ensureRuntime({
    paths: input.paths,
    personalSpaceName: input.personalSpaceName,
    port: input.port,
    personalOnly: !managesDevelopmentWorkspace,
    buildProviders,
    noStart: false,
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
  const config = deps.readConfig(input.paths.graphRuntimeConfigPath);
  const state = deps.readState(input.paths.graphRuntimeStatePath);
  const consoleResult = await stopRecordedConsole(state, input.paths, deps);
  const managesDevelopmentWorkspace = state?.managedProviders?.includes(
    'development-workspace'
  ) || hasManagedDevelopmentWorkspace(config);

  let providers = 'not_initialized';
  if (deps.fileExists(input.paths.graphEnvPath)) {
    deps.stopProviders(input.paths, input.paths.graphEnvPath, {
      personalOnly: !managesDevelopmentWorkspace
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
  const stopped = await stopLocalRuntime(input, dependencies);
  if (stopped.status === 'partial') {
    throw new Error('无法安全确认原本地界面的进程身份，已拒绝重启。');
  }
  const started = await startLocalRuntime(input, dependencies);
  return { stopped, ...started, status: 'restarted' };
}

export async function inspectLocalRuntime(input, dependencies = {}) {
  const deps = lifecycleDependencies(dependencies);
  const config = deps.readConfig(input.paths.graphRuntimeConfigPath);
  const state = deps.readState(input.paths.graphRuntimeStatePath);
  const stateLooksOwned = isRuntimeState(state) && isLoopbackConsoleUrl(state.url);
  const processAlive = stateLooksOwned && deps.isProcessAlive(state.pid);
  const consoleReady = processAlive && await deps.consoleHealth(
    state.url,
    state.pid,
    state.version
  );
  const personalUrl = config?.personal?.providerUrl ?? MANAGED_PERSONAL_PROVIDER_URL;
  const personal = config
    ? await deps.providerHealth(personalUrl)
    : { url: personalUrl, status: 'not_configured' };
  const workspaces = await Promise.all((config?.workspaces ?? []).map(async (workspace) => ({
    ...(await deps.providerHealth(workspace.providerUrl)),
    managedDevelopment: isManagedDevelopmentUrl(workspace.providerUrl)
  })));

  let status = 'stopped';
  if (!config && !state) status = 'not_configured';
  else if (consoleReady && personal.status === 'ready') status = 'running';
  else if (processAlive || personal.status === 'ready') status = 'degraded';

  return {
    status,
    console: {
      status: consoleReady ? 'ready' : processAlive ? 'unverified' : 'stopped',
      url: stateLooksOwned ? state.url : `http://127.0.0.1:${input.port}`,
      pid: processAlive ? state.pid : null
    },
    personal,
    public: {
      configured: workspaces.length > 0,
      status: publicProviderStatus(workspaces),
      providers: workspaces
    }
  };
}

export async function openLocalConsole(input, dependencies = {}) {
  const deps = lifecycleDependencies(dependencies);
  const state = deps.readState(input.paths.graphRuntimeStatePath);
  if (!isRuntimeState(state) || !isLoopbackConsoleUrl(state.url) ||
      !deps.isProcessAlive(state.pid) ||
      !await deps.consoleHealth(state.url, state.pid, state.version)) {
    throw new Error('本地界面尚未运行，请先执行 fl start。');
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
  if (!isLoopbackConsoleUrl(state.url) ||
      !await deps.consoleHealth(state.url, state.pid, state.version)) {
    return 'unverified';
  }

  deps.stopProcess(state.pid);
  if (!await deps.waitForExit(state.pid)) return 'still_running';
  deps.removeState(paths.graphRuntimeStatePath);
  return 'stopped';
}

function lifecycleDependencies(overrides) {
  return {
    readConfig: (path) => readJsonFile(path, null),
    readState: safeReadState,
    fileExists: existsSync,
    ensureRuntime: ensureGraphRuntime,
    stopProviders: stopGraphProviders,
    consoleHealth: checkLocalConsoleHealth,
    providerHealth,
    isProcessAlive,
    stopProcess,
    waitForExit,
    removeState: (path) => {
      if (existsSync(path)) unlinkSync(path);
    },
    openExternal,
    ...overrides
  };
}

function safeReadState(path) {
  try {
    return readJsonFile(path, null);
  } catch {
    return null;
  }
}

async function providerHealth(url) {
  try {
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

function hasManagedDevelopmentWorkspace(config) {
  return (config?.workspaces ?? []).some(({ providerUrl }) =>
    isManagedDevelopmentUrl(providerUrl));
}

function isManagedDevelopmentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) &&
      url.port === new URL(MANAGED_WORKSPACE_PROVIDER_URL).port;
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
  const ready = workspaces.filter(({ status }) => status === 'ready').length;
  if (ready === workspaces.length) return 'ready';
  return ready > 0 ? 'degraded' : 'unavailable';
}

function isRuntimeState(state) {
  return (state?.version === 2 || state?.version === 3) &&
    Number.isInteger(state.pid) && typeof state.url === 'string';
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stopProcess(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function waitForExit(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
