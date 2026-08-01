import test from 'node:test';
import assert from 'node:assert/strict';

import {
  externalOpenInvocation,
  inspectLocalRuntime,
  startLocalRuntime,
  stopLocalRuntime
} from '../src/local-runtime/lifecycle.js';

const PATHS = Object.freeze({
  graphRuntimeConfigPath: 'C:/Fuli/graph-runtime.json',
  graphRuntimeStatePath: 'C:/Fuli/graph-runtime-state.json',
  graphEnvPath: 'C:/Fuli/graph-provider.env',
  graphComposePath: 'C:/Package/compose.graphiti.yml'
});

test('fl start initializes only the personal Provider on a fresh machine', async () => {
  let runtimeInput = null;
  const result = await startLocalRuntime(input(), {
    readConfig: () => null,
    fileExists: () => false,
    ensureRuntime: async (value) => {
      runtimeInput = value;
      return { status: 'started', url: 'http://127.0.0.1:2727', pid: 27 };
    }
  });

  assert.equal(runtimeInput.personalOnly, true);
  assert.equal(runtimeInput.buildProviders, true);
  assert.equal(runtimeInput.lan, false);
  assert.equal(result.managesDevelopmentWorkspace, false);
});

test('fl start forwards the explicit LAN exposure mode without changing Provider scope', async () => {
  let runtimeInput = null;
  await startLocalRuntime(input({ lan: true }), {
    readConfig: () => null,
    fileExists: () => true,
    ensureRuntime: async (value) => {
      runtimeInput = value;
      return {
        status: 'started',
        url: 'http://127.0.0.1:2727',
        pid: 27,
        lan: true,
        lanUrls: ['http://192.168.31.8:2727'],
        lanAccess: { username: 'fuli', accessCode: 'temporary-access-code' }
      };
    }
  });

  assert.equal(runtimeInput.lan, true);
  assert.equal(runtimeInput.personalOnly, true);
});

test('fl start preserves an explicitly configured local development public Provider', async () => {
  let runtimeInput = null;
  await startLocalRuntime(input(), {
    readConfig: () => ({
      personal: { providerUrl: 'http://127.0.0.1:8787' },
      workspaces: [{
        providerUrl: 'http://localhost:8788',
        accessToken: 'must-not-be-printed'
      }]
    }),
    fileExists: () => true,
    ensureRuntime: async (value) => {
      runtimeInput = value;
      return { status: 'running', url: 'http://127.0.0.1:2727', pid: 27 };
    }
  });

  assert.equal(runtimeInput.personalOnly, false);
  assert.equal(runtimeInput.buildProviders, false);
});

test('fl stop verifies the console identity and preserves graph volumes', async () => {
  const calls = [];
  const result = await stopLocalRuntime(input(), {
    readConfig: () => ({ workspaces: [] }),
    readState: () => ({
      version: 3,
      pid: 27,
      url: 'http://127.0.0.1:2727',
      managedProviders: ['personal']
    }),
    fileExists: () => true,
    isProcessAlive: () => true,
    consoleHealth: async (url, pid) => url.endsWith(':2727') && pid === 27,
    stopProcess: (pid) => calls.push(`process:${pid}`),
    waitForExit: async () => true,
    removeState: () => calls.push('state:removed'),
    stopProviders: (_paths, _env, options) => calls.push(`providers:${options.personalOnly}`)
  });

  assert.deepEqual(calls, ['process:27', 'state:removed', 'providers:true']);
  assert.deepEqual(result, {
    status: 'stopped',
    console: 'stopped',
    providers: 'stopped',
    managesDevelopmentWorkspace: false
  });
});

test('fl stop refuses to kill a reused or unverifiable PID', async () => {
  let killed = false;
  const result = await stopLocalRuntime(input(), {
    readConfig: () => ({ workspaces: [] }),
    readState: () => ({ version: 3, pid: 27, url: 'http://127.0.0.1:2727' }),
    fileExists: () => false,
    isProcessAlive: () => true,
    consoleHealth: async () => false,
    stopProcess: () => { killed = true; }
  });

  assert.equal(killed, false);
  assert.equal(result.status, 'partial');
  assert.equal(result.console, 'unverified');
});

test('fl status keeps Provider credentials out of its result', async () => {
  const result = await inspectLocalRuntime(input(), {
    readConfig: () => ({
      personal: {
        providerUrl: 'http://127.0.0.1:8787',
        accessToken: 'personal-secret'
      },
      workspaces: [{
        providerUrl: 'https://knowledge.example.com',
        accessToken: 'public-secret'
      }]
    }),
    readState: () => ({
      version: 3,
      pid: 27,
      url: 'http://127.0.0.1:2727',
      lan: true,
      lanUrls: ['http://192.168.31.8:2727'],
      lanAccessToken: 'lan-secret'
    }),
    isProcessAlive: () => true,
    consoleHealth: async () => true,
    providerHealth: async (url) => ({ url, status: 'ready' })
  });

  assert.equal(result.status, 'running');
  assert.equal(result.public.status, 'ready');
  assert.deepEqual(result.console.lanUrls, ['http://192.168.31.8:2727']);
  assert.doesNotMatch(JSON.stringify(result), /personal-secret|public-secret|lan-secret/);
});

test('fl status reports multiple public Providers as degraded when only some are reachable',
  async () => {
    const result = await inspectLocalRuntime(input(), {
      readConfig: () => ({
        personal: { providerUrl: 'http://127.0.0.1:8787' },
        workspaces: [
          { providerUrl: 'https://one.example.com' },
          { providerUrl: 'https://two.example.com' }
        ]
      }),
      readState: () => ({ version: 3, pid: 27, url: 'http://127.0.0.1:2727' }),
      isProcessAlive: () => true,
      consoleHealth: async () => true,
      providerHealth: async (url) => ({
        url,
        status: url.includes('one.') ? 'ready' : 'unavailable'
      })
    });

    assert.equal(result.public.status, 'degraded');
  });

test('console opening only targets a loopback Fuli URL', () => {
  assert.deepEqual(externalOpenInvocation('http://127.0.0.1:2727', 'darwin'), {
    command: 'open',
    args: ['http://127.0.0.1:2727']
  });
  assert.throws(
    () => externalOpenInvocation('https://example.com', 'darwin'),
    /Only the local Fuli console/
  );
});

function input(overrides = {}) {
  return {
    paths: PATHS,
    personalSpaceName: '我',
    port: 2727,
    rebuild: false,
    open: false,
    lan: false,
    ...overrides
  };
}
