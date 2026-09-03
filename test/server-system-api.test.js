import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

import { createServer } from '../src/server.js';
import { createSystemService } from '../src/system/system-service.js';
import { createAdaptiveRuntimeBroker } from '../src/adaptive-runtime/runtime-broker.js';
import { createRuntimeLeaseClient } from '../src/adaptive-runtime/lease-client.js';
import { closeServer, getJson, requestJson } from '../test-support/server.js';

test('system API exposes resource samples and validates persisted settings through one service', async () => {
  const updates = [];
  const configured = {
    version: 1,
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
    resourceRefreshSeconds: 5
  };
  const system = {
    getSettings: () => ({ configured, active: configured, restartRequired: false }),
    updateSettings: (input) => {
      updates.push(input);
      return { configured: input, active: configured, restartRequired: true };
    },
    resources: async () => ({
      sampledAt: '2026-08-01T10:00:00.000Z',
      status: 'ready',
      memory: { usedBytes: 42 },
      disk: { usedBytes: 84 }
    }),
    versionStatus: async () => ({
      status: 'ready',
      currentVersion: '0.7.7',
      latestVersion: '0.7.8',
      updateAvailable: true,
      packageUrl: 'https://www.npmjs.com/package/fuli-context'
    })
  };
  const app = { graphiti: true, close() {} };
  const { server, url } = await createServer({ app, system, port: 0 });
  try {
    assert.equal((await getJson(`${url}/api/system/settings`)).configured.ports.console, 2727);
    assert.equal((await getJson(`${url}/api/system/resources`)).memory.usedBytes, 42);
    assert.equal((await getJson(`${url}/api/system/version`)).latestVersion, '0.7.8');
    const next = { ...configured, ports: { ...configured.ports, console: 3030 } };
    const response = await requestJson(`${url}/api/system/settings`, {
      method: 'PUT',
      body: next
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.restartRequired, true);
    assert.deepEqual(updates, [next]);
  } finally {
    await closeServer(server);
  }
});

test('system API exposes runtime leases and brackets graph requests without waking status polls',
  async () => {
    const events = [];
    const leaseId = '11111111-1111-4111-8111-111111111111';
    const system = {
      getSettings: () => ({}),
      updateSettings: () => ({}),
      resources: async () => ({}),
      runtimeStatus: () => ({ enabled: true, stage: 'sleeping', activeLeaseCount: 0 }),
      acquireRuntimeLease: async (input) => {
        events.push(['acquire', input]);
        return { enabled: true, leaseId };
      },
      refreshRuntimeLease: (id) => ({ refreshed: id === leaseId }),
      releaseRuntimeLease: (id) => ({ released: id === leaseId }),
      async withGraphRuntimeLease(owner, operation) {
        events.push(['enter', owner]);
        try { return await operation(); } finally { events.push(['leave', owner]); }
      }
    };
    const app = { state: async () => ({ ready: true }), close() {} };
    const externalKnowledge = {
      listBindings: async () => [],
      syncBinding: async (id) => ({ bindingId: id, status: 'synced' })
    };
    const { server, url } = await createServer({
      app, system, externalKnowledge, port: 0
    });
    try {
      assert.equal((await getJson(`${url}/api/system/runtime`)).stage, 'sleeping');
      assert.deepEqual(events, [], 'runtime status must not acquire a graph lease');

      assert.deepEqual(await getJson(`${url}/api/state`), { ready: true });
      assert.deepEqual(events, [
        ['enter', 'http:GET:/api/state'],
        ['leave', 'http:GET:/api/state']
      ]);
      await getJson(`${url}/api/external-knowledge/bindings`);
      assert.equal(events.length, 2, 'read-only binding configuration must not wake the graph');
      await requestJson(`${url}/api/external-knowledge/bindings/source-a/sync`, {
        method: 'POST', body: {}
      });
      assert.deepEqual(events.slice(2), [
        ['enter', 'http:POST:/api/external-knowledge/bindings/source-a/sync'],
        ['leave', 'http:POST:/api/external-knowledge/bindings/source-a/sync']
      ]);

      const acquired = await requestJson(`${url}/api/system/runtime/leases`, {
        method: 'POST',
        body: { kind: 'executor', executorId: 'local-coder', owner: 'test' }
      });
      assert.equal(acquired.status, 201);
      assert.equal(acquired.body.leaseId, leaseId);
      assert.equal((await requestJson(`${url}/api/system/runtime/leases/${leaseId}`, {
        method: 'PATCH',
        body: {}
      })).body.refreshed, true);
      assert.equal((await requestJson(`${url}/api/system/runtime/leases/${leaseId}`, {
        method: 'DELETE'
      })).body.released, true);
    } finally {
      await closeServer(server);
    }
  });

test('a cold runtime wake returns a lease that callers can still renew', async () => {
  // Synthetic time and graph-service startup; the HTTP route, service and broker are real.
  let now = Date.UTC(2026, 7, 31);
  let timerId = 0;
  const timers = new Map();
  const paths = {
    dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json'
  };
  const broker = createAdaptiveRuntimeBroker({
    paths,
    settings: { enabled: true, leaseTtlSeconds: 30 },
    services: {
      ready: async () => false,
      async start() {
        now += 31_000;
        for (const timer of [...timers.values()]) {
          if (timer.at <= now) {
            timers.delete(timer.handle.id);
            timer.callback();
          }
        }
      },
      stopProviders: async () => {},
      stopDatabases: async () => {}
    },
    readState: () => ({
      version: 1, stage: 'sleeping', lastError: null,
      lastActivityAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
    }),
    writeState: (_path, state) => structuredClone(state),
    now: () => now,
    setTimer(callback, delay) {
      const handle = { id: ++timerId, unref() {} };
      timers.set(handle.id, { handle, callback, at: now + delay });
      return handle;
    },
    clearTimer: (handle) => timers.delete(handle?.id)
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  try {
    const acquired = await requestJson(`${url}/api/system/runtime/leases`, {
      method: 'POST', body: { kind: 'graph', owner: 'cold-wake-test' }
    });
    assert.equal(acquired.status, 201);
    assert.equal(acquired.body.expiresAt, '2026-08-31T00:01:01.000Z');
    const refreshed = await requestJson(`${url}/api/system/runtime/leases/${acquired.body.leaseId}`, {
      method: 'PATCH', body: {}
    });
    assert.equal(refreshed.body.refreshed, true, 'a successfully acquired lease must not already be expired');
  } finally {
    await closeServer(server);
  }
});

test('a disconnected cold-start caller does not leave an undeliverable lease', async () => {
  // Real HTTP disconnect and broker; graph startup is gated and state storage is synthetic.
  const paths = { dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json' };
  let started;
  const starting = new Promise((resolve) => { started = resolve; });
  let finishStartup;
  const startup = new Promise((resolve) => { finishStartup = resolve; });
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true },
    services: { ready: async () => false,
      async start() { started(); await startup; },
      stopProviders: async () => {}, stopDatabases: async () => {} },
    readState: () => null, writeState: (_path, state) => state
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  const disconnected = new Promise((resolve) => server.once('request', (_request, response) => {
    response.once('close', resolve);
  }));
  const controller = new AbortController();
  try {
    const acquiring = fetch(`${url}/api/system/runtime/leases`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'graph', owner: 'disconnected-cold-start-test' }),
      signal: controller.signal
    });
    await starting;
    controller.abort();
    await assert.rejects(acquiring, { name: 'AbortError' });
    await disconnected;
    finishStartup();
    const state = await getJson(`${url}/api/system/runtime`);
    assert.equal(state.stage, 'awake');
    assert.equal(state.activeLeaseCount, 0, 'a lease with no connected recipient must be retired');
  } finally {
    finishStartup();
    await closeServer(server);
  }
});

test('a transient heartbeat failure does not abandon an active HTTP lease', async () => {
  // Real HTTP, client and broker; only persisted settings and one network failure are synthetic.
  const paths = {
    dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json'
  };
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true },
    services: { ready: async () => true, start: async () => {},
      stopProviders: async () => {}, stopDatabases: async () => {} },
    readState: () => null, writeState: (_path, state) => state
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  let refreshed;
  const recovered = new Promise((resolve) => { refreshed = resolve; });
  let patches = 0;
  const client = createRuntimeLeaseClient({
    runtimeConfigPath: 'synthetic-only/runtime.json', paths,
    readSettings: () => ({ enabled: true, leaseTtlSeconds: 30 }),
    readJson: () => ({ url }), setHeartbeat: (callback) => setInterval(callback, 10),
    async fetchImpl(input, options) {
      if (options.method === 'PATCH' && ++patches === 1) throw new Error('Synthetic transient network failure');
      const response = await fetch(input, options);
      if (options.method === 'PATCH' && (await response.clone().json()).refreshed) refreshed();
      return response;
    }
  });
  let deadline;
  try {
    await client.withGraphLease('transient-heartbeat-test', async () => {
      await Promise.race([recovered, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Heartbeat never recovered')), 1000);
      })]);
      assert.equal((await getJson(`${url}/api/system/runtime`)).activeLeaseCount, 1);
    });
    assert.equal((await getJson(`${url}/api/system/runtime`)).activeLeaseCount, 0);
  } finally {
    clearTimeout(deadline);
    await client.close();
    await closeServer(server);
  }
});

test('closing a lease client retires a handle delivered after shutdown began', async () => {
  // Real HTTP, client and broker; persisted settings and response delivery timing are synthetic.
  const paths = { dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json' };
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true },
    services: { ready: async () => true, start: async () => {},
      stopProviders: async () => {}, stopDatabases: async () => {} },
    readState: () => null, writeState: (_path, state) => state
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  let responseArrived;
  const received = new Promise((resolve) => { responseArrived = resolve; });
  let deliverResponse;
  const delivery = new Promise((resolve) => { deliverResponse = resolve; });
  const client = createRuntimeLeaseClient({
    runtimeConfigPath: 'synthetic-only/runtime.json', paths,
    readSettings: () => ({ enabled: true, leaseTtlSeconds: 30 }),
    readJson: () => ({ url }),
    async fetchImpl(input, options) {
      const response = await fetch(input, options);
      if (options.method === 'POST') {
        responseArrived();
        await delivery;
      }
      return response;
    }
  });
  try {
    const acquiring = client.acquireGraphLease('closing-client-test');
    await received;
    const closing = client.close();
    deliverResponse();
    await assert.rejects(acquiring, /closed/iu);
    await closing;
    assert.equal((await getJson(`${url}/api/system/runtime`)).activeLeaseCount, 0);
    await assert.rejects(client.acquireGraphLease('after-close'), /closed/iu);
  } finally {
    deliverResponse();
    await client.close();
    await closeServer(server);
  }
});

test('failed idle shutdown waits before retrying instead of immediately looping', async () => {
  const clock = syntheticRuntimeClock();
  let stops = 0;
  const paths = { dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json' };
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true, providerIdleSeconds: 60, databaseIdleSeconds: 180 },
    services: {
      ready: async () => true, start: async () => {}, stopDatabases: async () => {},
      async stopProviders() { if (++stops === 1) throw new Error('Synthetic shutdown failure'); }
    },
    readState: () => null, writeState: (_path, state) => state,
    ...clock.dependencies
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  try {
    const acquired = await requestJson(`${url}/api/system/runtime/leases`, {
      method: 'POST', body: { kind: 'graph', owner: 'idle-failure-test' }
    });
    await requestJson(`${url}/api/system/runtime/leases/${acquired.body.leaseId}`, { method: 'DELETE' });
    await clock.advance(60_000);
    assert.equal(stops, 1, 'a failed stop must not be immediately retried');
    assert.equal((await getJson(`${url}/api/system/runtime`)).stage, 'degraded');
    await clock.advance(30_000);
    assert.equal(stops, 2);
    assert.equal((await getJson(`${url}/api/system/runtime`)).stage, 'provider-sleeping');
  } finally {
    await closeServer(server);
  }
});

test('a failed managed worker stop retries after a delay', async () => {
  // Real HTTP/service/broker; adapter failure, graph services, storage and time are synthetic.
  const clock = syntheticRuntimeClock();
  let stops = 0;
  let running = false;
  const paths = { dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json' };
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true, executorIdleSeconds: 60 },
    services: { ready: async () => true, start: async () => {},
      stopProviders: async () => {}, stopDatabases: async () => {} },
    executorAdapters: new Map([['synthetic-worker', {
      async start() { running = true; },
      async stop() {
        if (++stops === 1) throw new Error('Synthetic worker shutdown failure');
        running = false;
      }
    }]]),
    readState: () => null, writeState: (_path, state) => state,
    ...clock.dependencies
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  try {
    const acquired = await requestJson(`${url}/api/system/runtime/leases`, {
      method: 'POST', body: { kind: 'executor', executorId: 'synthetic-worker', owner: 'stop-retry-test' }
    });
    assert.equal(acquired.status, 201);
    await requestJson(`${url}/api/system/runtime/leases/${acquired.body.leaseId}`, { method: 'DELETE' });
    await clock.advance(60_000);
    assert.equal(stops, 1, 'a failed worker stop must not immediately loop');
    assert.equal(running, true);
    assert.equal((await getJson(`${url}/api/system/runtime`)).executors[0].stage, 'failed');
    await clock.advance(29_999);
    assert.equal(stops, 1);
    await clock.advance(1);
    assert.equal(stops, 2, 'an idle failed worker must be cleaned up on retry');
    assert.equal(running, false);
    assert.equal((await getJson(`${url}/api/system/runtime`)).executors[0].stage, 'idle');
  } finally {
    await system.close();
    await closeServer(server);
  }
});

test('reacquiring a worker with failed shutdown never starts a duplicate process', async () => {
  const clock = syntheticRuntimeClock();
  let starts = 0;
  let canStop = false;
  const paths = { dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json' };
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true, executorIdleSeconds: 60 },
    services: { ready: async () => true, start: async () => {},
      stopProviders: async () => {}, stopDatabases: async () => {} },
    executorAdapters: new Map([['synthetic-worker', {
      async start() { starts++; },
      async stop() { if (!canStop) throw new Error('Synthetic worker still running'); }
    }]]),
    readState: () => null, writeState: (_path, state) => state,
    ...clock.dependencies
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  const acquire = () => requestJson(`${url}/api/system/runtime/leases`, {
    method: 'POST', body: { kind: 'executor', executorId: 'synthetic-worker', owner: 'no-duplicate-test' }
  });
  try {
    const acquired = await acquire();
    assert.equal(acquired.status, 201);
    await requestJson(`${url}/api/system/runtime/leases/${acquired.body.leaseId}`, { method: 'DELETE' });
    await clock.advance(60_000);
    const blocked = await acquire();
    assert.equal(blocked.status, 500, 'unconfirmed cleanup must reject a new acquisition');
    assert.equal(starts, 1, 'failed shutdown does not authorize starting another worker');
    assert.equal((await getJson(`${url}/api/system/runtime`)).activeLeaseCount, 0);
    canStop = true;
    const recovered = await acquire();
    assert.equal(recovered.status, 201);
    assert.equal(starts, 2, 'a new worker may start only after cleanup succeeds');
  } finally {
    canStop = true;
    await system.close();
    await closeServer(server);
  }
});

test('a failed runtime wake remains diagnosable through the status API', async () => {
  const paths = { dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json' };
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true },
    services: {
      ready: async () => false,
      start: async () => { throw new Error('Synthetic provider startup failure'); },
      stopProviders: async () => {}, stopDatabases: async () => {}
    },
    readState: () => null, writeState: (_path, state) => state
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  try {
    const acquired = await requestJson(`${url}/api/system/runtime/leases`, {
      method: 'POST', body: { kind: 'graph', owner: 'failed-wake-test' }
    });
    assert.equal(acquired.status, 500);
    const state = await getJson(`${url}/api/system/runtime`);
    assert.equal(state.stage, 'degraded');
    assert.equal(state.lastError, 'Synthetic provider startup failure');
  } finally {
    await closeServer(server);
  }
});

test('cleaning up a partial worker start preserves the startup failure diagnosis', async () => {
  const clock = syntheticRuntimeClock();
  let running = false;
  const paths = { dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json' };
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true, executorIdleSeconds: 60 },
    services: { ready: async () => true, start: async () => {},
      stopProviders: async () => {}, stopDatabases: async () => {} },
    executorAdapters: new Map([['synthetic-worker', {
      async start() {
        running = true;
        throw new Error('Synthetic worker readiness failure');
      },
      async stop() { running = false; }
    }]]),
    readState: () => null, writeState: (_path, state) => state,
    ...clock.dependencies
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  try {
    const failed = await requestJson(`${url}/api/system/runtime/leases`, {
      method: 'POST', body: { kind: 'executor', executorId: 'synthetic-worker', owner: 'startup-diagnosis-test' }
    });
    assert.equal(failed.status, 500);
    assert.equal(running, true, 'startup can fail after allocating resources');
    await clock.advance(60_000);
    assert.equal(running, false, 'partial startup resources still need cleanup');
    const executor = (await getJson(`${url}/api/system/runtime`)).executors[0];
    assert.equal(executor.stage, 'idle');
    assert.equal(executor.activeLeaseCount, 0);
    assert.equal(executor.lastError, 'Synthetic worker readiness failure');
  } finally {
    await system.close();
    await closeServer(server);
  }
});

test('system shutdown stops its managed worker without taking ownership of external hosts', async () => {
  // A real disposable Node worker; only graph startup and persisted state are substitutes.
  const paths = { dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json' };
  let worker;
  const stopWorker = async () => {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const exited = once(worker, 'exit');
    worker.kill('SIGTERM');
    await exited;
  };
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true },
    services: { ready: async () => true, start: async () => {},
      stopProviders: async () => {}, stopDatabases: async () => {} },
    executorAdapters: new Map([['synthetic-owned-worker', {
      async start() {
        worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        await once(worker, 'spawn');
      },
      stop: stopWorker
    }]]),
    readState: () => null, writeState: (_path, state) => state
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  try {
    const managed = await requestJson(`${url}/api/system/runtime/leases`, {
      method: 'POST', body: { kind: 'executor', executorId: 'synthetic-owned-worker', owner: 'shutdown-test' }
    });
    assert.equal(managed.status, 201);
    const external = await requestJson(`${url}/api/system/runtime/leases`, {
      method: 'POST', body: { kind: 'executor', executorId: 'synthetic-external-host', owner: 'shutdown-test' }
    });
    assert.equal(external.status, 201);
    await system.close();
    assert.equal(worker.signalCode, 'SIGTERM', 'shutdown must wait for its owned worker to exit');
    const state = await getJson(`${url}/api/system/runtime`);
    assert.equal(state.activeLeaseCount, 0);
    assert.deepEqual(state.executors.map(({ managed, stage, activeLeaseCount }) =>
      ({ managed, stage, activeLeaseCount })), [
      { managed: true, stage: 'idle', activeLeaseCount: 0 },
      { managed: false, stage: 'external', activeLeaseCount: 0 }
    ]);
  } finally {
    await closeServer(server);
    await stopWorker();
  }
});

test('released external executor entries do not accumulate in runtime status', async () => {
  // Real HTTP/service/broker; graph startup and persistence are synthetic, no external worker is started.
  const paths = { dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json' };
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true },
    services: { ready: async () => true, start: async () => {},
      stopProviders: async () => {}, stopDatabases: async () => {} },
    readState: () => null, writeState: (_path, state) => state
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  const acquire = async (executorId) => {
    const response = await requestJson(`${url}/api/system/runtime/leases`, {
      method: 'POST', body: { kind: 'executor', executorId, owner: 'external-entry-test' }
    });
    assert.equal(response.status, 201);
    return response.body.leaseId;
  };
  const release = async (leaseId) => {
    assert.equal((await requestJson(`${url}/api/system/runtime/leases/${leaseId}`, {
      method: 'DELETE'
    })).body.released, true);
  };
  try {
    const first = await acquire('synthetic-shared-host');
    const second = await acquire('synthetic-shared-host');
    await release(first);
    assert.equal((await getJson(`${url}/api/system/runtime`)).executors[0].activeLeaseCount, 1);
    await release(second);
    assert.deepEqual((await getJson(`${url}/api/system/runtime`)).executors, []);
    for (let index = 0; index < 12; index += 1) {
      await release(await acquire(`synthetic-host-${index}`));
    }
    assert.deepEqual((await getJson(`${url}/api/system/runtime`)).executors, []);
    await release(await acquire('synthetic-shared-host'));
    assert.equal((await getJson(`${url}/api/system/runtime`)).activeLeaseCount, 0);
  } finally {
    await closeServer(server);
  }
});

test('a malformed successful response with a lease ID is reclaimed through real HTTP', async () => {
  // Actual HTTP acquisition/release; only the response's enabled flag is deliberately corrupted.
  const paths = { dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json',
    adaptiveRuntimeSettingsPath: 'synthetic-only/adaptive-settings.json',
    graphRuntimeStatePath: 'synthetic-only/graph-state.json' };
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true },
    services: { ready: async () => true, start: async () => {},
      stopProviders: async () => {}, stopDatabases: async () => {} },
    readState: () => null, writeState: (_path, state) => state
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  const client = createRuntimeLeaseClient({
    runtimeConfigPath: 'synthetic-only/config.json', paths,
    readSettings: () => ({ enabled: true }), readJson: () => ({ url }),
    fetchImpl: async (requestUrl, init) => {
      const response = await fetch(requestUrl, init);
      if (init.method !== 'POST') return response;
      assert.equal(response.status, 201);
      const value = await response.json();
      assert.equal((await getJson(`${url}/api/system/runtime`)).activeLeaseCount, 1);
      return Response.json({ ...value, enabled: 'true' });
    }
  });
  try {
    await assert.rejects(client.withGraphLease('malformed-response', async () => {
      assert.fail('an invalid acquisition must not start the protected operation');
    }), /invalid.*lease.*response/i);
    assert.equal((await getJson(`${url}/api/system/runtime`)).activeLeaseCount, 0);
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test('malformed percent encoding in a lease ID is a client error without releasing the lease', async () => {
  // Real HTTP/service/broker; graph services and persisted state are synthetic.
  const paths = { dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json' };
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true },
    services: { ready: async () => true, start: async () => {},
      stopProviders: async () => {}, stopDatabases: async () => {} },
    readState: () => null, writeState: (_path, state) => state
  });
  const system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  try {
    const acquired = await requestJson(`${url}/api/system/runtime/leases`, {
      method: 'POST', body: { kind: 'graph', owner: 'malformed-id-test' }
    });
    assert.equal(acquired.status, 201);
    for (const method of ['PATCH', 'DELETE']) {
      const invalid = await requestJson(`${url}/api/system/runtime/leases/%ZZ`, {
        method, ...(method === 'PATCH' ? { body: {} } : {})
      });
      assert.equal(invalid.status, 400);
      assert.equal((await getJson(`${url}/api/system/runtime`)).activeLeaseCount, 1);
    }
    const released = await requestJson(`${url}/api/system/runtime/leases/${acquired.body.leaseId}`, {
      method: 'DELETE'
    });
    assert.equal(released.body.released, true);
  } finally {
    await closeServer(server);
  }
});

test('runtime shutdown during wake does not return a successful lease', async () => {
  // Only graph startup and state storage are substitutes; the HTTP stack is real.
  const paths = {
    dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json'
  };
  let system;
  const broker = createAdaptiveRuntimeBroker({
    paths,
    settings: { enabled: true },
    services: {
      ready: async () => false,
      start: async () => { system.close(); },
      stopProviders: async () => {},
      stopDatabases: async () => {}
    },
    readState: () => ({
      version: 1, stage: 'sleeping', lastError: null,
      lastActivityAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z'
    }),
    writeState: (_path, state) => structuredClone(state)
  });
  system = createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
  const { server, url } = await createServer({ app: { close() {} }, system, port: 0 });
  try {
    const acquired = await requestJson(`${url}/api/system/runtime/leases`, {
      method: 'POST', body: { kind: 'graph', owner: 'shutdown-during-wake-test' }
    });
    assert.equal(acquired.status, 500, 'shutdown must reject a pending acquisition');
    assert.equal(acquired.body.leaseId, undefined);
    assert.equal((await getJson(`${url}/api/system/runtime`)).activeLeaseCount, 0);
  } finally {
    await closeServer(server);
  }
});

function syntheticRuntimeClock() {
  let now = Date.UTC(2026, 7, 31);
  const timers = new Map();
  return {
    dependencies: {
      now: () => now,
      setTimer(callback, delay) {
        const handle = { unref() {} };
        timers.set(handle, { callback, at: now + delay });
        return handle;
      },
      clearTimer: (handle) => timers.delete(handle)
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      for (let turns = 0; turns < 100; turns++) {
        const next = [...timers.entries()].filter(([, value]) => value.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) { now = target; return; }
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.fail('Runtime timers did not make time progress');
    }
  };
}
