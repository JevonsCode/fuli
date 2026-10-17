import assert from 'node:assert/strict';
import test from 'node:test';

import { isProcessAlive } from '../src/local-runtime/processes.js';
import { isManagedWorkspace, waitForProviderHealth } from '../src/local-runtime/provider-readiness.js';

test('Provider readiness retries until health answers', async () => {
  const requested = [];
  const waits = [];
  let calls = 0;
  await waitForProviderHealth('http://127.0.0.1:8788/', {
    fetchImpl: async (url) => {
      requested.push(url);
      calls += 1;
      if (calls === 1) throw new Error('connection refused');
      return { ok: calls === 3 };
    },
    wait: async (ms) => { waits.push(ms); },
    failureMessage: 'not ready'
  });
  assert.deepEqual(requested, Array(3).fill('http://127.0.0.1:8788/health'));
  assert.deepEqual(waits, [1000, 1000]);
});

test('Provider readiness reports the caller failure after the last attempt without a trailing wait', async () => {
  const waits = [];
  await assert.rejects(waitForProviderHealth('http://127.0.0.1:8788', {
    fetchImpl: async () => ({ ok: false }),
    wait: async (ms) => { waits.push(ms); },
    attempts: 2,
    failureMessage: 'The imported graph Provider did not become ready'
  }), /The imported graph Provider did not become ready/);
  assert.equal(waits.length, 1);
});

test('managed workspaces are flagged or use the local development Provider port', () => {
  assert.equal(isManagedWorkspace({ managedDevelopment: true }), true);
  assert.equal(isManagedWorkspace({ providerUrl: 'http://localhost:8788' }), true);
  assert.equal(isManagedWorkspace({ providerUrl: 'http://[::1]:8788' }), true);
  assert.equal(isManagedWorkspace({ providerUrl: 'https://localhost:8788' }), false);
  assert.equal(isManagedWorkspace({ providerUrl: 'http://example.com:8788' }), false);
  assert.equal(isManagedWorkspace({ providerUrl: 'not a url' }), false);
});

test('process liveness rejects non-integer PIDs and sees the current process', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(undefined), false);
  assert.equal(isProcessAlive('1'), false);
});
