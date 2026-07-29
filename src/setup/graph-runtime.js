import { spawn, spawnSync } from 'node:child_process';
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
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

export {
  dockerInfoIndicatesDaemon,
  selectDockerEnvironment
} from './container-runtime.js';

const PERSONAL_PROVIDER_URL = 'http://127.0.0.1:8787';
const WORKSPACE_PROVIDER_URL = 'http://127.0.0.1:8788';

export const MANAGED_PERSONAL_PROVIDER_URL = PERSONAL_PROVIDER_URL;
export const MANAGED_WORKSPACE_PROVIDER_URL = WORKSPACE_PROVIDER_URL;

export async function ensureGraphRuntime(input, dependencies = {}) {
  const deps = graphDependencies(dependencies);
  const containerRuntime = await deps.ensureContainerRuntime({
    env: input.env ?? process.env,
    onProgress: input.onProgress
  });
  deps.ensureDirectory(input.paths.dataDir);
  const secrets = ensureProviderSecrets(input.paths.graphEnvPath, deps);
  deps.startProviders(input.paths, input.paths.graphEnvPath, {
    personalOnly: input.personalOnly === true,
    containerRuntime,
    ...(input.buildProviders === false ? { build: false } : {})
  });
  await waitForProvider(PERSONAL_PROVIDER_URL, deps.fetch);
  if (!input.personalOnly) await waitForProvider(WORKSPACE_PROVIDER_URL, deps.fetch);

  let config = deps.readConfig(input.paths.graphRuntimeConfigPath);
  if (!config) {
    config = await bootstrapGraph({
      personalSpaceName: input.personalSpaceName,
      secrets,
      personalOnly: input.personalOnly === true,
      fetchImpl: deps.fetch
    });
    deps.writeConfig(input.paths.graphRuntimeConfigPath, config);
    deps.secureFile(input.paths.graphRuntimeConfigPath);
  }
  stopOwnedLegacyRuntime(input.paths, deps);

  if (input.noStart) return { status: 'initialized', url: null, pid: null };
  const existing = deps.readState(input.paths.graphRuntimeStatePath);
  if (isGraphRuntimeState(existing) && deps.isProcessAlive(existing.pid)) {
    const healthy = await deps.webHealth(existing.url, existing.pid, existing.version);
    if (healthy && existing.port === input.port) {
      return { status: 'running', url: existing.url, pid: existing.pid };
    }
    if (!healthy) throw new Error('Recorded Fuli Graphiti runtime is not healthy');
    deps.stopProcess(existing.pid);
  }
  const child = deps.spawnWebRuntime({
    paths: input.paths,
    nodePath: process.execPath,
    port: input.port
  });
  const url = `http://127.0.0.1:${input.port}`;
  if (!Number.isInteger(child.pid) || !await waitForWeb(url, child.pid, deps)) {
    if (Number.isInteger(child.pid)) deps.stopProcess(child.pid);
    throw new Error('Fuli Graphiti console could not start');
  }
  deps.writeState(input.paths.graphRuntimeStatePath, {
    version: 3,
    pid: child.pid,
    url,
    port: input.port,
    managedProviders: input.personalOnly
      ? ['personal']
      : ['personal', 'development-workspace'],
    startedAt: new Date().toISOString()
  });
  return { status: 'started', url, pid: child.pid };
}

function ensureProviderSecrets(path, deps) {
  if (deps.fileExists(path)) return parseEnv(deps.readText(path));
  const values = {
    FULI_PERSONAL_NEO4J_PASSWORD: secret(),
    FULI_WORKSPACE_NEO4J_PASSWORD: secret(),
    FULI_PERSONAL_BOOTSTRAP_TOKEN: secret(),
    FULI_WORKSPACE_BOOTSTRAP_TOKEN: secret()
  };
  const body = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  deps.writeText(path, body);
  deps.secureFile(path);
  return values;
}

async function bootstrapGraph({ personalSpaceName, secrets, personalOnly, fetchImpl }) {
  const personalIdentity = await bootstrapProvider(
    PERSONAL_PROVIDER_URL,
    secrets.FULI_PERSONAL_BOOTSTRAP_TOKEN,
    personalSpaceName,
    fetchImpl
  );
  const personalSpace = await findOrCreateSpace(PERSONAL_PROVIDER_URL, {
    token: personalIdentity.access_token,
    name: personalSpaceName,
    kind: 'personal',
    fetchImpl
  });
  const config = {
    version: 1,
    personal: {
      providerUrl: PERSONAL_PROVIDER_URL,
      accessToken: personalIdentity.access_token,
      principalId: personalIdentity.principal_id,
      spaceId: personalSpace.id
    },
    workspaces: []
  };
  if (personalOnly) return config;

  const workspaceIdentity = await bootstrapProvider(
    WORKSPACE_PROVIDER_URL,
    secrets.FULI_WORKSPACE_BOOTSTRAP_TOKEN,
    personalSpaceName,
    fetchImpl
  );
  const project = await findOrCreateSpace(WORKSPACE_PROVIDER_URL, {
    token: workspaceIdentity.access_token,
    name: '工作',
    kind: 'project',
    fetchImpl
  });
  await providerRequest(PERSONAL_PROVIDER_URL, '/v1/subscriptions', {
    token: personalIdentity.access_token,
    body: {
      personal_space_id: personalSpace.id,
      project_id: project.id,
      provider_url: WORKSPACE_PROVIDER_URL,
      project_name: project.name
    },
    fetchImpl
  });
  config.workspaces.push({
      providerUrl: WORKSPACE_PROVIDER_URL,
      accessToken: workspaceIdentity.access_token,
      principalId: workspaceIdentity.principal_id
  });
  return config;
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
    if (await deps.webHealth(url, pid, 3)) return true;
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
    const child = spawn(input.nodePath, [
      input.paths.serverPath,
      '--runtime-config', input.paths.graphRuntimeConfigPath,
      '--port', String(input.port)
    ], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log]
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}

function stopOwnedLegacyRuntime(paths, deps) {
  deps.stopLegacyService();
  const state = deps.readState(paths.statePath);
  if (state?.version !== 1 || state.dbPath !== paths.dbPath || !Number.isInteger(state.pid)) return;
  if (deps.isProcessAlive(state.pid)) deps.stopProcess(state.pid);
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
    readState: (path) => readJsonFile(path, null),
    writeState: writeJsonFileAtomic,
    ensureContainerRuntime,
    startProviders: startGraphProviders,
    spawnWebRuntime,
    isProcessAlive,
    stopProcess,
    stopLegacyService,
    webHealth: checkLocalConsoleHealth,
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
  return (state?.version === 2 || state?.version === 3) &&
    Number.isInteger(state.pid) && typeof state.url === 'string';
}

function stopLegacyService() {
  if (process.platform !== 'darwin') return;
  spawnSync('launchctl', ['remove', 'dev.jevonscode.fuli.local'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'ignore'
  });
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
