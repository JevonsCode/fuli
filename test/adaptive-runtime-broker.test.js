import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdaptiveRuntimeBroker } from '../src/adaptive-runtime/runtime-broker.js';
import { DEFAULT_ADAPTIVE_RUNTIME_SETTINGS } from '../src/adaptive-runtime/settings.js';

const PATHS = Object.freeze({ adaptiveRuntimeStatePath: '/data/adaptive-state.json' });

test('graph leases wake cold services and stage Provider then database sleep', async () => {
  const clock = fakeClock();
  const calls = [];
  let ready = false;
  const broker = createAdaptiveRuntimeBroker({
    paths: PATHS,
    settings: enabledSettings(),
    services: {
      ready: async () => ready,
      start: async () => { calls.push('start'); ready = true; },
      stopProviders: async () => { calls.push('stop-providers'); ready = false; },
      stopDatabases: async () => { calls.push('stop-databases'); ready = false; }
    },
    readState: () => stateAt(clock.now(), 'sleeping'),
    writeState: (_path, state) => structuredClone(state),
    ...clock.dependencies
  });

  const lease = await broker.acquire({ kind: 'graph', owner: 'test' });
  assert.deepEqual(calls, ['start']);
  assert.equal(broker.status().stage, 'awake');
  assert.equal(broker.status().activeLeaseCount, 1);

  await clock.advance(120_000);
  assert.deepEqual(calls, ['start'], 'an active lease prevents every idle transition');
  broker.release(lease.leaseId);
  await clock.advance(59_000);
  assert.deepEqual(calls, ['start']);
  await clock.advance(1_000);
  assert.deepEqual(calls, ['start', 'stop-providers']);
  assert.equal(broker.status().stage, 'provider-sleeping');
  await clock.advance(120_000);
  assert.deepEqual(calls, ['start', 'stop-providers', 'stop-databases']);
  assert.equal(broker.status().stage, 'sleeping');
  broker.close();
});

test('managed executors are shared by lease and stop only after their idle window', async () => {
  const clock = fakeClock();
  const adapterCalls = [];
  const adapters = new Map([['local-coder', {
    start: async () => adapterCalls.push('start'),
    stop: async () => adapterCalls.push('stop')
  }]]);
  const broker = createAdaptiveRuntimeBroker({
    paths: PATHS,
    settings: enabledSettings(),
    services: {
      ready: async () => true,
      start: async () => {},
      stopProviders: async () => {},
      stopDatabases: async () => {}
    },
    executorAdapters: adapters,
    readState: () => stateAt(clock.now(), 'awake'),
    writeState: (_path, state) => structuredClone(state),
    ...clock.dependencies
  });

  const first = await broker.acquire({
    kind: 'executor', executorId: 'local-coder', owner: 'task-a'
  });
  const second = await broker.acquire({
    kind: 'executor', executorId: 'local-coder', owner: 'task-b'
  });
  assert.deepEqual(adapterCalls, ['start']);
  assert.equal(broker.status().executors[0].activeLeaseCount, 2);
  broker.release(first.leaseId);
  await clock.advance(120_000);
  assert.deepEqual(adapterCalls, ['start']);
  broker.release(second.leaseId);
  await clock.advance(59_000);
  assert.deepEqual(adapterCalls, ['start']);
  await clock.advance(1_000);
  assert.deepEqual(adapterCalls, ['start', 'stop']);
  assert.equal(broker.status().executors[0].stage, 'idle');
  broker.close();
});

test('unmanaged external executors are never started or killed', async () => {
  const clock = fakeClock();
  const broker = createAdaptiveRuntimeBroker({
    paths: PATHS,
    settings: enabledSettings(),
    services: {
      ready: async () => true,
      start: async () => {},
      stopProviders: async () => {},
      stopDatabases: async () => {}
    },
    readState: () => stateAt(clock.now(), 'awake'),
    writeState: (_path, state) => structuredClone(state),
    ...clock.dependencies
  });
  const lease = await broker.acquire({
    kind: 'executor', executorId: 'host-owned-codex', owner: 'task'
  });
  assert.deepEqual(broker.status().executors[0], {
    executorId: 'host-owned-codex',
    managed: false,
    stage: 'external',
    activeLeaseCount: 1,
    lastError: null
  });
  broker.release(lease.leaseId);
  broker.close();
});

function enabledSettings() {
  return { ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS, enabled: true };
}

function stateAt(now, stage) {
  const timestamp = new Date(now).toISOString();
  return {
    version: 1,
    stage,
    lastActivityAt: timestamp,
    updatedAt: timestamp,
    lastError: null
  };
}

function fakeClock() {
  let now = Date.UTC(2026, 7, 18, 0, 0, 0);
  let sequence = 0;
  const timers = new Map();
  const dependencies = {
    now: () => now,
    setTimer(callback, delay) {
      const handle = { id: ++sequence, unref() {} };
      timers.set(handle.id, { handle, callback, at: now + delay });
      return handle;
    },
    clearTimer(handle) {
      if (handle?.id) timers.delete(handle.id);
    }
  };
  async function advance(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers.values()]
        .filter(({ at }) => at <= target)
        .sort((left, right) => left.at - right.at || left.handle.id - right.handle.id)[0];
      if (!next) break;
      timers.delete(next.handle.id);
      now = next.at;
      next.callback();
      await settle();
    }
    now = target;
    await settle();
  }
  return { now: () => now, dependencies, advance };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
