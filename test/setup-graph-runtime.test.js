import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dockerInfoIndicatesDaemon,
  ensureGraphRuntime,
  selectDockerEnvironment
} from '../src/setup/graph-runtime.js';
import { DEFAULT_CONVERSATION_LAUNCHERS } from '../src/system/runtime-settings.js';

const PATHS = Object.freeze({
  dataDir: 'C:/Fuli',
  graphEnvPath: 'C:/Fuli/graph.env',
  graphComposePath: 'C:/Package/compose.graphiti.yml',
  graphRuntimeConfigPath: 'C:/Fuli/graph-runtime.json',
  graphRuntimeStatePath: 'C:/Fuli/graph-runtime-state.json',
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
    conversationLaunchers: DEFAULT_CONVERSATION_LAUNCHERS
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
