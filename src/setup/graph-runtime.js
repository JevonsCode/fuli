import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';

import {
  ensureContainerRuntime,
  runDockerCompose
} from './container-runtime.js';
import {
  discoverLanAddresses,
  LAN_ACCESS_USERNAME,
  lanConsoleUrls
} from '../server/lan-access.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import {
  DEFAULT_RUNTIME_SETTINGS,
  managedProviderUrls,
  normalizeRuntimeSettings,
  runtimeSettingsWithOverrides,
  writeRuntimeSettings
} from '../system/runtime-settings.js';

export {
  dockerInfoIndicatesDaemon,
  selectDockerEnvironment
} from './container-runtime.js';

export async function ensureGraphRuntime(input, dependencies = {}) {
  const deps = graphDependencies(dependencies);
  const runtimeSettings = normalizeRuntimeSettings(input.runtimeSettings ??
    runtimeSettingsWithOverrides(DEFAULT_RUNTIME_SETTINGS, {
      consolePort: input.port,
      lanAccess: input.lan === true
    }));
  const urls = managedProviderUrls(runtimeSettings);
  const lan = runtimeSettings.lanAccess;
  const lanAddresses = lan ? deps.discoverLanAddresses() : [];
  if (lan && lanAddresses.length === 0) {
    throw new Error('No private IPv4 LAN address is available, so LAN mode cannot start.');
  }
  const containerRuntime = await deps.ensureContainerRuntime({
    env: input.env ?? process.env,
    onProgress: input.onProgress
  });
  deps.ensureDirectory(input.paths.dataDir);
  const secrets = ensureProviderEnvironment(
    input.paths.graphEnvPath,
    runtimeSettings,
    deps
  );
  deps.writeRuntimeSettings(input.paths.runtimeSettingsPath, runtimeSettings);
  deps.startProviders(input.paths, input.paths.graphEnvPath, {
    personalOnly: input.personalOnly === true,
    containerRuntime,
    ...(input.buildProviders === false ? { build: false } : {})
  });
  await waitForProvider(urls.personal, deps.fetch);
  if (!input.personalOnly) await waitForProvider(urls.workspace, deps.fetch);

  let config = deps.readConfig(input.paths.graphRuntimeConfigPath);
  if (!config) {
    config = await bootstrapGraph({
      urls,
      personalSpaceName: input.personalSpaceName,
      secrets,
      personalOnly: input.personalOnly === true,
      fetchImpl: deps.fetch
    });
    deps.writeConfig(input.paths.graphRuntimeConfigPath, config);
    deps.secureFile(input.paths.graphRuntimeConfigPath);
  } else {
    const synchronized = synchronizeManagedProviderUrls(config, urls, {
      personalOnly: input.personalOnly === true,
      workflowObservationToken:
        secrets.FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN
    });
    if (synchronized.changed) {
      await reconcileManagedWorkspaceSubscriptions({
        previousConfig: config,
        nextConfig: synchronized.config,
        personalUrl: urls.personal,
        fetchImpl: deps.fetch
      });
      config = synchronized.config;
      deps.writeConfig(input.paths.graphRuntimeConfigPath, config);
      deps.secureFile(input.paths.graphRuntimeConfigPath);
    }
  }

  if (input.noStart) return { status: 'initialized', url: null, pid: null };
  const existing = deps.readState(input.paths.graphRuntimeStatePath);
  if (isGraphRuntimeState(existing) && deps.isProcessAlive(existing.pid)) {
    const healthy = await deps.webHealth(existing.url, existing.pid, existing.version);
    if (
      healthy &&
      existing.port === runtimeSettings.ports.console &&
      exposureMatches(existing, { lan, lanAddresses })
    ) {
      return runtimeResult('running', existing);
    }
    if (!healthy) throw new Error('Recorded Fuli Graphiti runtime is not healthy');
    deps.stopProcess(existing.pid);
    if (!await deps.waitForExit(existing.pid)) {
      throw new Error('Fuli Graphiti console did not stop before changing exposure mode');
    }
  }
  const lanAccessToken = lan ? deps.createLanAccessToken() : null;
  const child = deps.spawnWebRuntime({
    paths: input.paths,
    nodePath: process.execPath,
    port: runtimeSettings.ports.console,
    lan,
    lanAccessToken,
    env: input.env ?? process.env
  });
  const url = `http://127.0.0.1:${runtimeSettings.ports.console}`;
  if (!Number.isInteger(child.pid) || !await waitForWeb(url, child.pid, deps)) {
    if (Number.isInteger(child.pid)) deps.stopProcess(child.pid);
    throw new Error('Fuli Graphiti console could not start');
  }
  const state = {
    version: 4,
    pid: child.pid,
    url,
    port: runtimeSettings.ports.console,
    runtimeSettings,
    ...(lan
      ? {
          lan: true,
          lanUrls: lanConsoleUrls(lanAddresses, runtimeSettings.ports.console)
        }
      : {}),
    managedProviders: input.personalOnly
      ? ['personal']
      : ['personal', 'development-workspace'],
    startedAt: new Date().toISOString()
  };
  deps.writeState(input.paths.graphRuntimeStatePath, state);
  deps.secureFile(input.paths.graphRuntimeStatePath);
  return runtimeResult('started', state, lanAccessToken);
}

function ensureProviderEnvironment(path, settings, deps) {
  const previous = deps.fileExists(path) ? parseEnv(deps.readText(path)) : {};
  const values = {
    ...previous,
    FULI_PERSONAL_NEO4J_PASSWORD: previous.FULI_PERSONAL_NEO4J_PASSWORD ?? secret(),
    FULI_WORKSPACE_NEO4J_PASSWORD: previous.FULI_WORKSPACE_NEO4J_PASSWORD ?? secret(),
    FULI_PERSONAL_BOOTSTRAP_TOKEN: previous.FULI_PERSONAL_BOOTSTRAP_TOKEN ?? secret(),
    FULI_PERSONAL_HUMAN_REVIEW_TOKEN:
      previous.FULI_PERSONAL_HUMAN_REVIEW_TOKEN ?? secret(),
    FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN:
      previous.FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN ?? secret(),
    FULI_WORKSPACE_BOOTSTRAP_TOKEN: previous.FULI_WORKSPACE_BOOTSTRAP_TOKEN ?? secret(),
    FULI_PERSONAL_NEO4J_HTTP_PORT: String(settings.ports.personalNeo4jHttp),
    FULI_PERSONAL_NEO4J_BOLT_PORT: String(settings.ports.personalNeo4jBolt),
    FULI_WORKSPACE_NEO4J_HTTP_PORT: String(settings.ports.workspaceNeo4jHttp),
    FULI_WORKSPACE_NEO4J_BOLT_PORT: String(settings.ports.workspaceNeo4jBolt),
    FULI_PERSONAL_PROVIDER_PORT: String(settings.ports.personalProvider),
    FULI_WORKSPACE_PROVIDER_PORT: String(settings.ports.workspaceProvider)
  };
  const body = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  if (!deps.fileExists(path) || deps.readText(path) !== body) deps.writeText(path, body);
  deps.secureFile(path);
  return values;
}

async function bootstrapGraph({ urls, personalSpaceName, secrets, personalOnly, fetchImpl }) {
  const personalIdentity = await bootstrapProvider(
    urls.personal,
    secrets.FULI_PERSONAL_BOOTSTRAP_TOKEN,
    personalSpaceName,
    fetchImpl
  );
  const personalSpace = await findOrCreateSpace(urls.personal, {
    token: personalIdentity.access_token,
    name: personalSpaceName,
    kind: 'personal',
    fetchImpl
  });
  const config = {
    version: 1,
    personal: {
      providerUrl: urls.personal,
      accessToken: personalIdentity.access_token,
      workflowObservationToken:
        secrets.FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN,
      principalId: personalIdentity.principal_id,
      spaceId: personalSpace.id
    },
    workspaces: []
  };
  if (personalOnly) return config;

  const workspaceIdentity = await bootstrapProvider(
    urls.workspace,
    secrets.FULI_WORKSPACE_BOOTSTRAP_TOKEN,
    personalSpaceName,
    fetchImpl
  );
  const project = await findOrCreateSpace(urls.workspace, {
    token: workspaceIdentity.access_token,
    name: '工作',
    kind: 'project',
    fetchImpl
  });
  await providerRequest(urls.personal, '/v1/subscriptions', {
    token: personalIdentity.access_token,
    body: {
      personal_space_id: personalSpace.id,
      project_id: project.id,
      provider_url: urls.workspace,
      project_name: project.name
    },
    fetchImpl
  });
  config.workspaces.push({
    providerUrl: urls.workspace,
    accessToken: workspaceIdentity.access_token,
    principalId: workspaceIdentity.principal_id,
    managedDevelopment: true
  });
  return config;
}

export function synchronizeManagedProviderUrls(config, urls, {
  personalOnly = true,
  workflowObservationToken = null
} = {}) {
  const next = structuredClone(config);
  let changed = next.personal?.providerUrl !== urls.personal;
  next.personal.providerUrl = urls.personal;
  if (
    nonEmpty(workflowObservationToken) &&
    next.personal.workflowObservationToken !== workflowObservationToken
  ) {
    next.personal.workflowObservationToken = workflowObservationToken;
    changed = true;
  }
  if (!personalOnly) {
    for (const workspace of next.workspaces ?? []) {
      if (!isManagedWorkspace(workspace)) continue;
      if (workspace.providerUrl !== urls.workspace || workspace.managedDevelopment !== true) {
        changed = true;
      }
      workspace.providerUrl = urls.workspace;
      workspace.managedDevelopment = true;
    }
  }
  return { config: next, changed };
}

async function reconcileManagedWorkspaceSubscriptions({
  previousConfig,
  nextConfig,
  personalUrl,
  fetchImpl
}) {
  const previous = (previousConfig.workspaces ?? []).find(isManagedWorkspace);
  const next = (nextConfig.workspaces ?? []).find(isManagedWorkspace);
  if (!previous || !next || previous.providerUrl === next.providerUrl) return;
  const query = new URLSearchParams({ personal_space_id: nextConfig.personal.spaceId });
  const response = await fetchImpl(`${personalUrl}/v1/subscriptions?${query}`, {
    headers: { authorization: `Bearer ${nextConfig.personal.accessToken}` }
  });
  if (!response.ok) throw new Error('Could not reconcile managed workspace subscriptions');
  const subscriptions = await response.json();
  for (const subscription of subscriptions.filter(
    (item) => item.provider_url === previous.providerUrl
  )) {
    const removal = new URLSearchParams({
      personal_space_id: nextConfig.personal.spaceId,
      provider_url: previous.providerUrl
    });
    const removed = await fetchImpl(
      `${personalUrl}/v1/subscriptions/${encodeURIComponent(subscription.project_id)}?${removal}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${nextConfig.personal.accessToken}` }
      }
    );
    if (!removed.ok) throw new Error('Could not remove the previous managed workspace port');
    await providerRequest(personalUrl, '/v1/subscriptions', {
      token: nextConfig.personal.accessToken,
      body: {
        personal_space_id: nextConfig.personal.spaceId,
        project_id: subscription.project_id,
        provider_url: next.providerUrl,
        project_name: subscription.project_name
      },
      fetchImpl
    });
  }
}

function isManagedWorkspace(workspace) {
  if (workspace?.managedDevelopment === true) return true;
  try {
    const url = new URL(workspace?.providerUrl);
    return url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) &&
      url.port === '8788';
  } catch {
    return false;
  }
}

async function bootstrapProvider(url, bootstrapToken, principalName, fetchImpl) {
  const response = await fetchImpl(`${url}/v1/bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-fuli-bootstrap-token': bootstrapToken
    },
    body: JSON.stringify({ principal_name: principalName })
  });
  if (!response.ok) throw new Error(`Could not bootstrap ${url}`);
  return response.json();
}

async function providerRequest(baseUrl, path, { token, body, fetchImpl }) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Provider setup failed at ${path}`);
  return response.json();
}

async function findOrCreateSpace(baseUrl, { token, name, kind, fetchImpl }) {
  const response = await fetchImpl(`${baseUrl}/v1/spaces`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error('Could not list Provider spaces during setup');
  const existing = (await response.json()).find(
    (space) => space.kind === kind && space.name === name
  );
  if (existing) return existing;
  return providerRequest(baseUrl, '/v1/spaces', {
    token,
    body: { name, kind },
    fetchImpl
  });
}

async function waitForProvider(url, fetchImpl) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetchImpl(`${url}/health`);
      if (response.ok) return;
    } catch {
      // Containers and Graphiti indices may still be starting.
    }
    await delay(1000);
  }
  throw new Error(`Graphiti provider did not become ready: ${url}`);
}

async function waitForWeb(url, pid, deps) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!deps.isProcessAlive(pid)) return false;
    if (await deps.webHealth(url, pid, 4)) return true;
    await delay(100);
  }
  return false;
}

export function startGraphProviders(paths, envPath, options = {}) {
  const args = [
    'compose',
    '--env-file', envPath,
    '-f', paths.graphComposePath,
    'up', '-d'
  ];
  if (options.build !== false) args.push('--build');
  if (options.personalOnly) args.push('personal-neo4j', 'personal-provider');
  runDockerCompose(args, options.containerRuntime);
}

export function stopGraphProviders(paths, envPath, options = {}) {
  const args = [
    'compose',
    '--env-file', envPath,
    '-f', paths.graphComposePath,
    'stop'
  ];
  if (options.personalOnly) args.push('personal-provider', 'personal-neo4j');
  runDockerCompose(args);
}

function spawnWebRuntime(input) {
  mkdirSync(dirname(input.paths.logPath), { recursive: true });
  const log = openSync(input.paths.logPath, 'a');
  try {
    const args = [
      input.paths.serverPath,
      '--runtime-config', input.paths.graphRuntimeConfigPath,
      '--port', String(input.port)
    ];
    if (input.lan) args.push('--lan');
    const child = spawn(input.nodePath, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
      env: input.lan
        ? { ...input.env, FULI_LAN_ACCESS_TOKEN: input.lanAccessToken }
        : input.env
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}

function graphDependencies(overrides) {
  return {
    fetch: globalThis.fetch,
    fileExists: existsSync,
    readText: (path) => readFileSync(path, 'utf8'),
    writeText: (path, value) => writeFileSync(path, value, { mode: 0o600 }),
    secureFile: (path) => chmodSync(path, 0o600),
    ensureDirectory: (path) => mkdirSync(path, { recursive: true }),
    readConfig: (path) => readJsonFile(path, null),
    writeConfig: writeJsonFileAtomic,
    writeRuntimeSettings,
    readState: (path) => readJsonFile(path, null),
    writeState: writeJsonFileAtomic,
    ensureContainerRuntime,
    startProviders: startGraphProviders,
    spawnWebRuntime,
    isProcessAlive,
    stopProcess,
    webHealth: checkLocalConsoleHealth,
    discoverLanAddresses,
    createLanAccessToken: secret,
    waitForExit: waitForProcessExit,
    ...overrides
  };
}

export async function checkLocalConsoleHealth(url, expectedPid, stateVersion = 3) {
  try {
    const response = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(2500)
    });
    if (response.ok) {
      const body = await response.json();
      return body?.service === 'fuli-local-console' &&
        (!Number.isInteger(expectedPid) || body.pid === expectedPid);
    }
    if (response.status !== 404 || stateVersion !== 2) return false;
  } catch {
    return false;
  }

  try {
    return (await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(2500) })).ok;
  } catch {
    return false;
  }
}

function isGraphRuntimeState(state) {
  return (state?.version === 2 || state?.version === 3 || state?.version === 4) &&
    Number.isInteger(state.pid) && typeof state.url === 'string';
}

function exposureMatches(state, { lan }) {
  if ((state.lan === true) !== lan) return false;
  if (!lan) return true;
  // A repeated explicit LAN start rotates the in-memory access code.
  return false;
}

function runtimeResult(status, state, lanAccessToken = null) {
  const result = { status, url: state.url, pid: state.pid };
  if (state.lan !== true) return result;
  if (typeof lanAccessToken !== 'string' || lanAccessToken.length < 16) {
    throw new Error('LAN runtime started without a valid access code');
  }
  return {
    ...result,
    lan: true,
    lanUrls: [...state.lanUrls],
    lanAccess: {
      username: LAN_ACCESS_USERNAME,
      accessCode: lanAccessToken
    }
  };
}

function parseEnv(body) {
  return Object.fromEntries(body.split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function secret() {
  return randomBytes(32).toString('base64url');
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stopProcess(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isProcessAlive(pid)) return true;
    await delay(100);
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
