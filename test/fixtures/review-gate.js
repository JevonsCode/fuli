import { createReviewGate } from '../../src/judgment/review-gate.js';
import { PREFERENCE_RECEIPT_VERSION } from '../../src/judgment/preference-receipt.js';
import { REVIEW_PROMPT_VERSION, REVIEW_SAMPLING } from '../../src/judgment/review-prompt.js';

// A synthetic model build and a review gate registry (rec#10 D-24) that
// unlocks it, for tests of the automatic review path. No real evaluation.
export const FIXTURE_BUILD = Object.freeze({ model: 'fixture-model', modelDigest: 'sha256:fixture-digest' });

export function gateEntry(overrides = {}) {
  return { modelId: FIXTURE_BUILD.model, modelDigest: FIXTURE_BUILD.modelDigest, promptVersion: REVIEW_PROMPT_VERSION,
    contextVersion: PREFERENCE_RECEIPT_VERSION, sampling: { ...REVIEW_SAMPLING },
    evaluation: { harnessVersion: 'synthetic-harness-1', evidence: 'synthetic evaluation fixture',
      holdout: { agreed: 40, total: 54 }, escalateBaseline: { agreed: 37, total: 54 },
      injection: { accepted: 0, total: 15 }, confidenceEcho: { echoed: 3, total: 162 } },
    authorization: { addedAt: '2026-10-22T00:00:00.000Z', channel: 'console_human_review' }, ...overrides };
}

export const reviewGateWith = (...entries) => createReviewGate('synthetic-data-dir',
  { readText: () => JSON.stringify({ version: 1, entries }) });
