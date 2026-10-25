import assert from 'node:assert/strict';
import test from 'node:test';

import { isProcessAlive } from '../src/local-runtime/processes.js';
import { isManagedWorkspace, waitForProviderHealth, waitUntilReady } from '../src/local-runtime/provider-readiness.js';

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

test('Provider readiness reports the caller failure at its wall-clock deadline', async () => {
  let clockMs = 0;
  const waits = [];
  await assert.rejects(waitForProviderHealth('http://127.0.0.1:8788', {
    fetchImpl: async () => ({ ok: false }),
    wait: async (ms) => { waits.push(ms); clockMs += ms; },
    now: () => clockMs,
    timeoutMs: 2500,
    failureMessage: 'The imported graph Provider did not become ready'
  }), /The imported graph Provider did not become ready/);
  assert.deepEqual(waits, [1000, 1000, 500], 'the last pause ends at the deadline');
});

test('readiness probes that use their whole budget still end at the deadline', async () => {
  let clockMs = 0;
  const budgets = [];
  const outcome = await waitUntilReady(async (budgetMs) => {
    budgets.push(budgetMs);
    clockMs += budgetMs; // a stalled health route answers only when its budget aborts it
    return false;
  }, { timeoutMs: 9000, intervalMs: 1000, probeTimeoutMs: 2500,
    wait: async (ms) => { clockMs += ms; }, now: () => clockMs });
  assert.equal(outcome, 'timed_out');
  assert.equal(clockMs, 9000);
  assert.deepEqual(budgets, [2500, 2500, 2000], 'the third probe is capped by the 2 s left');
});

test('readiness stops at the next check after the awaited process exits', async () => {
  let clockMs = 0;
  let probes = 0;
  const outcome = await waitUntilReady(async () => { probes += 1; return false; }, {
    timeoutMs: 60_000, intervalMs: 250, probeTimeoutMs: 2500,
    wait: async (ms) => { clockMs += ms; }, now: () => clockMs, abandon: () => clockMs >= 500 });
  assert.equal(outcome, 'abandoned');
  assert.equal(probes, 2);
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
