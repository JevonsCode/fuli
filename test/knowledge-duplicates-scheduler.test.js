// The periodic duplicate-merge pass asks the Provider for one bounded pass of
// the person's space, never while Agent access is off, and its shutdown waits
// for the pass in flight. Synthetic only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { startDuplicateMerger } from '../src/knowledge-duplicates/scheduler.js';

function app({ enabled = true, fail = false } = {}) {
  const calls = [];
  return { calls, application: {
    config: { personal: { spaceId: 'space-synthetic' } },
    getAgentAccessPolicy: () => ({ enabled }),
    personal: { mergeDuplicates: async (input) => { calls.push(input); if (fail) throw new Error('synthetic'); return { merged: [] }; } }
  } };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function until(check) {
  for (let waited = 0; !check() && waited < 2000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
}

test('each tick runs one pass of the active personal space under the graph lease', async () => {
  const { application, calls } = app();
  const owners = [];
  const stop = startDuplicateMerger({ app: application, intervalMs: 5, withLease: (owner, run) => { owners.push(owner); return run(); } });
  try {
    await until(() => calls.length >= 1);
    assert.deepEqual(calls[0], { personalSpaceId: 'space-synthetic' });
    assert.equal(owners[0], 'knowledge-duplicates');
  } finally { await stop(); }
});

test('no pass runs while Agent access is off, and a failed pass waits for the next tick', async () => {
  const off = app({ enabled: false });
  const stopOff = startDuplicateMerger({ app: off.application, intervalMs: 5 });
  await tick();
  await stopOff();
  assert.equal(off.calls.length, 0);
  const failing = app({ fail: true });
  const stopFailing = startDuplicateMerger({ app: failing.application, intervalMs: 5 });
  await until(() => failing.calls.length >= 2);
  await stopFailing();
  assert.ok(failing.calls.length >= 2, 'a failure does not stop later ticks');
});

test('stopping waits for the pass in flight', async () => {
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const application = { config: { personal: { spaceId: 's' } },
    personal: { mergeDuplicates: () => { entered(); return new Promise(resolve => { finish = resolve; }); } } };
  const stop = startDuplicateMerger({ app: application, intervalMs: 1 });
  await started;
  let stopped = false;
  const closing = stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish({ merged: [] });
  await closing;
  assert.equal(stopped, true);
});
