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

test('the user-words and standing-rule criteria cover only preference candidates; an ordinary fact needs supporting evidence', () => {
  // A candidate is a preference when it carries preference_scope or profile_aspect (KnowledgeReviewCandidate).
  assert.match(REVIEW_CRITERIA, /^For a candidate with a preference_scope or profile_aspect \(a user preference or standing rule\), approve only when/);
  // One-off requests stay escalated within the preference criteria.
  assert.match(REVIEW_CRITERIA, /one-off and must be escalated/);
  assert.match(REVIEW_CRITERIA, /For any other candidate \(an ordinary entity or relationship fact\), approve when the supplied evidence directly supports it/);
  // The injection and confidence rules stay unconditional.
  assert.doesNotMatch(REVIEW_INJECTION_RULE, /preference/);
  assert.doesNotMatch(REVIEW_CONFIDENCE_RULE, /preference/);
});
