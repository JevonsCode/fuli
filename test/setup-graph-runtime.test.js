import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dockerInfoIndicatesDaemon,
  ensureGraphRuntime,
  selectDockerEnvironment
} from '../src/setup/graph-runtime.js';
import { FULI_VERSION } from '../src/package-metadata.js';
import { DEFAULT_CONVERSATION_LAUNCHERS } from '../src/system/runtime-settings.js';

const PATHS = Object.freeze({
  dataDir: 'C:/Fuli',
  graphEnvPath: 'C:/Fuli/graph.env',
  graphComposePath: 'C:/Package/compose.graphiti.yml',
  graphRuntimeConfigPath: 'C:/Fuli/graph-runtime.json',
  graphRuntimeStatePath: 'C:/Fuli/graph-runtime-state.json',
  logPath: 'C:/Fuli/logs/runtime.log',
  runtimeSettingsPath: 'C:/Fuli/runtime-settings.json',
  containerGraphConfigProfilePath: 'C:/Fuli/runtime-configs/container.json',
  nativeGraphConfigProfilePath: 'C:/Fuli/runtime-configs/native.json'
});
const CONTAINER_RUNTIME = Object.freeze({
  status: 'ready',
  dockerCommand: 'docker',
  dockerEnvironment: { PATH: '/usr/bin' }
});

const ADAPTIVE_PATHS = Object.freeze({
  ...PATHS,
  adaptiveRuntimeSettingsPath: 'C:/Fuli/adaptive-runtime-settings.json',
  adaptiveRuntimeStatePath: 'C:/Fuli/adaptive-runtime-state.json'
});

test('container runtime preflight fails before setup writes Fuli data', async () => {
  const sideEffects = [];
  await assert.rejects(
    ensureGraphRuntime({
      paths: PATHS,
      personalSpaceName: '我',
      personalOnly: true,
      port: 2727,
      noStart: false
    }, {
      async ensureContainerRuntime() {
        throw new Error('Docker Compose is unavailable');
      },
      ensureDirectory() {
        sideEffects.push('directory');
      },
      writeText() {
        sideEffects.push('secret');
      },
      startProviders() {
        sideEffects.push('providers');
      }
    }),
    /Docker Compose is unavailable/
  );

  assert.deepEqual(sideEffects, []);
});

test('native setup bypasses Docker and starts the native graph runtime', async () => {
  const nativeRuntime = { status: 'ready', mode: 'native' };
  const started = [];
  await ensureGraphRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    personalOnly: true,
    runtimeMode: 'native',
    runtimeSettings: {
      version: 1,
      graphRuntimeMode: 'native',
      ports: {
        console: 2727,
        personalProvider: 8787,
        personalNeo4jHttp: 8060,
        personalNeo4jBolt: 7687,
        workspaceProvider: 8788,
        workspaceNeo4jHttp: 7475,
        workspaceNeo4jBolt: 7688
      },
      lanAccess: false,
      resourceRefreshSeconds: 5,
      conversationLaunchers: DEFAULT_CONVERSATION_LAUNCHERS
    },
    noStart: true
  }, dependencies({
    ensureContainerRuntime() {
      throw new Error('Docker must not be inspected in native mode');
    },
    async ensureNativeRuntime(input) {
      assert.equal(input.paths, PATHS);
      return nativeRuntime;
    },
    startNativeProviders(paths, envPath, options) {
      started.push({ paths, envPath, options });
    },
    async fetch(url, options = {}) {
      if (url.endsWith('/health')) return response({ status: 'ready' });
      if (url.endsWith('/v1/bootstrap')) {
        return response({ access_token: 'personal-token', principal_id: 'personal-user' });
      }
      if (url.endsWith('/v1/spaces') && !options.method) return response([]);
      if (url.endsWith('/v1/spaces') && options.method === 'POST') {
        return response({ id: 'personal-space', name: '我', kind: 'personal' });
      }
      if (url.includes('/v1/project-agents/system-hr?')) return response({ agent_id: 'employee.bole' });
      throw new Error(`Unexpected Provider request: ${url}`);
    }
  }));

  assert.deepEqual(started, [{
    paths: PATHS,
    envPath: PATHS.graphEnvPath,
    options: { personalOnly: true, nativeRuntime }
  }]);
});

test('switching modes preserves each graph credential profile and bootstraps a fresh target',
  async () => {
    const previous = configuredGraph();
    previous.personal.accessToken = 'container-token';
    const writes = [];
    const nativeSettings = {
      version: 1,
      graphRuntimeMode: 'native',
      ports: {
        console: 2727,
        personalProvider: 8787,
        personalNeo4jHttp: 8060,
        personalNeo4jBolt: 7687,
        workspaceProvider: 8788,
        workspaceNeo4jHttp: 7475,
        workspaceNeo4jBolt: 7688
      },
      lanAccess: false,
      resourceRefreshSeconds: 5,
      conversationLaunchers: DEFAULT_CONVERSATION_LAUNCHERS
    };
    await ensureGraphRuntime({
      paths: PATHS,
      personalSpaceName: '我',
      personalOnly: true,
      runtimeMode: 'native',
      runtimeSettings: nativeSettings,
      noStart: true
    }, dependencies({
      ensureNativeRuntime: async () => ({ status: 'ready', mode: 'native' }),
      startNativeProviders() {},
      readState: () => ({
        version: 4,
        pid: 27,
        url: 'http://127.0.0.1:2727',
        runtimeSettings: { ...nativeSettings, graphRuntimeMode: 'container' }
      }),
      readConfig(path) {
        if (path === PATHS.graphRuntimeConfigPath) return previous;
        return null;
      },
      writeConfig(path, value) { writes.push({ path, value }); },
      async fetch(url, options = {}) {
        if (url.endsWith('/health')) return response({ status: 'ready' });
        if (url.endsWith('/v1/bootstrap')) {
          return response({ access_token: 'native-token', principal_id: 'native-user' });
        }
        if (url.endsWith('/v1/spaces') && !options.method) return response([]);
        if (url.endsWith('/v1/spaces') && options.method === 'POST') {
          return response({ id: 'native-space', name: '我', kind: 'personal' });
        }
        if (url.includes('/v1/project-agents/system-hr?')) return response({ agent_id: 'employee.bole' });
        throw new Error(`Unexpected Provider request: ${url}`);
      }
    }));

    assert.equal(writes.find(({ path }) =>
      path === PATHS.containerGraphConfigProfilePath).value.personal.accessToken,
    'container-token');
    assert.equal(writes.find(({ path }) =>
      path === PATHS.graphRuntimeConfigPath).value.personal.accessToken,
    'native-token');
    assert.equal(writes.find(({ path }) =>
      path === PATHS.nativeGraphConfigProfilePath).value.personal.accessToken,
    'native-token');
  });

test('LAN setup fails before runtime side effects when no private IPv4 address exists', async () => {
  const sideEffects = [];
  await assert.rejects(
    ensureGraphRuntime({
      paths: PATHS,
      personalSpaceName: '我',
      personalOnly: true,
      port: 2727,
      lan: true,
      noStart: false
    }, {
      discoverLanAddresses: () => [],
      ensureContainerRuntime() {
        sideEffects.push('runtime');
      },
      startProviders() {
        sideEffects.push('providers');
      }
    }),
    /LAN address/
  );
  assert.deepEqual(sideEffects, []);
});

test('personal-only setup starts and bootstraps only the local Provider', async () => {
  const started = [];
  const requestedUrls = [];
  let writtenConfig = null;

  const result = await ensureGraphRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    personalOnly: true,
    port: 2727,
    noStart: true
  }, dependencies({
    fileExists(path) { return path === PATHS.graphEnvPath; },
    startProviders(paths, envPath, options) {
      started.push({ paths, envPath, options });
    },
    async fetch(url, options = {}) {
      requestedUrls.push(url);
      if (url === 'http://127.0.0.1:8787/health') return response({ status: 'ready' });
      if (url === 'http://127.0.0.1:8787/v1/bootstrap') {
        return response({ access_token: 'personal-token', principal_id: 'personal-user' });
      }
      if (url === 'http://127.0.0.1:8787/v1/spaces' && !options.method) return response([]);
      if (url === 'http://127.0.0.1:8787/v1/spaces' && options.method === 'POST') {
        return response({ id: 'personal-space', name: '我', kind: 'personal' });
      }
      if (url.includes('/v1/project-agents/system-hr?')) return response({ agent_id: 'employee.bole' });
      throw new Error(`Unexpected Provider request: ${url}`);
    },
    writeConfig(path, value) {
      assert.equal(path, PATHS.graphRuntimeConfigPath);
      writtenConfig = value;
    }
  }));

  assert.deepEqual(started, [{
    paths: PATHS,
    envPath: PATHS.graphEnvPath,
    options: {
      personalOnly: true,
      containerRuntime: CONTAINER_RUNTIME
    }
  }]);
  assert.equal(requestedUrls.some((url) => url.includes(':8788')), false);
  assert.deepEqual(writtenConfig, {
    version: 1,
    personal: {
      providerUrl: 'http://127.0.0.1:8787',
      accessToken: 'personal-token',
      workflowObservationToken: 'personal-workflow-observation-token-123456',
      principalId: 'personal-user',
      spaceId: 'personal-space'
    },
    workspaces: []
  });
  assert.deepEqual(result, { status: 'initialized', url: null, pid: null });
});

test('setup applies every configured service port to Provider URLs and Compose environment', async () => {
  const runtimeSettings = {
    version: 1,
    graphRuntimeMode: 'container',
    ports: {
      console: 3030,
      personalProvider: 18787,
      personalNeo4jHttp: 17474,
      personalNeo4jBolt: 17687,
      workspaceProvider: 18788,
      workspaceNeo4jHttp: 17475,
      workspaceNeo4jBolt: 17688
    },
    lanAccess: false,
    resourceRefreshSeconds: 10,
    conversationLaunchers: DEFAULT_CONVERSATION_LAUNCHERS,
    notifications: { needsPersonUrl: '' }
  };
  let environment = '';
  let savedSettings = null;
  let writtenConfig = null;
  await ensureGraphRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    personalOnly: true,
    memoryProfile: 'low',
    runtimeSettings,
    noStart: true
  }, dependencies({
    writeText(_path, value) { environment = value; },
    writeRuntimeSettings(_path, value) { savedSettings = value; },
    async fetch(url, options = {}) {
      if (url === 'http://127.0.0.1:18787/health') return response({ status: 'ready' });
      if (url.endsWith('/v1/bootstrap')) {
        return response({ access_token: 'personal-token', principal_id: 'personal-user' });
      }
      if (url.endsWith('/v1/spaces') && !options.method) return response([]);
      if (url.endsWith('/v1/spaces') && options.method === 'POST') {
        return response({ id: 'personal-space', name: '我', kind: 'personal' });
      }
      if (url.includes('/v1/project-agents/system-hr?')) return response({ agent_id: 'employee.bole' });
      throw new Error(`Unexpected Provider request: ${url}`);
    },
    writeConfig(_path, value) { writtenConfig = value; }
  }));

  assert.match(environment, /FULI_PERSONAL_NEO4J_HTTP_PORT=17474/);
  assert.match(environment, /FULI_PERSONAL_NEO4J_BOLT_PORT=17687/);
  assert.match(environment, /FULI_WORKSPACE_NEO4J_HTTP_PORT=17475/);
  assert.match(environment, /FULI_WORKSPACE_NEO4J_BOLT_PORT=17688/);
  assert.match(environment, /FULI_PERSONAL_PROVIDER_PORT=18787/);
  assert.match(
    environment,
    /FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN=/
  );
  assert.match(environment, /FULI_PERSONAL_HUMAN_REVIEW_TOKEN=/);
  assert.match(environment, /FULI_WORKSPACE_PROVIDER_PORT=18788/);
  assert.match(environment, /FULI_NEO4J_MEMORY_PROFILE=low/);
  assert.match(environment, /FULI_NEO4J_HEAP_INITIAL_SIZE=128m/);
  assert.match(environment, /FULI_NEO4J_HEAP_MAX_SIZE=256m/);
  assert.match(environment, /FULI_NEO4J_PAGECACHE_SIZE=64m/);
  assert.deepEqual(savedSettings, runtimeSettings);
  assert.equal(writtenConfig.personal.providerUrl, 'http://127.0.0.1:18787');
});

test('setup persists adaptive memory and marks freshly started graph services awake', async () => {
  let settings = null;
  let state = null;
  await ensureGraphRuntime({
    paths: ADAPTIVE_PATHS,
    personalSpaceName: '我',
    personalOnly: true,
    adaptiveRuntimeSettings: {
      version: 1,
      enabled: true,
      providerIdleSeconds: 60,
      databaseIdleSeconds: 180,
      executorIdleSeconds: 60,
      leaseTtlSeconds: 180
    },
    noStart: true
  }, dependencies({
    readConfig: configuredGraph,
    writeAdaptiveSettings(path, value) {
      assert.equal(path, ADAPTIVE_PATHS.adaptiveRuntimeSettingsPath);
      settings = value;
    },
    writeAdaptiveState(path, value) {
      assert.equal(path, ADAPTIVE_PATHS.adaptiveRuntimeStatePath);
      state = value;
    },
    async fetch(url) {
      if (url.endsWith('/health')) return response({ status: 'ready' });
      if (url.includes('/v1/project-agents/system-hr?')) return response({ agent_id: 'employee.bole' });
      throw new Error(`Unexpected Provider request: ${url}`);
    }
  }));

  assert.equal(settings.enabled, true);
  assert.equal(state.stage, 'awake');
  assert.equal(state.lastError, null);
});

test('setup migrates an existing personal runtime onto the host observation capability', async () => {
  let writtenConfig = null;
  const secured = [];
  await ensureGraphRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    personalOnly: true,
    port: 2727,
    noStart: true
  }, dependencies({
    readConfig() {
      const old = configuredGraph();
      delete old.personal.workflowObservationToken;
      return old;
    },
    async fetch(url) {
      if (url.endsWith('/health')) return response({ status: 'ready' });
      if (url.includes('/v1/project-agents/system-hr?')) return response({ agent_id: 'employee.bole' });
      throw new Error(`Unexpected Provider request: ${url}`);
    },
    writeConfig(_path, value) { writtenConfig = value; },
    secureFile(path) { secured.push(path); }
  }));

  assert.equal(
    writtenConfig.personal.workflowObservationToken,
    'personal-workflow-observation-token-123456'
  );
  assert.deepEqual(secured, [
    PATHS.graphEnvPath,
    PATHS.graphRuntimeConfigPath
  ]);
});

test('a graph waiting for a confirmed format step still starts, so the person can confirm it in the console', async () => {
  const requests = [];
  const result = await ensureGraphRuntime({
    paths: PATHS, personalSpaceName: '我', personalOnly: true, port: 2727, noStart: true
  }, dependencies({
    readConfig: configuredGraph,
    async fetch(url) {
      requests.push(url);
      if (url.endsWith('/health')) return response({ status: 'ready' });
      if (url.includes('/v1/project-agents/system-hr?')) {
        return response({ detail: { code: 'data_format_read_only', store: 'graph',
          message: 'graph/12-builtin-occupations needs confirmation' } }, 503);
      }
      throw new Error(`Unexpected Provider request: ${url}`);
    }
  }));

  assert.equal(result.status, 'initialized');
  assert.equal(requests.filter(url => url.includes('/v1/project-agents/system-hr?')).length, 1);
});

test('any other Provider refusal of the identity upgrade still stops setup', async () => {
  await assert.rejects(ensureGraphRuntime({
    paths: PATHS, personalSpaceName: '我', personalOnly: true, port: 2727, noStart: true
  }, dependencies({
    readConfig: configuredGraph,
    async fetch(url) {
      if (url.endsWith('/health')) return response({ status: 'ready' });
      if (url.includes('/v1/project-agents/system-hr?')) {
        return response({ detail: { code: 'data_format_blocked', store: 'graph' } }, 503);
      }
      throw new Error(`Unexpected Provider request: ${url}`);
    }
  })), /Provider setup failed at \/v1\/project-agents\/system-hr/);
});

test('Docker setup falls back to Rancher Desktop when the default daemon is unavailable', () => {
  const checkedSockets = [];
  const environment = selectDockerEnvironment({
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
    homeDir: '/Users/example',
    dockerAvailable: () => false,
    socketExists(path) {
      checkedSockets.push(path);
      return path === '/Users/example/.rd/docker.sock';
    }
  });

  assert.deepEqual(checkedSockets, ['/Users/example/.rd/docker.sock']);
  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    DOCKER_HOST: 'unix:///Users/example/.rd/docker.sock'
  });
});

test('Docker setup preserves an explicit Docker host without probing alternatives', () => {
  let probed = false;
  const environment = selectDockerEnvironment({
    env: { DOCKER_HOST: 'unix:///configured/docker.sock' },
    platform: 'darwin',
    homeDir: '/Users/example',
    dockerAvailable() {
      probed = true;
      return false;
    },
    socketExists() {
      probed = true;
      return true;
    }
  });

  assert.equal(probed, false);
  assert.deepEqual(environment, { DOCKER_HOST: 'unix:///configured/docker.sock' });
});

test('Docker daemon detection rejects a misleading zero exit with empty output', () => {
  assert.equal(dockerInfoIndicatesDaemon({ status: 0, stdout: '' }), false);
  assert.equal(dockerInfoIndicatesDaemon({ status: 0, stdout: '\n' }), false);
  assert.equal(dockerInfoIndicatesDaemon({ status: 1, stdout: '24.0.7\n' }), false);
  assert.equal(dockerInfoIndicatesDaemon({ status: 0, stdout: '24.0.7\n' }), true);
});

test('setup restarts a healthy console when the configured port changes', async () => {
  const stopped = [];
  let spawnedInput = null;
  let writtenState = null;

  const result = await ensureGraphRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    personalOnly: false,
    port: 2727,
    noStart: false
  }, dependencies({
    readConfig: configuredGraph,
    readState() {
      return {
        version: 2,
        pid: 5173,
        url: 'http://127.0.0.1:5173',
        port: 5173
      };
    },
    async fetch(url) {
      if (url.endsWith('/health')) return response({ status: 'ready' });
      if (url.includes('/v1/project-agents/system-hr?')) return response({ agent_id: 'employee.bole' });
      throw new Error(`Unexpected Provider request: ${url}`);
    },
    isProcessAlive(pid) { return pid === 5173 || pid === 2727; },
    async webHealth(url) { return url === 'http://127.0.0.1:5173' || url === 'http://127.0.0.1:2727'; },
    stopProcess(pid) { stopped.push(pid); },
    spawnWebRuntime(input) {
      spawnedInput = input;
      return { pid: 2727 };
    },
    writeState(path, state) {
      assert.equal(path, PATHS.graphRuntimeStatePath);
      writtenState = state;
    }
  }));

  assert.deepEqual(stopped, [5173]);
  assert.equal(spawnedInput.port, 2727);
  assert.equal(writtenState.port, 2727);
  assert.equal(writtenState.url, 'http://127.0.0.1:2727');
  assert.deepEqual(result, {
    status: 'started',
    url: 'http://127.0.0.1:2727',
    pid: 2727
  });
});

test('setup starts an authenticated LAN console and secures its runtime state', async () => {
  let spawnedInput = null;
  let writtenState = null;
  const secured = [];
  const result = await ensureGraphRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    personalOnly: true,
    port: 2727,
    lan: true,
    noStart: false,
    env: { PATH: '/usr/bin' }
  }, dependencies({
    discoverLanAddresses: () => ['192.168.31.8'],
    createLanAccessToken: () => 'temporary-access-code',
    readConfig: configuredGraph,
    async fetch(url) {
      if (url.endsWith('/health')) return response({ status: 'ready' });
      if (url.includes('/v1/project-agents/system-hr?')) return response({ agent_id: 'employee.bole' });
      throw new Error(`Unexpected Provider request: ${url}`);
    },
    isProcessAlive: (pid) => pid === 2727,
    webHealth: async (url) => url === 'http://127.0.0.1:2727',
    spawnWebRuntime(input) {
      spawnedInput = input;
      return { pid: 2727 };
    },
    writeState(_path, state) {
      writtenState = state;
    },
    secureFile(path) {
      secured.push(path);
    }
  }));

  assert.equal(spawnedInput.lan, true);
  assert.equal(spawnedInput.lanAccessToken, 'temporary-access-code');
  assert.deepEqual(writtenState.lanUrls, ['http://192.168.31.8:2727']);
  assert.equal(Object.hasOwn(writtenState, 'lanAccessToken'), false);
  assert.deepEqual(secured, [PATHS.graphEnvPath, PATHS.graphRuntimeStatePath]);
  assert.deepEqual(result, {
    status: 'started',
    url: 'http://127.0.0.1:2727',
    pid: 2727,
    lan: true,
    lanUrls: ['http://192.168.31.8:2727'],
    lanAccess: {
      username: 'fuli',
      accessCode: 'temporary-access-code'
    }
  });
});

test('repeating LAN start restarts the console and rotates its in-memory access code', async () => {
  let spawnedInput = null;
  const stopped = [];
  const existing = {
    version: 3,
    pid: 2727,
    url: 'http://127.0.0.1:2727',
    port: 2727,
    lan: true,
    lanUrls: ['http://192.168.31.8:2727']
  };
  const result = await ensureGraphRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    personalOnly: true,
    port: 2727,
    lan: true,
    noStart: false
  }, dependencies({
    discoverLanAddresses: () => ['192.168.31.8'],
    createLanAccessToken: () => 'rotated-access-code',
    readConfig: configuredGraph,
    readState: () => existing,
    async fetch(url) {
      if (url.endsWith('/health')) return response({ status: 'ready' });
      if (url.includes('/v1/project-agents/system-hr?')) return response({ agent_id: 'employee.bole' });
      throw new Error(`Unexpected Provider request: ${url}`);
    },
    stopProcess: (pid) => stopped.push(pid),
    waitForExit: async () => true,
    spawnWebRuntime(input) {
      spawnedInput = input;
      return { pid: 2728 };
    },
    webHealth: async (url, pid) =>
      (url === existing.url && pid === 2727) ||
      (url === 'http://127.0.0.1:2727' && pid === 2728),
    isProcessAlive: (pid) => pid === 2727 || pid === 2728,
    writeState() {}
  }));

  assert.deepEqual(stopped, [2727]);
  assert.equal(spawnedInput.lanAccessToken, 'rotated-access-code');
  assert.equal(result.status, 'started');
  assert.equal(result.lanAccess.accessCode, 'rotated-access-code');
});

function runningConsoleCase(runningVersion) {
  const stopped = [];
  let spawned = 0;
  const existing = { version: 4, pid: 2727, url: 'http://127.0.0.1:2727', port: 2727 };
  const run = ensureGraphRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    personalOnly: true,
    port: 2727,
    lan: false,
    noStart: false
  }, dependencies({
    readConfig: configuredGraph,
    readState: () => existing,
    async fetch(url) {
      if (url.endsWith('/health')) return response({ status: 'ready' });
      if (url.includes('/v1/project-agents/system-hr?')) return response({ agent_id: 'employee.bole' });
      throw new Error(`Unexpected Provider request: ${url}`);
    },
    consoleVersion: async () => runningVersion,
    stopProcess: (pid) => stopped.push(pid),
    waitForExit: async () => true,
    spawnWebRuntime() {
      spawned += 1;
      return { pid: 2728 };
    },
    webHealth: async (url, pid) => url === existing.url && [2727, 2728].includes(pid),
    isProcessAlive: (pid) => pid === 2727 || pid === 2728,
    writeState() {}
  }));
  return run.then((result) => ({ result, stopped, spawned }));
}

test('setup keeps a console that already runs this version', async () => {
  const { result, stopped, spawned } = await runningConsoleCase(FULI_VERSION);
  assert.equal(result.status, 'running');
  assert.deepEqual(stopped, []);
  assert.equal(spawned, 0);
});

test('setup replaces a console left running by an older install', async () => {
  for (const runningVersion of ['0.10.0', null]) {
    const { result, stopped, spawned } = await runningConsoleCase(runningVersion);
    assert.equal(result.status, 'started');
    assert.deepEqual(stopped, [2727]);
    assert.equal(spawned, 1);
  }
});

// The console's wait runs on a fake clock: `wait` advances it instead of
// sleeping, and each health probe takes `probeMs` of it, up to its budget.
function consoleStartCase({ answersAfterMs = Infinity, exitsAfterMs = Infinity, probeMs = 0, portProblem = null } = {}) {
  let elapsedMs = 0;
  const portChecks = [];
  const stopped = [];
  const budgets = [];
  let writtenState = null;
  const run = ensureGraphRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    personalOnly: false,
    port: 2727,
    noStart: false
  }, dependencies({
    readConfig: configuredGraph,
    async fetch(url) {
      if (url.endsWith('/health')) return response({ status: 'ready' });
      if (url.includes('/v1/project-agents/system-hr?')) return response({ agent_id: 'employee.bole' });
      throw new Error(`Unexpected Provider request: ${url}`);
    },
    spawnWebRuntime: () => ({ pid: 2727 }),
    isProcessAlive: () => elapsedMs < exitsAfterMs,
    async webHealth(_url, _pid, _version, budgetMs) {
      budgets.push(budgetMs);
      elapsedMs += Math.min(probeMs, budgetMs);
      return elapsedMs >= answersAfterMs;
    },
    async wait(ms) { elapsedMs += ms; },
    now: () => elapsedMs,
    stopProcess(pid) { stopped.push(pid); },
    writeState(_path, state) { writtenState = state; },
    async consolePortProblem(port, host) { portChecks.push([port, host]); return portProblem; }
  }));
  return { run, stopped, budgets, portChecks, elapsed: () => elapsedMs, state: () => writtenState };
}

test('a console that cannot listen on a port Windows reserves says so first, with the range', async () => {
  const reserved = '端口 2727 被 Windows 保留（2634–2733），换一个端口即可。 / Port 2727 is reserved by Windows (2634–2733); use another port.';
  const { run, portChecks } = consoleStartCase({ exitsAfterMs: 250, portProblem: reserved });
  await assert.rejects(run, (error) => {
    assert.ok(error.message.startsWith(`${reserved} The Fuli console exited while starting.`), error.message);
    assert.match(error.message, /Neo4j and the graph Provider are already running/);
    return true;
  });
  assert.deepEqual(portChecks, [[2727, '127.0.0.1']]);
});

test('a console that starts never looks at port reservations', async () => {
  const { run, portChecks } = consoleStartCase({ answersAfterMs: 0 });
  assert.equal((await run).status, 'started');
  assert.deepEqual(portChecks, []);
});

test('setup waits for a console that needs 16 s to come up on a slow file system', async () => {
  const { run, stopped, state } = consoleStartCase({ answersAfterMs: 16_000 });
  assert.equal((await run).status, 'started');
  assert.deepEqual(stopped, []);
  assert.equal(state().pid, 2727);
});

test('a console that never answers is stopped after 60 s, saying what still runs and how to retry or stop', async () => {
  const { run, stopped, elapsed, state } = consoleStartCase();
  await assert.rejects(run, (error) => {
    assert.match(error.message, /did not answer at http:\/\/127\.0\.0\.1:2727 within 60 s/);
    assert.match(error.message,
      /Neo4j and the graph Provider are already running \(http:\/\/127\.0\.0\.1:8787, http:\/\/127\.0\.0\.1:8788\)/);
    assert.match(error.message, /C:\/Fuli\/logs\/runtime\.log/);
    assert.match(error.message, /Run the same command again to retry, or run `fuli stop`/);
    return true;
  });
  assert.equal(elapsed(), 60_000, 'the wait ends at the deadline, not past it');
  assert.deepEqual(stopped, [2727]);
  assert.equal(state(), null, 'a console that did not start leaves no runtime state');
});

test('slow health probes count against the 60 s, and the last probe gets only the time left', async () => {
  // Each probe uses its whole 2.5 s budget, then a 250 ms pause: 2.75 s a round.
  const { run, budgets, elapsed } = consoleStartCase({ probeMs: 2500 });
  await assert.rejects(run, /did not answer at http:\/\/127\.0\.0\.1:2727 within 60 s/);
  assert.equal(elapsed(), 60_000, 'slow probes do not stretch the wait to 240 × 2.75 s');
  assert.equal(budgets.length, 22);
  assert.ok(budgets.slice(0, -1).every((budget) => budget === 2500));
  assert.equal(budgets.at(-1), 60_000 - 21 * 2750, 'the last probe is capped by the remaining time');
});

test('a console that exits while starting is reported at the next check, not after the full wait', async () => {
  const { run, elapsed } = consoleStartCase({ exitsAfterMs: 1000 });
  await assert.rejects(run,
    /The Fuli console exited while starting\. Neo4j and the graph Provider are already running/);
  assert.equal(elapsed(), 1000);
});

function dependencies(overrides = {}) {
  return {
    ensureDirectory() {},
    fileExists(path) { return path === PATHS.graphEnvPath; },
    readText() {
      return [
        'FULI_PERSONAL_NEO4J_PASSWORD=personal-db',
        'FULI_WORKSPACE_NEO4J_PASSWORD=workspace-db',
        'FULI_PERSONAL_BOOTSTRAP_TOKEN=personal-bootstrap',
        'FULI_PERSONAL_HUMAN_REVIEW_TOKEN=personal-human-review-token-123456789',
        'FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN=personal-workflow-observation-token-123456',
        'FULI_WORKSPACE_BOOTSTRAP_TOKEN=workspace-bootstrap'
      ].join('\n');
    },
    writeText() {},
    secureFile() {},
    ensureContainerRuntime: async () => CONTAINER_RUNTIME,
    startProviders() {},
    readConfig() { return null; },
    writeConfig() {},
    writeRuntimeSettings() {},
    readState() { return null; },
    waitForExit: async () => true,
    // Never read this machine's reserved ports or probe a real port.
    consolePortProblem: async () => null,
    ...overrides
  };
}

function configuredGraph() {
  return {
    version: 1,
    personal: {
      providerUrl: 'http://127.0.0.1:8787',
      accessToken: 'personal-token',
      workflowObservationToken: 'personal-workflow-observation-token-123456',
      principalId: 'personal-user',
      spaceId: 'personal-space'
    },
    workspaces: []
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

test('a stopped installation switches modes from its saved mode, not from the removed runtime state',
  async () => {
    const previous = configuredGraph();
    previous.personal.accessToken = 'container-token';
    const writes = [];
    const providerCalls = [];
    await ensureGraphRuntime({
      paths: PATHS,
      personalSpaceName: '我',
      personalOnly: true,
      runtimeMode: 'native',
      savedRuntimeMode: 'container',
      noStart: true
    }, dependencies({
      ensureNativeRuntime: async () => ({ status: 'ready', mode: 'native' }),
      startNativeProviders() {},
      // `fuli stop` removed graph-runtime-state.json.
      readState: () => null,
      readConfig(path) {
        if (path === PATHS.graphRuntimeConfigPath) return previous;
        return null;
      },
      writeConfig(path, value) { writes.push({ path, value }); },
      async fetch(url, options = {}) {
        providerCalls.push(url);
        if (url.endsWith('/health')) return response({ status: 'ready' });
        if (url.endsWith('/v1/bootstrap')) {
          return response({ access_token: 'native-token', principal_id: 'native-user' });
        }
        if (url.endsWith('/v1/spaces') && !options.method) return response([]);
        if (url.endsWith('/v1/spaces') && options.method === 'POST') {
          return response({ id: 'native-space', name: '我', kind: 'personal' });
        }
        if (url.includes('/v1/project-agents/system-hr?')) return response({ agent_id: 'employee.bole' });
        throw new Error(`Unexpected Provider request: ${url}`);
      }
    }));

    assert.ok(providerCalls.some((url) => url.endsWith('/v1/bootstrap')), 'the empty native graph is bootstrapped');
    assert.equal(writes.find(({ path }) =>
      path === PATHS.containerGraphConfigProfilePath).value.personal.accessToken, 'container-token');
    assert.equal(writes.find(({ path }) =>
      path === PATHS.graphRuntimeConfigPath).value.personal.accessToken, 'native-token');
  });
