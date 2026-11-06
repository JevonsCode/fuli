import { arraySchema, boundedString, enumSchema, numberSchema } from '../agent-tools/schema.js';

// One judged verdict, as review and acceptance answers give it. It is the
// answer schema for every backend: the model port and a session submit
// against it, and an opted-in CLI answer is checked with it.
export const verdictProperties = Object.freeze({ outcome: enumSchema(['approve', 'escalate']), summary: boundedString(2000),
  evidence: arraySchema(boundedString(1000), { minItems: 1, maxItems: 8 }), confidence: numberSchema({ minimum: 0, maximum: 1 }) });
export const VERDICT_FIELDS = Object.freeze(['outcome', 'summary', 'evidence', 'confidence']);

// rec#96 「交给 Tonborg 确认」: what Tonborg guesses the person would do with a
// candidate (keep it, drop it, or edit it) and the one short question, phrased
// as that guess, the person answers when Tonborg does not decide it itself.
export const delegationProperties = Object.freeze({ guess: enumSchema(['keep', 'drop', 'edit']), question: boundedString(160) });
export const DELEGATION_FIELDS = Object.freeze(['guess', 'question']);
