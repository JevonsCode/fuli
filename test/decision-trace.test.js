import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

test('decision trace stores the selected option, alternatives, rationale, and validation', async () => {
  const app = new FederatedGraphApplication({
    personal: {
      providerUrl: 'http://personal.invalid',
      accessToken: 'test-access',
      principalId: 'principal-1',
      spaceId: 'personal-1'
    },
    workspaces: []
  });
  let captured;
  app.captureSessionKnowledge = async (input) => {
    captured = input;
    return { status: 'committed', route: 'personal' };
  };

  const result = await app.recordDecisionTrace({
    personalSpaceId: 'personal-1',
    personalProjectId: 'project-a',
    sessionId: 'session-1',
    idempotencyKey: 'decision-test-0001',
    decisionKey: 'agent-enforcement',
    title: 'Agent enforcement mechanism',
    question: 'How should task knowledge review be enforced?',
    selectedOption: {
      key: 'lifecycle-hook',
      label: 'Lifecycle hook',
      summary: 'Begin and stop hooks enforce one review checkpoint.'
    },
    rejectedOptions: [{
      key: 'prompt-only',
      label: 'Prompt only',
      summary: 'The model may skip the instruction.'
    }],
    reason: 'Lifecycle hooks reduce dependence on voluntary tool selection.',
    validationResults: [{
      key: 'claude-hook-docs',
      outcome: 'pass',
      summary: 'The host supports prompt-entry and stop hooks.'
    }],
    decidedBy: { kind: 'user', label: 'current user' },
    referenceTime: '2026-07-31T09:00:00.000Z',
    sourceKind: 'user_decision',
    sourceDescription: 'Explicit decision confirmed in the current task.',
    sourceApplication: 'codex',
    sourceTurnId: 'turn-1'
  });

  assert.equal(result.status, 'committed');
  assert.equal(captured.targetKind, 'personal');
  assert.deepEqual(
    captured.entities.map(({ type }) => type),
    ['Decision', 'DecisionOption', 'DecisionOption', 'DecisionRationale', 'ValidationResult']
  );
  assert.deepEqual(
    captured.relationships.map(({ type }) => type),
    ['SELECTED_OPTION', 'REJECTED_OPTION', 'MOTIVATED_BY', 'VALIDATED_BY']
  );
  assert.match(
    captured.entities.find(({ type }) => type === 'DecisionRationale').summary,
    /voluntary tool selection/
  );
  assert.equal(
    captured.entities.every(({ confirmationStatus }) =>
      confirmationStatus === 'confirmed'
    ),
    true
  );
});
