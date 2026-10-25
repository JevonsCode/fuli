import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  externalOpenInvocation,
  inspectLocalRuntime,
  openLocalConsole,
  restartLocalRuntime,
  startLocalRuntime,
  stopLocalRuntime
} from '../src/local-runtime/lifecycle.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

const PATHS = Object.freeze({
  graphRuntimeConfigPath: 'C:/Fuli/graph-runtime.json',
  graphRuntimeStatePath: 'C:/Fuli/graph-runtime-state.json',
  adaptiveRuntimeSettingsPath: 'C:/Fuli/adaptive-runtime-settings.json',
  adaptiveRuntimeStatePath: 'C:/Fuli/adaptive-runtime-state.json',
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

test('fl stop uses the active native lifecycle even when configured mode changed', async () => {
  let stoppedMode = null;
  await stopLocalRuntime(input({
    runtimeSettings: { ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'container' }
  }), {
    readConfig: () => ({ workspaces: [] }),
    readState: () => ({
      version: 4,
      pid: 27,
      url: 'http://127.0.0.1:2727',
      runtimeSettings: { ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native' }
    }),
    fileExists: () => true,
    isProcessAlive: () => false,
    removeState: () => {},
    stopProviders: async (_paths, _env, options) => {
      stoppedMode = options.runtimeMode;
    }
  });

  assert.equal(stoppedMode, 'native');
});

test('fl restart tells setup which credential profile was active before a mode switch',
  async () => {
    let runtimeInput = null;
    await restartLocalRuntime(input({
      runtimeSettings: { ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native' }
    }), {
      readConfig: () => null,
      readState: () => ({
        version: 4,
        pid: 27,
        url: 'http://127.0.0.1:2727',
        runtimeSettings: { ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'container' }
      }),
      fileExists: () => false,
      isProcessAlive: () => false,
      removeState: () => {},
      ensureRuntime: async (value) => {
        runtimeInput = value;
        return { status: 'started', url: 'http://127.0.0.1:2727', pid: 28 };
      }
    });

    assert.equal(runtimeInput.previousRuntimeMode, 'container');
  });

test('fl stop refuses to kill a reused or unverifiable PID', async () => {
  let killed = false;
  const result = await stopLocalRuntime(input(), {
    readConfig: () => ({ workspaces: [] }),
    readState: () => ({ version: 3, pid: 27, url: 'http://127.0.0.1:2727' }),
    fileExists: () => false,
    isProcessAlive: () => true,
    consoleHealth: async () => false,
    waitForExit: async () => false,
    stopProcess: () => { killed = true; }
  });

  assert.equal(killed, false);
  assert.equal(result.status, 'partial');
  assert.equal(result.console, 'unverified');
});

test('fl stop waits for a console that is already shutting down instead of failing', async () => {
  const calls = [];
  const result = await stopLocalRuntime(input(), {
    readConfig: () => ({ workspaces: [] }),
    readState: () => ({ version: 3, pid: 27, url: 'http://127.0.0.1:2727' }),
    fileExists: () => false,
    isProcessAlive: () => true,
    consoleHealth: async () => false,
    waitForExit: async (pid, timeoutMs) => { calls.push(`wait:${pid}:${timeoutMs > 0}`); return true; },
    removeState: () => calls.push('state:removed'),
    stopProcess: () => calls.push('killed')
  });

  assert.deepEqual(calls, ['wait:27:true', 'state:removed']);
  assert.equal(result.status, 'stopped');
  assert.equal(result.console, 'not_running');
});

test('fl stop retries the identity check once when the console answered late', async () => {
  let checks = 0;
  const calls = [];
  const result = await stopLocalRuntime(input(), {
    readConfig: () => ({ workspaces: [] }),
    readState: () => ({ version: 3, pid: 27, url: 'http://127.0.0.1:2727' }),
    fileExists: () => false,
    isProcessAlive: () => true,
    consoleHealth: async () => (checks += 1) > 1,
    waitForExit: async () => calls.length > 0,
    removeState: () => calls.push('state:removed'),
    stopProcess: (pid) => calls.push(`process:${pid}`)
  });

  assert.equal(checks, 2);
  assert.deepEqual(calls, ['process:27', 'state:removed']);
  assert.equal(result.console, 'stopped');
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

test('fl status treats adaptive graph sleep as healthy and does not probe the sleeping Provider',
  async () => {
    let providerProbes = 0;
    const result = await inspectLocalRuntime(input(), {
      readConfig: () => ({
        personal: { providerUrl: 'http://127.0.0.1:8787' },
        workspaces: []
      }),
      readState: () => ({ version: 4, pid: 27, url: 'http://127.0.0.1:2727' }),
      readAdaptiveSettings: () => ({ enabled: true }),
      readAdaptiveState: () => ({ stage: 'sleeping' }),
      isProcessAlive: () => true,
      consoleHealth: async () => true,
      providerHealth: async () => { providerProbes += 1; return { status: 'unavailable' }; }
    });

    assert.equal(result.status, 'running');
    assert.equal(result.personal.status, 'sleeping');
    assert.equal(result.adaptiveRuntime.stage, 'sleeping');
    assert.equal(providerProbes, 0);
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
  // A sign-in opens the console's owner-only launcher file, never a URL with a code (rec#11 D-61).
  const launcher = join(tmpdir(), 'fuli-console-AbC123', 'sign-in-00000000-0000-4000-8000-000000000000.html');
  assert.deepEqual(externalOpenInvocation(launcher, 'win32'), { command: 'cmd', args: ['/c', 'start', '', launcher] });
  assert.deepEqual(externalOpenInvocation(launcher, 'linux'), { command: 'xdg-open', args: [launcher] });
  for (const target of [`http://127.0.0.1:2727/auth/console?code=${'A'.repeat(43)}`, 'http://127.0.0.1:2727/auth/console#code=x',
    join(tmpdir(), 'elsewhere', basename(launcher)), join(tmpdir(), 'fuli-console-a&b', basename(launcher))]) {
    assert.throws(() => externalOpenInvocation(target, 'win32'), /Only the local Fuli console/, target);
  }
});

const RUNNING = Object.freeze({ readState: () => ({ version: 4, pid: 27, url: 'http://127.0.0.1:2727' }),
  isProcessAlive: () => true, consoleHealth: async () => true });

test('fl open opens the console\'s sign-in file for the asked page, and returns only the console address (rec#11 D-61)', async () => {
  const opened = [];
  const asked = [];
  const result = await openLocalConsole(input({ next: '/knowledge?item=s/entity:e1', paths: { ...PATHS, dataDir: 'C:/Fuli' } }), {
    ...RUNNING,
    consoleSignIn: async (request) => { asked.push(request); return 'C:/Temp/fuli-console-x/sign-in-synthetic.html'; },
    openExternal: async (url) => { opened.push(url); }
  });
  assert.deepEqual(asked, [{ consoleUrl: 'http://127.0.0.1:2727', dataDir: 'C:/Fuli', next: '/knowledge?item=s/entity:e1' }]);
  assert.deepEqual(opened, ['C:/Temp/fuli-console-x/sign-in-synthetic.html']);
  assert.deepEqual(result, { status: 'opened', url: 'http://127.0.0.1:2727', signIn: { status: 'signed_in' } });
});

test('fl open and fl start --open open the console without a session when it cannot issue a code', async () => {
  const opened = [];
  const unavailable = { consoleSignIn: async () => { throw new Error('the console answered HTTP 404'); },
    openExternal: async (url) => { opened.push(url); } };
  const result = await openLocalConsole(input(), { ...RUNNING, ...unavailable });
  assert.deepEqual(result.signIn, { status: 'unavailable', reason: 'the console answered HTTP 404' });
  const started = await startLocalRuntime(input({ open: true }), { ...unavailable, readConfig: () => null, fileExists: () => true,
    ensureRuntime: async () => ({ status: 'running', url: 'http://127.0.0.1:2727', pid: 27 }) });
  assert.equal(started.signIn.status, 'unavailable');
  assert.deepEqual(opened, ['http://127.0.0.1:2727', 'http://127.0.0.1:2727']);
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
