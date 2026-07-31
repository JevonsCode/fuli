import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

test('negative evidence maps to the Provider without changing human authority in the Agent layer', async () => {
  const app = new FederatedGraphApplication({
    personal: {
      providerUrl: 'http://personal.invalid',
      accessToken: 'test-access',
      principalId: 'principal-1',
      spaceId: 'personal-1'
    },
    workspaces: []
  });
  let providerInput;
  app.personal.recordKnowledgeFeedback = async (input) => {
    providerInput = input;
    return { recorded_count: 1, duplicate_count: 0, items: [] };
  };

  await app.recordKnowledgeFeedback({
    personalSpaceId: 'personal-1',
    taskId: 'task-1',
    sessionId: 'session-1',
    toolName: 'record_knowledge_feedback',
    items: [{
      itemId: 'entity-1',
      itemKind: 'entity',
      feedbackKind: 'validation_failed',
      reason: 'The documented command failed.',
      evidenceSummary: 'Synthetic fixture: exit code 1.',
      reportedByKind: 'agent',
      sourceUri: 'https://example.invalid/test-result'
    }]
  });

  assert.deepEqual(providerInput, {
    personal_space_id: 'personal-1',
    task_id: 'task-1',
    session_id: 'session-1',
    tool_name: 'record_knowledge_feedback',
    items: [{
      item_id: 'entity-1',
      item_kind: 'entity',
      feedback_kind: 'validation_failed',
      reason: 'The documented command failed.',
      evidence_summary: 'Synthetic fixture: exit code 1.',
      reported_by_kind: 'agent',
      source_uri: 'https://example.invalid/test-result'
    }]
  });
});
