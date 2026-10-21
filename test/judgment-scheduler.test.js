import test from 'node:test';
import assert from 'node:assert/strict';
import { startJudgmentScheduler } from '../src/judgment/scheduler.js';
import { newerFormatError } from '../packages/roundtable/src/storage/data-format-error.js';

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

test('a judgment store this version cannot use backs the scheduler off instead of failing it (rec#17)', async () => {
  let opened = 0;
  const app = { config: { personal: { spaceId: 's' } }, judgment: {
    store: () => { opened += 1; throw newerFormatError('judgment', 9, 1); },
    reviewAutomatic: async () => assert.fail('no review without a usable store')
  } };
  const stop = startJudgmentScheduler({ app, intervalMs: 1 });
  try {
    while (opened === 0) await new Promise(resolve => setTimeout(resolve, 2));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(opened, 1, 'the failed open backs off like a failed review');
  } finally { await stop(); }
});
