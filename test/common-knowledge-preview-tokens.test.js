import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCommonKnowledgePreviewTokens
} from '../src/mcp/common-knowledge-preview-tokens.js';

const INTENT = {
  personalSpaceId: 'personal-1',
  parentProjectId: 'platform-a',
  itemKind: 'entity',
  canonicalItemId: 'canonical',
  duplicateItemIds: ['duplicate-b', 'duplicate-c'],
  reason: 'Shared runbook.',
  humanConfirmationReason: 'The user approved this exact promotion.'
};

test('common knowledge preview token binds the exact intent and is one-time', () => {
  const previews = createCommonKnowledgePreviewTokens({
    now: () => 100,
    createToken: () => 'preview-1'
  });
  const token = previews.issue(INTENT);

  previews.consume(token, {
    ...INTENT,
    duplicateItemIds: [...INTENT.duplicateItemIds].reverse()
  });
  assert.throws(
    () => previews.consume(token, INTENT),
    (error) => error.code === 'preview_expired'
  );
});

test('common knowledge preview token rejects changed rationale', () => {
  const previews = createCommonKnowledgePreviewTokens({
    now: () => 100,
    createToken: () => 'preview-2'
  });
  const token = previews.issue(INTENT);

  assert.throws(
    () => previews.consume(token, { ...INTENT, reason: 'Different scope.' }),
    (error) => error.code === 'preview_mismatch'
  );
});
