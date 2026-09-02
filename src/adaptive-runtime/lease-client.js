import { dirname } from 'node:path';

import { resolveSetupPaths } from '../setup/paths.js';
import { readJsonFile } from '../storage/json-file.js';
import { readAdaptiveRuntimeSettings } from './settings.js';

export function createRuntimeLeaseClient({
  runtimeConfigPath,
  paths = resolveSetupPaths({ dataDir: dirname(runtimeConfigPath) }),
  readJson = readJsonFile,
  readSettings = readAdaptiveRuntimeSettings,
  fetchImpl = globalThis.fetch,
  setHeartbeat = setInterval,
  clearHeartbeat = clearInterval
}) {
  const leases = new Map();
  const acquisitions = new Set();
  let closed = false;

  async function withGraphLease(owner, operation, requestContext = null) {
    return withLease({ kind: 'graph', owner }, operation, requestContext);
  }

  async function withExecutorLease(executorId, owner, operation, requestContext = null) {
    return withLease({ kind: 'executor', executorId, owner }, operation, requestContext);
  }

  async function acquireGraphLease(owner) {
    return acquireLease({ kind: 'graph', owner });
  }

  async function acquireExecutorLease(executorId, owner) {
    return acquireLease({ kind: 'executor', executorId, owner });
  }

  async function acquireLease(input, signal = null) {
    assertOpen();
    signal?.throwIfAborted();
    const acquisition = acquireOpenLease(input, signal);
    acquisitions.add(acquisition);
    try {
      return await acquisition;
    } finally {
      acquisitions.delete(acquisition);
    }
  }

  async function acquireOpenLease(input, signal = null) {
    const settings = readSettings(paths.adaptiveRuntimeSettingsPath);
    if (!settings.enabled) return disabledLease();

    const consoleUrl = runtimeConsoleUrl(readJson(paths.graphRuntimeStatePath, null));
    const lease = await requestJson(`${consoleUrl}/api/system/runtime/leases`, {
      method: 'POST',
      body: input,
      timeoutMs: 180_000,
      fetchImpl,
      signal
    });
    const handle = publicLease(lease);
    if (!handle.enabled) {
      const explicitlyDisabled = lease?.enabled === false && lease.leaseId === null;
      if (!explicitlyDisabled) {
        // Preserve a usable ID before rejecting a malformed success response.
        // Without one, remote TTL is the only available cleanup mechanism.
        if (typeof lease?.leaseId === 'string' && lease.leaseId.trim()) {
          await releaseRemote({ consoleUrl, handle: { leaseId: lease.leaseId } }).catch(() => {});
        }
        throw new Error('Invalid runtime lease response');
      }
      assertOpen();
      signal?.throwIfAborted();
      return handle;
    }

    const entry = {
      handle,
      consoleUrl,
      heartbeat: null,
      heartbeatActive: false,
      refreshPromise: null,
      released: false
    };
    leases.set(handle.leaseId, entry);
    try {
      assertOpen();
      signal?.throwIfAborted();
      startHeartbeat(entry, settings);
      return { ...entry.handle };
    } catch (error) {
      removeLease(entry);
      await releaseRemote(entry).catch(() => {});
      throw error;
    }
  }

  async function refreshLease(reference) {
    const entry = findLease(reference);
    if (!entry) return { ...leaseReference(reference), refreshed: false };
    return refreshEntry(entry);
  }

  async function releaseLease(reference) {
    const entry = findLease(reference);
    if (!entry) return { ...leaseReference(reference), released: false };

    const pendingRefresh = entry.refreshPromise;
    removeLease(entry);
    if (pendingRefresh) await pendingRefresh.catch(() => {});

    try {
      const result = await releaseRemote(entry);
      return {
        ...entry.handle,
        released: result?.released !== false
      };
    } catch {
      return { ...entry.handle, released: false };
    }
  }

  async function withLease(input, operation, requestContext = null) {
    if (typeof operation !== 'function') throw new TypeError('Runtime operation is required');
    const signal = agentRequestSignal(requestContext);
    signal?.throwIfAborted();
    const handle = await acquireLease(input, signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      await releaseLease(handle);
    }
  }

  async function close() {
    closed = true;
    const handles = [...leases.values()].map(({ handle }) => ({ ...handle }));
    await Promise.allSettled([
      ...acquisitions,
      ...handles.map((handle) => releaseLease(handle))
    ]);
  }

  function assertOpen() {
    if (closed) throw new Error('Runtime lease client is closed');
  }

  function startHeartbeat(entry, settings) {
    if (entry.heartbeatActive || entry.released) return;
    const ttlSeconds = Number(settings.leaseTtlSeconds);
    const heartbeatMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? Math.max(1000, Math.floor(ttlSeconds * 1000 / 3))
      : 1000;
    let heartbeat;
    try {
      heartbeat = setHeartbeat(() => {
        if (!entry.heartbeatActive || entry.released) return;
        void refreshEntry(entry).catch(() => {});
      }, heartbeatMs);
      entry.heartbeat = heartbeat;
      entry.heartbeatActive = true;
      heartbeat?.unref?.();
    } catch (error) {
      entry.heartbeat = null;
      entry.heartbeatActive = false;
      if (heartbeat !== undefined) {
        try {
          clearHeartbeat(heartbeat);
        } catch {
          // A failed cleanup must not hide the heartbeat setup error.
        }
      }
      throw error;
    }
  }

  function stopHeartbeat(entry) {
    if (!entry.heartbeatActive && entry.heartbeat === null) return;
    const heartbeat = entry.heartbeat;
    entry.heartbeat = null;
    entry.heartbeatActive = false;
    if (heartbeat !== undefined && heartbeat !== null) {
      try {
        clearHeartbeat(heartbeat);
      } catch {
        // Releasing a lease remains best effort even if timer cleanup fails.
      }
    }
  }

  function removeLease(entry) {
    if (entry.released) return;
    entry.released = true;
    stopHeartbeat(entry);
    if (leases.get(entry.handle.leaseId) === entry) leases.delete(entry.handle.leaseId);
  }

  async function refreshEntry(entry) {
    if (entry.released || leases.get(entry.handle.leaseId) !== entry) {
      return { ...entry.handle, refreshed: false };
    }
    if (entry.refreshPromise) return entry.refreshPromise;

    const promise = (async () => {
      try {
        const result = await requestJson(
          `${entry.consoleUrl}/api/system/runtime/leases/${encodeURIComponent(entry.handle.leaseId)}`,
          { method: 'PATCH', body: {}, timeoutMs: 10_000, fetchImpl }
        );
        if (entry.released || leases.get(entry.handle.leaseId) !== entry) {
          return { ...entry.handle, refreshed: false };
        }
        const refreshed = result?.refreshed !== false;
        const nextHandle = publicLease({ ...entry.handle, ...result });
        if (nextHandle.enabled) entry.handle = nextHandle;
        if (!refreshed) {
          removeLease(entry);
        } else if (!entry.heartbeatActive) {
          try {
            startHeartbeat(entry, readSettings(paths.adaptiveRuntimeSettingsPath));
          } catch {
            // The successful manual refresh still extends the remote lease.
            // The next explicit refresh can retry heartbeat setup.
          }
        }
        return { ...entry.handle, refreshed };
      } catch (error) {
        // A transient request failure must not abandon a still-running operation.
        // The next heartbeat retries; release/close or refreshed:false stops it.
        throw error;
      }
    })();
    entry.refreshPromise = promise;
    try {
      return await promise;
    } finally {
      if (entry.refreshPromise === promise) entry.refreshPromise = null;
    }
  }

  function findLease(reference) {
    const leaseId = leaseReference(reference).leaseId;
    return leaseId ? leases.get(leaseId) ?? null : null;
  }

  async function releaseRemote(entry) {
    return requestJson(
      `${entry.consoleUrl}/api/system/runtime/leases/${encodeURIComponent(entry.handle.leaseId)}`,
      { method: 'DELETE', timeoutMs: 10_000, fetchImpl }
    );
  }

  return {
    acquireGraphLease,
    acquireExecutorLease,
    refreshLease,
    releaseLease,
    withGraphLease,
    withExecutorLease,
    close
  };
}

export function bindRuntimeLeaseAgentTools(application, leaseClient) {
  if (!application || typeof application !== 'object') {
    throw new TypeError('Runtime lease application is required');
  }
  for (const method of [
    'acquireGraphLease',
    'acquireExecutorLease',
    'refreshLease',
    'releaseLease'
  ]) {
    if (typeof leaseClient?.[method] !== 'function') {
      throw new TypeError(`Runtime lease client is missing ${method}`);
    }
  }
  application.acquireRuntimeLease = ({ kind, executorId = null, owner }) => {
    if (kind === 'graph') {
      if (executorId !== null && executorId !== undefined) {
        throw new TypeError('Graph runtime lease cannot select an executor');
      }
      return leaseClient.acquireGraphLease(owner);
    }
    if (kind === 'executor') {
      if (typeof executorId !== 'string' || !executorId.trim()) {
        throw new TypeError('Executor runtime lease requires executorId');
      }
      return leaseClient.acquireExecutorLease(executorId, owner);
    }
    throw new TypeError('Runtime lease kind must be graph or executor');
  };
  application.refreshRuntimeLease = ({ leaseId }) =>
    leaseClient.refreshLease(leaseId);
  application.releaseRuntimeLease = ({ leaseId }) =>
    leaseClient.releaseLease(leaseId);
  return application;
}

function disabledLease() {
  return { enabled: false, leaseId: null };
}

function leaseReference(value) {
  if (typeof value === 'string' && value) return { enabled: true, leaseId: value };
  return publicLease(value);
}

function publicLease(value, fallback = null) {
  const source = {
    ...(fallback && typeof fallback === 'object' ? fallback : {}),
    ...(value && typeof value === 'object' ? value : {})
  };
  if (source.enabled !== true || typeof source.leaseId !== 'string' || !source.leaseId.trim()) {
    return disabledLease();
  }
  const handle = {
    enabled: true,
    leaseId: source.leaseId
  };
  if (typeof source.kind === 'string') handle.kind = source.kind;
  if (source.executorId === null || typeof source.executorId === 'string') {
    handle.executorId = source.executorId;
  }
  for (const key of ['acquiredAt', 'expiresAt']) {
    if (source[key] === null || typeof source[key] === 'string') handle[key] = source[key];
  }
  return handle;
}

function runtimeConsoleUrl(state) {
  if (!state || typeof state.url !== 'string') {
    throw new Error('Adaptive memory needs the Fuli management UI; run `fuli start` first');
  }
  let url;
  try {
    url = new URL(state.url);
  } catch {
    throw new Error('The recorded Fuli management UI address is invalid');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) ||
    url.username || url.password ||
    (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash
  ) {
    throw new Error('Adaptive memory only accepts the recorded loopback Fuli management UI');
  }
  return url.origin;
}

async function requestJson(url, {
  method,
  body,
  timeoutMs,
  fetchImpl,
  signal = null
}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal
  });
  if (!response.ok) {
    let detail = null;
    try {
      const value = await response.json();
      detail = typeof value?.message === 'string'
        ? value.message
        : typeof value?.error === 'string' ? value.error : null;
    } catch {
      // The status is enough when the local coordinator did not return JSON.
    }
    throw new Error(detail ?? `Adaptive runtime request failed (${response.status})`);
  }
  return response.json();
}

function agentRequestSignal(value) {
  const signal = value?.signal;
  return signal && typeof signal.addEventListener === 'function' &&
    typeof signal.throwIfAborted === 'function'
    ? signal
    : null;
}
