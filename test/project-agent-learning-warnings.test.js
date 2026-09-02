import assert from 'node:assert/strict';
import test from 'node:test';
import { routingLearningRecord } from '../src/graphiti/project-agent-mapping.js';

test('learning mapping preserves temporal validation warnings without inventing legacy warnings', () => {
  const mapped = routingLearningRecord({
    sample_count: 2,
    ignored: true,
    neutral_due_to_insufficient_evidence: true,
    validation_warnings: ['evidence_timestamp_timezone_missing:synthetic-evidence']
  });
  assert.equal(mapped.ignored, true);
  assert.equal(mapped.neutralDueToInsufficientEvidence, true);
  assert.deepEqual(mapped.validationWarnings, ['evidence_timestamp_timezone_missing:synthetic-evidence']);
  assert.equal(Object.hasOwn(routingLearningRecord({ sample_count: 1 }), 'validationWarnings'), false);
});
