import { testToolsEnabled } from './test-tools.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage();
// Module-private: tool payloads, JSON and HTTP bodies cannot carry this key.
const SEALED_WORKER = Symbol('fuli.sealedWorkerRequest');
const HOST_SESSION = Symbol('fuli.agentHostSession');

export function runWithAgentRequestContext(value, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('Agent request context operation is required');
  }
  const signal = abortSignal(value?.signal);
  signal?.throwIfAborted();
  return requestContext.run({ signal, testToolsEnabled: value?.testToolsEnabled ?? testToolsEnabled(),
    sealedWorker: value?.[SEALED_WORKER] === true,
    hostSession: value && Object.hasOwn(value, HOST_SESSION) ? value[HOST_SESSION] : undefined }, operation);
}

// Only the worker MCP composition calls this, after the Provider admitted the
// sealed run for this call. It marks provenance; it grants no permission.
export function sealedWorkerRequestContext(value) {
  return { ...(value ?? {}), [SEALED_WORKER]: true };
}

// An Agent's own call through FULI's MCP server or CLI: the host session its
// client process runs in, from host provenance only: the client's native
// session (its environment or per-request native context), else the session
// FULI's composition gave that process. Never a tool argument.
// Every capture decision of the call also applies to that session (rec#5 C3).
export function agentHostRequestContext(value, hostSessionId) {
  return { ...(value ?? {}), [HOST_SESSION]: hostSessionId ?? null };
}

// The host session of the Agent call being served: a session ID, null when the
// client named none, undefined outside an Agent's own call (hooks, console).
export function activeAgentHostSession() {
  return requestContext.getStore()?.hostSession;
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
