import { PREFERENCE_RECEIPT_VERSION } from './preference-receipt.js';
import { REVIEW_PROMPT_VERSION, REVIEW_SAMPLING } from './review-prompt.js';

// The model build a Tonborg knowledge review is keyed by in the D-24 gate
// (review-gate.js): the model and its served digest, the prompt and context
// versions, and the sampling. A model receipt names a digest only when its
// backend reports one; without it no gate entry matches. A current-session
// answer names no model. Kept apart from review-gate.js, which the data-format
// inventory imports and which must not load the prompt modules.
export function reviewGateKey({ modelId = null, modelDigest = null }) {
  return { modelId, modelDigest, promptVersion: REVIEW_PROMPT_VERSION, contextVersion: PREFERENCE_RECEIPT_VERSION,
    sampling: REVIEW_SAMPLING };
}
