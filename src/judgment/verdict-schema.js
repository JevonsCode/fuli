import { arraySchema, boundedString, enumSchema, numberSchema } from '../agent-tools/schema.js';

// One judged verdict, as review and acceptance answers give it. It is the
// answer schema for every backend: the model port and a session submit
// against it, and an opted-in CLI answer is checked with it.
export const verdictProperties = Object.freeze({ outcome: enumSchema(['approve', 'escalate']), summary: boundedString(2000),
  evidence: arraySchema(boundedString(1000), { minItems: 1, maxItems: 8 }), confidence: numberSchema({ minimum: 0, maximum: 1 }) });
export const VERDICT_FIELDS = Object.freeze(['outcome', 'summary', 'evidence', 'confidence']);
