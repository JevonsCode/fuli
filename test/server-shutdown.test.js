import assert from 'node:assert/strict';
import test from 'node:test';

import { createServer } from '../src/server.js';
import { createAdaptiveRuntimeBroker } from '../src/adaptive-runtime/runtime-broker.js';
import { createSystemService } from '../src/system/system-service.js';
import { closeServer, getJson } from '../test-support/server.js';

test('a failed listen waits for managed worker cleanup and closes its runtime service', async () => {
  // Real HTTP/service/broker; the worker adapter, graph services and storage are synthetic.
  let running = false;
  const system = runtimeSystem({
    async start() { running = true; },
    async stop() {
      await new Promise((resolve) => setImmediate(resolve));
      running = false;
    }
  });
  const blocker = await createServer({ app: { close() {} }, port: 0 });
  try {
    await system.acquireRuntimeLease({ kind: 'executor', executorId: 'synthetic-worker' });
    assert.equal(running, true);
    await assert.rejects(createServer({
      app: { close() {} }, system, port: blocker.server.address().port
    }), { code: 'EADDRINUSE' });
    assert.equal(running, false, 'startup failure must await managed resource shutdown');
    await assert.rejects(system.acquireRuntimeLease({ kind: 'graph' }), /closed/iu);
  } finally {
    await system.close();
    await closeServer(blocker.server);
  }
});

test('explicit server shutdown reports worker failures after closing the owned application', async () => {
  // Synthetic failing worker and owned application boundary; shutdown/service/broker are real.
  let applicationClosed = false;
  const system = runtimeSystem({
    async start() {},
    async stop() { throw new Error('Synthetic worker refuses shutdown'); }
  });
  const runtime = await createServer({
    app: { async close() {
      await new Promise((resolve) => setImmediate(resolve));
      applicationClosed = true;
    } },
    closeApplicationOnShutdown: true, system, port: 0
  });
  try {
    await system.acquireRuntimeLease({ kind: 'executor', executorId: 'synthetic-worker' });
    await assert.rejects(async () => runtime.close(), /synthetic-worker.*refuses shutdown/iu);
    assert.equal(applicationClosed, true);
    assert.equal(runtime.server.listening, false);
    await assert.rejects(async () => runtime.close(), /synthetic-worker.*refuses shutdown/iu);
    assert.equal(system.runtimeStatus().executors[0].stage, 'failed');
  } finally {
    if (runtime.server.listening) await closeServer(runtime.server);
  }
});

test('failed startup preserves both the listen error and the managed cleanup failure', async () => {
  // Real occupied port and runtime service; the failing worker is a boundary substitute.
  const system = runtimeSystem({
    async start() {}, async stop() { throw new Error('Synthetic shutdown failure'); }
  });
  const blocker = await createServer({ app: { close() {} }, port: 0 });
  try {
    await system.acquireRuntimeLease({ kind: 'executor', executorId: 'synthetic-worker' });
    await assert.rejects(createServer({
      app: { close() {} }, system, port: blocker.server.address().port
    }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0].code, 'EADDRINUSE');
      assert.match(error.errors[1].message, /synthetic-worker.*shutdown failure/iu);
      return true;
    });
  } finally {
    await blocker.close();
  }
});

test('a lease cleanup error after a response does not send headers twice or crash the server', async () => {
  // Real HTTP/service/broker; app data and a post-response storage failure are synthetic.
  let diskUnavailable = false;
  const system = runtimeSystem(undefined, (_path, state) => {
    if (diskUnavailable) throw new Error('Synthetic runtime state disk failure');
    return state;
  });
  const runtime = await createServer({
    app: { async state() { diskUnavailable = true; return { ready: true }; }, close() {} },
    system, port: 0
  });
  try {
    assert.deepEqual(await getJson(`${runtime.url}/api/state`), { ready: true });
    assert.equal((await getJson(`${runtime.url}/api/health`)).status, 'ready');
    assert.equal((await getJson(`${runtime.url}/api/system/runtime`)).activeLeaseCount, 0);
  } finally {
    await runtime.close();
  }
});

function runtimeSystem(adapter, writeState = (_path, state) => state) {
  const paths = { dataDir: '.', adaptiveRuntimeStatePath: 'synthetic-only',
    runtimeSettingsPath: 'synthetic-only/runtime-settings.json' };
  const broker = createAdaptiveRuntimeBroker({
    paths, settings: { enabled: true },
    services: { ready: async () => true, start: async () => {},
      stopProviders: async () => {}, stopDatabases: async () => {} },
    executorAdapters: adapter ? new Map([['synthetic-worker', adapter]]) : new Map(),
    readState: () => null, writeState
  });
  return createSystemService({ paths, packageRoot: '.', runtimeBroker: broker });
}
