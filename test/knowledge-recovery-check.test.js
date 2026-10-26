import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError } from '../src/app/application-error.js';
import { createKnowledgeRecoveryCheck } from '../src/knowledge-hard-delete/recovery-check.js';
import { createServer } from '../src/server.js';

// The console re-checks deletion recovery by itself when a request finds it
// pending, so the person is never sent to `fuli migrate reconcile-knowledge`.

function gate(states) {
  const refreshed = [];
  return { refreshed, refresh: async (spaceId, options) => { refreshed.push([spaceId, options]); return states.shift(); } };
}

test('a check reconciles, then verifies the watermark with a forced refresh', async () => {
  const events = [];
  const recovery = gate([{ state: 'open', reason: null }]);
  const check = createKnowledgeRecoveryCheck({ reconcile: async () => { events.push('reconciled'); },
    gate: recovery, spaceId: () => 'synthetic-space' });
  assert.deepEqual(await check.check(), { status: 'ready' });
  assert.deepEqual(events, ['reconciled']);
  assert.deepEqual(recovery.refreshed, [['synthetic-space', { force: true }]]);
});

test('one run at a time, at most one start per interval, and a failure stays pending', async () => {
  let clock = 0;
  let release;
  let runs = 0;
  const check = createKnowledgeRecoveryCheck({ gate: gate([{ state: 'closed', reason: 'watermark_mismatch' }]),
    reconcile: () => { runs += 1; if (runs === 1) return new Promise((resolve) => { release = resolve; });
      throw new Error('synthetic provider detail'); },
    spaceId: () => 'synthetic-space', now: () => clock, intervalMs: 1000 });
  const first = check.check();
  assert.equal(check.check(), first, 'a running check is shared');
  release();
  assert.deepEqual(await first, { status: 'pending', reason: 'watermark_mismatch' });
  clock = 999;
  assert.equal(check.check(), null, 'not again within the interval');
  clock = 1000;
  const failed = await check.check();
  assert.deepEqual(failed, { status: 'pending', reason: 'reconciliation_unavailable' });
  assert.doesNotMatch(JSON.stringify(failed), /synthetic provider detail/);
  assert.equal(runs, 2);
});

test('no personal space, no check', () => {
  const check = createKnowledgeRecoveryCheck({ reconcile: () => assert.fail('nothing to reconcile'),
    gate: gate([]), spaceId: () => null });
  assert.equal(check.check(), null);
});

test('a console request refused for pending recovery starts the re-check under a graph lease', async () => {
  const events = [];
  const recovery = gate([{ state: 'open', reason: null }]);
  const runtime = await createServer({ port: 0, dataFormatNotices: () => [], dataFormatMigrations: null,
    knowledgeHardDelete: { reconcile: async () => { events.push('reconciled'); return []; } },
    system: { withGraphRuntimeLease: async (owner, run) => { events.push(`lease:${owner}`); return run(); } },
    app: { config: { personal: { spaceId: 'synthetic-space' } }, knowledgeRecoveryGate: recovery, close() {},
      async state() { throw new ApplicationError('knowledge_recovery_pending', 'synthetic wait', { status: 503 }); } } });
  try {
    events.length = 0; // The startup reconciliation is not this request's.
    const response = await fetch(`${runtime.url}/api/state`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'knowledge_recovery_pending');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(events.includes('lease:knowledge-recovery'), events.join());
    assert.ok(events.includes('reconciled'), events.join());
    assert.deepEqual(recovery.refreshed.at(-1), ['synthetic-space', { force: true }]);
  } finally {
    await new Promise((done) => runtime.server.close(done));
  }
});
