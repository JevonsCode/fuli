import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

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

export function trackedApplication() {
  let calls = 0;
  const app = { graphiti: true, close: () => { calls += 1; } };
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
