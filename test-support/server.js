import assert from 'node:assert/strict';

import { createApplication } from '../src/app/create-application.js';
import { createServer } from '../src/server.js';
import { STORE_METHODS } from '../src/storage/store-port.js';
import { FileStore } from '../src/store.js';

export async function postJson(url, body) {
  const response = await requestJson(url, { method: 'POST', body });
  if (response.status !== 200) assert.fail(JSON.stringify(response.body));
  return response.body;
}

export async function getJson(url) {
  const response = await requestJson(url);
  if (response.status !== 200) assert.fail(JSON.stringify(response.body));
  return response.body;
}

export async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

export function hideAdapterInternals(store) {
  return Object.fromEntries(
    STORE_METHODS.map((method) => [method, (...args) => store[method](...args)])
  );
}

export function overrideStore(store, overrides) {
  return Object.fromEntries(
    STORE_METHODS.map((method) => [
      method,
      overrides[method] ?? ((...args) => store[method](...args))
    ])
  );
}

export function trackedApplication() {
  const app = createApplication({ store: new FileStore(':memory:') });
  const close = app.close;
  let calls = 0;
  app.close = () => {
    calls += 1;
    return close();
  };
  return { app, closeCalls: () => calls };
}

export async function expectPortExhaustion(options) {
  let result;
  try {
    result = await createServer(options);
  } finally {
    if (result) await closeServer(result.server);
  }
  throw new Error('Server listened despite blocked-port policy');
}

export function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
