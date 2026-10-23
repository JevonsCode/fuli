// Keeps acceptance/context-delivery-replay (rec#15 PR3) runnable: one scenario
// through the real hook entries, synthetic transcripts and Provider only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { measure } from '../acceptance/context-delivery-replay/run.js';
import { markdownTable } from '../acceptance/context-delivery-replay/report.js';

test('the context delivery replay measures the acceptance scenario in bytes and keeps the model view whole', async () => {
  const result = await measure(['acceptance']);
  assert.match(result.unit, /UTF-8 bytes.*No token estimates/);
  const [acceptance] = result.scenarios;
  assert.deepEqual(acceptance.checks.filter(check => !check.pass), []);
  assert.equal(acceptance.correctness.correct_turns, acceptance.correctness.delivered_turns);
  assert.deepEqual(acceptance.correctness.withdrawn_present, []);
  assert.equal(acceptance.turns, 8);
  assert.equal(acceptance.buckets.first_or_reset_full.turns, 2, 'C and H each start once');
  assert.ok(acceptance.buckets.incremental.turns >= 5);
  assert.ok(acceptance.injected_bytes < acceptance.no_cache_bytes);
  assert.equal(acceptance.pointer_bytes.length, 1);
  assert.ok(acceptance.pointer_bytes[0] <= 320);
  assert.ok(acceptance.retrieval_calls.total > 0);
  assert.match(markdownTable(result.scenarios), /\| acceptance \| 8 \|/);
});
