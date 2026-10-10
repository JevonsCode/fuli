import test from 'node:test';
import assert from 'node:assert/strict';
import { startJudgmentScheduler } from '../src/judgment/scheduler.js';

test('scheduler shutdown waits for its actual in-flight review before resources close', async () => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const app = { config: { personal: { spaceId: 's' } }, judgment: {
    store: () => ({ hasAutomaticPolicy: () => true }),
    reviewAutomatic: async () => { entered(); await pending; return { records: [] }; }
  } };
  const stop = startJudgmentScheduler({ app, intervalMs: 1 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await started;
    let stopped = false;
    const closing = stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    finish(); await closing;
    assert.equal(stopped, true);
  } finally { finish(); await stop(); clearTimeout(keepAlive); }
});
