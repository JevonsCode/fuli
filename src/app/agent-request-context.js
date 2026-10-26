import { testToolsEnabled } from './test-tools.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage();
// Module-private: tool payloads, JSON and HTTP bodies cannot carry this key.
const SEALED_WORKER = Symbol('fuli.sealedWorkerRequest');
const HOST_SESSION = Symbol('fuli.agentHostSession');
const HOST_CLIENT = Symbol('fuli.agentHostClient');

export function runWithAgentRequestContext(value, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('Agent request context operation is required');
  }
  const signal = abortSignal(value?.signal);
  signal?.throwIfAborted();
  return requestContext.run({ signal, testToolsEnabled: value?.testToolsEnabled ?? testToolsEnabled(),
    sealedWorker: value?.[SEALED_WORKER] === true,
    hostSession: value && Object.hasOwn(value, HOST_SESSION) ? value[HOST_SESSION] : undefined,
    hostClient: value?.[HOST_CLIENT] ?? null }, operation);
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
// sourceApplication is the client the process was started for, so every
// session decision of the call names it whatever the payload says (C3b).
export function agentHostRequestContext(value, hostSessionId, sourceApplication = null) {
  return { ...(value ?? {}), [HOST_SESSION]: hostSessionId ?? null,
    ...(sourceApplication ? { [HOST_CLIENT]: sourceApplication } : {}) };
}

// Runs the rest of an Agent call for the session its task token is bound to.
// Only the session gate calls this, with the session the task registry
// resolved for a current token (session-fuli-gate.js); a payload field or a raw
// token never reaches it. Every session decision of the call then counts that
// session as the call's task session.
export function runWithTaskBoundSession(sessionId, operation) {
  const store = requestContext.getStore();
  if (!store || typeof sessionId !== 'string' || !sessionId) {
    throw new TypeError('A task-bound session needs an Agent request and a resolved session');
  }
  return requestContext.run({ ...store, taskBoundSession: sessionId }, operation);
}

// The session the call's current task token was resolved to, or null.
export function activeTaskBoundSession() {
  return requestContext.getStore()?.taskBoundSession ?? null;
}

// The host session of the Agent call being served: a session ID, null when the
// client named none, undefined outside an Agent's own call (hooks, console).
export function activeAgentHostSession() {
  return requestContext.getStore()?.hostSession;
}

// The client of the Agent call being served, or null outside one or when its
// composition named none.
export function activeAgentHostClient() {
  return requestContext.getStore()?.hostClient ?? null;
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
