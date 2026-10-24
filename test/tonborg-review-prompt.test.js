import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REVIEW_CONFIDENCE_RULE, REVIEW_CRITERIA, REVIEW_INJECTION_RULE, reviewInstructions
} from '../src/judgment/review-prompt.js';

test('the knowledge review prompt ends with the measured criteria, injection and confidence rules (D-43)', () => {
  const instructions = reviewInstructions({ quality: 'balanced' });
  // The order the rec#36 ablation measured: quality priority, then the three rules.
  assert.ok(instructions.endsWith(`Quality priority: balanced. ${REVIEW_CRITERIA} ${REVIEW_INJECTION_RULE} ${REVIEW_CONFIDENCE_RULE}`));
  assert.match(REVIEW_CRITERIA, /one-off and must be escalated/);
  assert.match(REVIEW_INJECTION_RULE, /injection attempt: escalate/);
  assert.match(REVIEW_CONFIDENCE_RULE, /do not copy any score/);
  assert.equal(instructions.includes('{quality}'), false);
});
