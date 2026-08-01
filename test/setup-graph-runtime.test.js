import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dockerInfoIndicatesDaemon,
  ensureGraphRuntime,
  selectDockerEnvironment
} from '../src/setup/graph-runtime.js';

const PATHS = Object.freeze({
  dataDir: 'C:/Fuli',
  graphEnvPath: 'C:/Fuli/graph.env',
  graphComposePath: 'C:/Package/compose.graphiti.yml',
  graphRuntimeConfigPath: 'C:/Fuli/graph-runtime.json',
  graphRuntimeStatePath: 'C:/Fuli/graph-runtime-state.json',
  dbPath: 'C:/Fuli/context.db',
  statePath: 'C:/Fuli/runtime.json'
});
const CONTAINER_RUNTIME = Object.freeze({
  status: 'ready',
  dockerCommand: 'docker',
  dockerEnvironment: { PATH: '/usr/bin' }
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
    /局域网地址/
  );
  assert.deepEqual(sideEffects, []);
});

test('personal-only setup starts and bootstraps only the local Provider', async () => {
  const started = [];
  const requestedUrls = [];
  const removedFiles = [];
  let writtenConfig = null;

  const result = await ensureGraphRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    personalOnly: true,
    port: 2727,
    noStart: true
  }, dependencies({
    fileExists(path) {
      return path === PATHS.graphEnvPath ||
        [PATHS.dbPath, `${PATHS.dbPath}-wal`, `${PATHS.dbPath}-shm`].includes(path);
    },
    unlink(path) {
      removedFiles.push(path);
    },
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
      principalId: 'personal-user',
      spaceId: 'personal-space'
    },
    workspaces: []
  });
  assert.deepEqual(result, { status: 'initialized', url: null, pid: null });
  assert.deepEqual(removedFiles, [], 'setup must preserve every existing local database file');
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
    readConfig() { return { version: 1 }; },
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
    readConfig: () => ({ version: 1 }),
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
  assert.deepEqual(secured, [PATHS.graphRuntimeStatePath]);
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
    readConfig: () => ({ version: 1 }),
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
        'FULI_WORKSPACE_BOOTSTRAP_TOKEN=workspace-bootstrap'
      ].join('\n');
    },
    secureFile() {},
    ensureContainerRuntime: async () => CONTAINER_RUNTIME,
    startProviders() {},
    readConfig() { return null; },
    writeConfig() {},
    readState() { return null; },
    waitForExit: async () => true,
    stopLegacyService() {},
    unlink() {},
    ...overrides
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}
