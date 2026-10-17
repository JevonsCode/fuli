import { testToolsEnabled } from './test-tools.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage();
// Module-private: tool payloads, JSON and HTTP bodies cannot carry this key.
const SEALED_WORKER = Symbol('fuli.sealedWorkerRequest');

export function runWithAgentRequestContext(value, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('Agent request context operation is required');
  }
  const signal = abortSignal(value?.signal);
  signal?.throwIfAborted();
  return requestContext.run({ signal, testToolsEnabled: value?.testToolsEnabled ?? testToolsEnabled(),
    sealedWorker: value?.[SEALED_WORKER] === true }, operation);
}

// Only the worker MCP composition calls this, after the Provider admitted the
// sealed run for this call. It marks provenance; it grants no permission.
export function sealedWorkerRequestContext(value) {
  return { ...(value ?? {}), [SEALED_WORKER]: true };
}

export function activeSealedWorkerRequest() {
  return requestContext.getStore()?.sealedWorker === true;
}

export function activeAgentRequestSignal() {
  return requestContext.getStore()?.signal ?? null;
}

function abortSignal(value) {
  return value && typeof value.addEventListener === 'function' &&
    typeof value.throwIfAborted === 'function'
    ? value
    : null;
}

export function activeTestToolsEnabled() {
  return requestContext.getStore()?.testToolsEnabled ?? testToolsEnabled();
}
