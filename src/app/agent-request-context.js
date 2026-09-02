import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage();

export function runWithAgentRequestContext(value, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('Agent request context operation is required');
  }
  const signal = abortSignal(value?.signal);
  signal?.throwIfAborted();
  return signal ? requestContext.run({ signal }, operation) : operation();
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
