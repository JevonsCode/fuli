import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindRuntimeLeaseAgentTools,
  createRuntimeLeaseClient
} from '../src/adaptive-runtime/lease-client.js';
import { DEFAULT_ADAPTIVE_RUNTIME_SETTINGS } from '../src/adaptive-runtime/settings.js';

const PATHS = Object.freeze({
  adaptiveRuntimeSettingsPath: '/data/adaptive-settings.json',
  graphRuntimeStatePath: '/data/graph-state.json'
});

test('runtime lease client brackets one operation with acquire and release', async () => {
  const requests = [];
  const client = createRuntimeLeaseClient({
    runtimeConfigPath: '/data/graph-runtime.json',
    paths: PATHS,
    readSettings: () => ({ ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS, enabled: true }),
    readJson: () => ({ url: 'http://127.0.0.1:2727' }),
    fetchImpl: async (url, init) => {
      requests.push({ url, method: init.method, body: init.body });
      return Response.json(init.method === 'POST'
        ? { enabled: true, leaseId: '11111111-1111-4111-8111-111111111111' }
        : { released: true });
    },
    setHeartbeat: () => ({ unref() {} }),
    clearHeartbeat: () => {}
  });
  const value = await client.withGraphLease('mcp:test', async () => 42);
  assert.equal(value, 42);
  assert.deepEqual(requests.map(({ method }) => method), ['POST', 'DELETE']);
  assert.deepEqual(JSON.parse(requests[0].body), { kind: 'graph', owner: 'mcp:test' });
});

test('disabled runtime lease client stays entirely local', async () => {
  let fetched = false;
  const client = createRuntimeLeaseClient({
    runtimeConfigPath: '/data/graph-runtime.json',
    paths: PATHS,
    readSettings: () => DEFAULT_ADAPTIVE_RUNTIME_SETTINGS,
    readJson: () => { throw new Error('state should not be read'); },
    fetchImpl: async () => { fetched = true; }
  });
  assert.equal(await client.withGraphLease('test', async () => 'ok'), 'ok');
  assert.equal(fetched, false);
});

test('an already-cancelled MCP request never acquires a runtime lease', async () => {
  let fetched = false;
  let operated = false;
  const client = createRuntimeLeaseClient({
    runtimeConfigPath: '/data/graph-runtime.json',
    paths: PATHS,
    readSettings: () => ({ ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS, enabled: true }),
    readJson: () => ({ url: 'http://127.0.0.1:2727' }),
    fetchImpl: async () => {
      fetched = true;
      return Response.json({ enabled: false, leaseId: null });
    }
  });
  const controller = new AbortController();
  const cancelled = new Error('synthetic MCP request cancelled before acquire');
  controller.abort(cancelled);

  await assert.rejects(
    client.withGraphLease('mcp:cancelled', async () => {
      operated = true;
    }, { signal: controller.signal }),
    (error) => error === cancelled
  );
  assert.equal(fetched, false);
  assert.equal(operated, false);
});

test('enabled runtime lease client refuses a non-loopback coordinator', async () => {
  const client = createRuntimeLeaseClient({
    runtimeConfigPath: '/data/graph-runtime.json',
    paths: PATHS,
    readSettings: () => ({ ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS, enabled: true }),
    readJson: () => ({ url: 'https://example.com' })
  });
  await assert.rejects(
    () => client.withGraphLease('test', async () => 'never'),
    /only accepts.*loopback/i
  );
});

test('explicit executor lease exposes a safe handle and owns its heartbeat', async () => {
  const leaseId = '22222222-2222-4222-8222-222222222222';
  const requests = [];
  const heartbeatTimer = { unref() {} };
  let heartbeatCallback;
  let heartbeatDelay;
  let clearCount = 0;
  const client = createRuntimeLeaseClient({
    runtimeConfigPath: '/data/graph-runtime.json',
    paths: PATHS,
    readSettings: () => ({ ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS, enabled: true, leaseTtlSeconds: 9 }),
    readJson: () => ({ url: 'http://127.0.0.1:2727' }),
    fetchImpl: async (url, init) => {
      requests.push({ url, method: init.method, body: init.body });
      if (init.method === 'POST') {
        return Response.json({
          enabled: true,
          leaseId,
          kind: 'executor',
          executorId: 'worker-1',
          acquiredAt: '2026-08-19T00:00:00.000Z',
          expiresAt: '2026-08-19T00:00:09.000Z'
        });
      }
      if (init.method === 'PATCH') {
        return Response.json({
          enabled: true,
          leaseId,
          refreshed: true,
          expiresAt: '2026-08-19T00:00:12.000Z'
        });
      }
      return Response.json({ released: true });
    },
    setHeartbeat: (callback, delay) => {
      heartbeatCallback = callback;
      heartbeatDelay = delay;
      return heartbeatTimer;
    },
    clearHeartbeat: (timer) => {
      assert.equal(timer, heartbeatTimer);
      clearCount += 1;
    }
  });

  const handle = await client.acquireExecutorLease('worker-1', 'run:one');
  assert.deepEqual(handle, {
    enabled: true,
    leaseId,
    kind: 'executor',
    executorId: 'worker-1',
    acquiredAt: '2026-08-19T00:00:00.000Z',
    expiresAt: '2026-08-19T00:00:09.000Z'
  });
  assert.equal(heartbeatDelay, 3000);
  assert.equal('consoleUrl' in handle, false);
  assert.doesNotMatch(JSON.stringify(handle), /127\.0\.0\.1/);

  const refreshed = await client.refreshLease(handle);
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.expiresAt, '2026-08-19T00:00:12.000Z');

  heartbeatCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.map(({ method }) => method), ['POST', 'PATCH', 'PATCH']);

  assert.equal((await client.releaseLease(handle)).released, true);
  assert.equal((await client.releaseLease(handle)).released, false);
  heartbeatCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.map(({ method }) => method), ['POST', 'PATCH', 'PATCH', 'DELETE']);
  assert.equal(clearCount, 1);
});

test('explicit lease APIs are safe no-ops when adaptive runtime is disabled', async () => {
  let fetched = false;
  let heartbeatCount = 0;
  const client = createRuntimeLeaseClient({
    runtimeConfigPath: '/data/graph-runtime.json',
    paths: PATHS,
    readSettings: () => DEFAULT_ADAPTIVE_RUNTIME_SETTINGS,
    readJson: () => { throw new Error('state should not be read'); },
    fetchImpl: async () => { fetched = true; },
    setHeartbeat: () => { heartbeatCount += 1; }
  });

  const handle = await client.acquireGraphLease('run:disabled');
  assert.deepEqual(handle, { enabled: false, leaseId: null });
  assert.deepEqual(await client.refreshLease(handle), {
    enabled: false,
    leaseId: null,
    refreshed: false
  });
  assert.deepEqual(await client.releaseLease(handle), {
    enabled: false,
    leaseId: null,
    released: false
  });
  assert.equal(fetched, false);
  assert.equal(heartbeatCount, 0);
});

test('failed heartbeat setup releases the remote lease and leaves no timer', async () => {
  const leaseId = '33333333-3333-4333-8333-333333333333';
  const requests = [];
  const heartbeatTimer = { unref() { throw new Error('heartbeat setup failed'); } };
  let clearCount = 0;
  const client = createRuntimeLeaseClient({
    runtimeConfigPath: '/data/graph-runtime.json',
    paths: PATHS,
    readSettings: () => ({ ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS, enabled: true }),
    readJson: () => ({ url: 'http://127.0.0.1:2727' }),
    fetchImpl: async (url, init) => {
      requests.push(init.method);
      return Response.json(init.method === 'POST'
        ? { enabled: true, leaseId }
        : { released: true });
    },
    setHeartbeat: () => heartbeatTimer,
    clearHeartbeat: (timer) => {
      assert.equal(timer, heartbeatTimer);
      clearCount += 1;
    }
  });

  await assert.rejects(
    () => client.acquireGraphLease('run:setup-failure'),
    /heartbeat setup failed/
  );
  assert.deepEqual(requests, ['POST', 'DELETE']);
  assert.equal(clearCount, 1);
});

test('failed refresh keeps heartbeat retrying until an idempotent release', async () => {
  const leaseId = '44444444-4444-4444-8444-444444444444';
  const requests = [];
  const heartbeatTimer = { unref() {} };
  let heartbeatCallback;
  let clearCount = 0;
  const client = createRuntimeLeaseClient({
    runtimeConfigPath: '/data/graph-runtime.json',
    paths: PATHS,
    readSettings: () => ({ ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS, enabled: true }),
    readJson: () => ({ url: 'http://127.0.0.1:2727' }),
    fetchImpl: async (url, init) => {
      requests.push(init.method);
      if (init.method === 'POST') return Response.json({ enabled: true, leaseId });
      if (init.method === 'PATCH') throw new Error('refresh unavailable');
      return Response.json({ released: true });
    },
    setHeartbeat: (callback) => {
      heartbeatCallback = callback;
      return heartbeatTimer;
    },
    clearHeartbeat: (timer) => {
      assert.equal(timer, heartbeatTimer);
      clearCount += 1;
    }
  });

  const handle = await client.acquireGraphLease('run:refresh-failure');
  await assert.rejects(() => client.refreshLease(handle), /refresh unavailable/);
  assert.equal(clearCount, 0);

  heartbeatCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ['POST', 'PATCH', 'PATCH']);

  assert.equal((await client.releaseLease(handle)).released, true);
  assert.equal((await client.releaseLease(handle)).released, false);
  assert.deepEqual(requests, ['POST', 'PATCH', 'PATCH', 'DELETE']);
  assert.equal(clearCount, 1);
});

test('runtime lease Agent tools expose only host-safe graph and executor operations', async () => {
  const calls = [];
  const app = {};
  bindRuntimeLeaseAgentTools(app, {
    acquireGraphLease: async (owner) => {
      calls.push(['graph', owner]);
      return { enabled: true, leaseId: 'lease-graph' };
    },
    acquireExecutorLease: async (executorId, owner) => {
      calls.push(['executor', executorId, owner]);
      return { enabled: true, leaseId: 'lease-executor' };
    },
    refreshLease: async (leaseId) => ({ leaseId, refreshed: true }),
    releaseLease: async (leaseId) => ({ leaseId, released: true })
  });

  assert.equal((await app.acquireRuntimeLease({
    kind: 'graph', owner: 'task:one'
  })).leaseId, 'lease-graph');
  assert.equal((await app.acquireRuntimeLease({
    kind: 'executor', executorId: 'codex-local', owner: 'task:one'
  })).leaseId, 'lease-executor');
  assert.equal((await app.refreshRuntimeLease({ leaseId: 'lease-graph' })).refreshed, true);
  assert.equal((await app.releaseRuntimeLease({ leaseId: 'lease-graph' })).released, true);
  assert.deepEqual(calls, [
    ['graph', 'task:one'],
    ['executor', 'codex-local', 'task:one']
  ]);
  assert.throws(
    () => app.acquireRuntimeLease({ kind: 'executor', owner: 'task:missing' }),
    /requires executorId/
  );
});

test('malformed successful acquisitions fail closed and reclaim any usable returned lease ID', async () => {
  // Response mutation is a transport fixture, not a claim that the current broker emits invalid JSON.
  const leaseId = '55555555-5555-4555-8555-555555555555';
  for (const response of [{}, null, [], { enabled: true }, { enabled: false }, { enabled: 'true', leaseId },
    { enabled: false, leaseId }, { enabled: true, leaseId: ' ' }]) {
    const requests = [];
    let operated = false;
    let heartbeats = 0;
    const client = createRuntimeLeaseClient({
      runtimeConfigPath: '/data/graph-runtime.json', paths: PATHS,
      readSettings: () => ({ ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS, enabled: true }),
      readJson: () => ({ url: 'http://127.0.0.1:2727' }),
      fetchImpl: async (url, init) => {
        requests.push({ url, method: init.method });
        return Response.json(init.method === 'POST' ? response : { released: true });
      },
      setHeartbeat: () => { heartbeats += 1; return { unref() {} }; }
    });
    try {
      await assert.rejects(client.withGraphLease('invalid-response', async () => {
        operated = true;
      }), /invalid.*lease.*response/i);
      assert.equal(operated, false);
      assert.equal(heartbeats, 0);
      assert.deepEqual(requests.map(({ method }) => method),
        response?.leaseId === leaseId ? ['POST', 'DELETE'] : ['POST']);
      if (requests.length === 2) assert.ok(requests[1].url.endsWith(`/${leaseId}`));
    } finally { await client.close(); }
  }
});

test('an explicit remotely disabled acquisition remains a valid no-op', async () => {
  const requests = [];
  const client = createRuntimeLeaseClient({
    runtimeConfigPath: '/data/graph-runtime.json', paths: PATHS,
    readSettings: () => ({ ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS, enabled: true }),
    readJson: () => ({ url: 'http://127.0.0.1:2727' }),
    fetchImpl: async (_url, init) => {
      requests.push(init.method);
      return Response.json({ enabled: false, leaseId: null });
    }
  });
  try {
    assert.equal(await client.withGraphLease('remote-disabled', async () => 42), 42);
    assert.deepEqual(requests, ['POST']);
  } finally { await client.close(); }
});
