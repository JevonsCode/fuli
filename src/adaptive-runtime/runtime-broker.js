import { randomUUID } from 'node:crypto';

import { createExecutorPool } from './executor-pool.js';
import { createGraphServices } from './graph-services.js';
import { normalizeAdaptiveRuntimeSettings } from './settings.js';
import {
  initialAdaptiveRuntimeState,
  readAdaptiveRuntimeState,
  writeAdaptiveRuntimeState
} from './state.js';

const IDLE_FAILURE_RETRY_MS = 30_000;

export function createAdaptiveRuntimeBroker({
  paths,
  settings,
  services = createGraphServices({ paths }),
  executorAdapters = new Map(),
  readState = readAdaptiveRuntimeState,
  writeState = writeAdaptiveRuntimeState,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const configured = normalizeAdaptiveRuntimeSettings(settings);
  const leases = new Map();
  const executorPool = createExecutorPool({
    adapters: executorAdapters,
    idleMs: configured.executorIdleSeconds * 1000,
    setTimer,
    clearTimer
  });
  let state = initializeState();
  let providerTimer = null;
  let databaseTimer = null;
  let transition = Promise.resolve();
  let closed = false;
  let closePromise = null;
  let idleRetryAt = 0;

  scheduleIdle();

  async function acquire(input = {}) {
    if (!configured.enabled) return disabledLease();
    assertOpen();
    const kind = input.kind ?? 'graph';
    if (!['graph', 'executor'].includes(kind)) {
      throw new TypeError('Runtime lease kind must be graph or executor');
    }
    const executorId = kind === 'executor' ? requiredExecutorId(input.executorId) : null;
    const leaseId = randomUUID();
    const lease = {
      leaseId,
      kind,
      executorId,
      owner: ownerText(input.owner),
      acquiredAt: isoNow(),
      expiresAt: null,
      timer: null
    };
    leases.set(leaseId, lease);
    clearIdleTimers();
    try {
      await exclusive(async () => {
        assertOpen();
        await ensureAwake();
        if (executorId) await executorPool.acquire(executorId, leaseId);
      });
      assertOpen();
      idleRetryAt = 0;
      // The caller can only heartbeat after startup returns its lease handle.
      armExpiry(lease);
      return publicLease(lease);
    } catch (error) {
      leases.delete(leaseId);
      if (lease.timer) clearTimer(lease.timer);
      if (executorId) executorPool.release(executorId, leaseId);
      touch(errorMessage(error));
      scheduleIdle();
      throw error;
    }
  }

  function refresh(leaseId) {
    const lease = leases.get(validLeaseId(leaseId));
    if (!lease) return { refreshed: false };
    armExpiry(lease);
    return { refreshed: true, ...publicLease(lease) };
  }

  function release(leaseId) {
    const normalized = validLeaseId(leaseId);
    const lease = leases.get(normalized);
    if (!lease) return { released: false };
    leases.delete(normalized);
    if (lease.timer) clearTimer(lease.timer);
    if (lease.executorId) executorPool.release(lease.executorId, normalized);
    touch();
    scheduleIdle();
    return { released: true };
  }

  async function withLease(input, operation) {
    if (typeof operation !== 'function') throw new TypeError('Runtime operation is required');
    if (!configured.enabled) return operation();
    const lease = await acquire(input);
    const stopHeartbeat = scheduleHeartbeat(lease.leaseId);
    try {
      return await operation();
    } finally {
      stopHeartbeat();
      release(lease.leaseId);
    }
  }

  function status() {
    const lastActivityMs = Date.parse(state.lastActivityAt);
    return {
      enabled: configured.enabled,
      stage: state.stage,
      activeLeaseCount: leases.size,
      lastActivityAt: state.lastActivityAt,
      updatedAt: state.updatedAt,
      nextProviderSleepAt: nextSleepAt(lastActivityMs, configured.providerIdleSeconds, [
        'awake', 'degraded'
      ]),
      nextDatabaseSleepAt: nextSleepAt(lastActivityMs, configured.databaseIdleSeconds, [
        'awake', 'provider-sleeping', 'degraded'
      ]),
      lastError: state.lastError,
      settings: configured,
      executors: executorPool.status()
    };
  }

  function close() {
    if (closed) return closePromise;
    closed = true;
    clearIdleTimers();
    for (const lease of leases.values()) {
      if (lease.timer) clearTimer(lease.timer);
    }
    leases.clear();
    closePromise = executorPool.close();
    return closePromise;
  }

  function assertOpen() {
    if (closed) throw new Error('Adaptive runtime coordinator is closed');
  }

  async function ensureAwake() {
    const alreadyReady = state.stage === 'awake' &&
      (typeof services.ready !== 'function' || await services.ready());
    if (alreadyReady) return;
    persist('waking');
    try {
      await services.start();
      persist('awake');
    } catch (error) {
      persist('degraded', errorMessage(error));
      throw error;
    }
  }

  function scheduleIdle() {
    clearIdleTimers();
    if (!configured.enabled || closed || leases.size > 0) return;
    const lastActivityMs = Date.parse(state.lastActivityAt);
    if (['awake', 'degraded'].includes(state.stage)) {
      providerTimer = scheduleAt(
        lastActivityMs + configured.providerIdleSeconds * 1000,
        sleepProvider
      );
    }
    if (['awake', 'provider-sleeping', 'degraded'].includes(state.stage)) {
      databaseTimer = scheduleAt(
        lastActivityMs + configured.databaseIdleSeconds * 1000,
        sleepDatabase
      );
    }
  }

  function scheduleAt(timestamp, operation) {
    const timer = setTimer(() => {
      void exclusive(async () => {
        if (closed || leases.size > 0) return;
        await operation();
      }).catch((error) => {
        persist('degraded', errorMessage(error));
        // A missed idle deadline must not become a zero-delay failure loop.
        idleRetryAt = now() + IDLE_FAILURE_RETRY_MS;
        scheduleIdle();
      });
    }, Math.max(0, timestamp - now(), idleRetryAt - now()));
    timer?.unref?.();
    return timer;
  }

  async function sleepProvider() {
    if (!['awake', 'degraded'].includes(state.stage)) return;
    await services.stopProviders();
    persist('provider-sleeping');
    scheduleIdle();
  }

  async function sleepDatabase() {
    if (state.stage === 'sleeping') return;
    await services.stopDatabases();
    persist('sleeping');
    clearIdleTimers();
  }

  function exclusive(operation) {
    const result = transition.then(operation, operation);
    transition = result.catch(() => {});
    return result;
  }

  function scheduleHeartbeat(leaseId) {
    const delayMs = Math.max(1000, Math.floor(configured.leaseTtlSeconds * 1000 / 3));
    const token = { cancelled: false, timer: null };
    const beat = () => {
      if (token.cancelled) return;
      if (!refresh(leaseId).refreshed) return;
      token.timer = setTimer(beat, delayMs);
      token.timer?.unref?.();
    };
    token.timer = setTimer(beat, delayMs);
    token.timer?.unref?.();
    return () => {
      token.cancelled = true;
      if (token.timer) clearTimer(token.timer);
      token.timer = null;
    };
  }

  function armExpiry(lease) {
    if (lease.timer) clearTimer(lease.timer);
    const expiresAtMs = now() + configured.leaseTtlSeconds * 1000;
    lease.expiresAt = new Date(expiresAtMs).toISOString();
    lease.timer = setTimer(() => release(lease.leaseId), configured.leaseTtlSeconds * 1000);
    lease.timer?.unref?.();
  }

  function initializeState() {
    const saved = readState(paths.adaptiveRuntimeStatePath);
    const initial = saved ?? initialAdaptiveRuntimeState({
      enabled: configured.enabled,
      now: new Date(now())
    });
    if (!configured.enabled) return persistValue({ ...initial, stage: 'always-on' });
    if (initial.stage === 'always-on' || initial.stage === 'waking') {
      return persistValue({ ...initial, stage: 'awake' });
    }
    return initial;
  }

  function touch(lastError = null) {
    state = persistValue({ ...state, lastActivityAt: isoNow(), lastError });
  }

  function persist(stage, lastError = null) {
    state = persistValue({ ...state, stage, lastError });
  }

  function persistValue(value) {
    const next = {
      ...value,
      version: 1,
      updatedAt: isoNow()
    };
    return writeState(paths.adaptiveRuntimeStatePath, next) ?? next;
  }

  function nextSleepAt(lastActivityMs, idleSeconds, stages) {
    if (!configured.enabled || leases.size > 0 || !stages.includes(state.stage)) return null;
    return new Date(Math.max(lastActivityMs + idleSeconds * 1000, idleRetryAt)).toISOString();
  }

  function clearIdleTimers() {
    if (providerTimer) clearTimer(providerTimer);
    if (databaseTimer) clearTimer(databaseTimer);
    providerTimer = null;
    databaseTimer = null;
  }

  function isoNow() {
    return new Date(now()).toISOString();
  }

  return { acquire, refresh, release, withLease, status, close };
}

function publicLease(lease) {
  return {
    enabled: true,
    leaseId: lease.leaseId,
    kind: lease.kind,
    executorId: lease.executorId,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt
  };
}

function disabledLease() {
  return { enabled: false, leaseId: null };
}

function validLeaseId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new TypeError('Runtime lease ID is invalid');
  }
  return value;
}

function requiredExecutorId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new TypeError('executorId must be non-empty text with at most 200 characters');
  }
  return value.trim();
}

function ownerText(value) {
  const owner = String(value ?? 'unknown').replace(/[\r\n\t]+/g, ' ').trim();
  return owner.slice(0, 200) || 'unknown';
}

function errorMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}
