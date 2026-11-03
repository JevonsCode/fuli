import assert from 'node:assert/strict';
import test from 'node:test';

import { measure } from '../acceptance/recall-usage-prior/run.js';

// rec#63 step 2 gate: on the synthetic recall world the usage prior lifts
// Recall@3 and lowers irrelevant@3 against the neutral (empty-history) order,
// keeps never-shown answers reachable and pushes out few answers that were
// already delivered. Agents that never report use leave the order exactly as
// it was. Synthetic data only.
test('the usage prior improves the synthetic recall world on every seed without burying many answers', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { before, after, lost_answers: lost } = await measure({ seed, rounds: 8 });
    assert.ok(after.all.recall_at_3 >= before.all.recall_at_3 + 0.05, `seed ${seed} recall ${before.all.recall_at_3} -> ${after.all.recall_at_3}`);
    assert.ok(after.all.irrelevant_at_3 < before.all.irrelevant_at_3, `seed ${seed} irrelevant ${before.all.irrelevant_at_3} -> ${after.all.irrelevant_at_3}`);
    assert.ok(after.all.stale_in_top_3 <= before.all.stale_in_top_3, `seed ${seed} stale`);
    assert.ok(after.byKind.cold_start.recall_at_3 >= before.byKind.cold_start.recall_at_3, `seed ${seed} cold start`);
    assert.ok(lost <= 3, `seed ${seed} lost ${lost} delivered answers`);
  }
});

test('when no Agent reports knowledge use, the history changes no order', async () => {
  for (const seed of [1, 2, 3]) {
    const { before, after, lost_answers: lost } = await measure({ seed, rounds: 8, reporting: 0 });
    assert.deepEqual(after, before);
    assert.equal(lost, 0);
  }
});
