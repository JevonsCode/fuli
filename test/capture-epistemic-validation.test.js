import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError } from '../src/app/application-error.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

const CONFIG = {
  version: 1,
  personal: {
    providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'personal-token',
    principalId: 'person-local',
    spaceId: 'personal-space'
  },
  workspaces: []
};

test('capture rejects a non-known-known entity without reasoning before Provider I/O', async () => {
  let providerCalls = 0;
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ status: 'committed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await assert.rejects(
    app.captureSessionKnowledge(captureInput()),
    (error) => error instanceof ApplicationError &&
      error.code === 'validation' &&
      error.message === 'entities[0].reasoningSummary is required when ' +
        'originQuadrant is known_unknown'
  );
  assert.equal(providerCalls, 0);
});

test('capture rejects a non-known-known relationship without reasoning before Provider I/O', async () => {
  let providerCalls = 0;
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ status: 'committed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const input = captureInput();
  input.entities[0].originQuadrant = 'known_known';
  input.relationships = [{
    key: 'synthetic:step-x-recommends-step-y',
    source: 'synthetic:known-unknown',
    target: 'synthetic:known-unknown',
    type: 'RECOMMENDS_NEXT',
    fact: 'Synthetic step X is often followed by synthetic step Y.',
    originQuadrant: 'unknown_known',
    confirmationStatus: 'pending',
    confirmationBasis: {
      existenceReason: 'The synthetic interaction pattern repeated.',
      quadrantReason: 'The pattern was inferred from behavior.',
      proposedBy: { kind: 'agent', label: 'Acceptance Agent' }
    },
    attributes: { fixture: 'synthetic' }
  }];

  await assert.rejects(
    app.captureSessionKnowledge(input),
    (error) => error instanceof ApplicationError &&
      error.code === 'validation' &&
      error.message === 'relationships[0].reasoningSummary is required when ' +
        'originQuadrant is unknown_known'
  );
  assert.equal(providerCalls, 0);
});

function captureInput() {
  return {
    targetKind: 'personal',
    spaceId: 'personal-space',
    personalProjectId: 'fuli',
    idempotencyKey: 'synthetic-capture-validation-v1',
    sessionId: 'synthetic-capture-validation',
    name: 'Synthetic capture validation',
    sourceKind: 'synthetic_acceptance_fixture',
    sourceDescription: 'Synthetic acceptance data, not a production fact.',
    referenceTime: '2026-08-03T00:00:00.000Z',
    sensitivity: 'private',
    entities: [{
      key: 'synthetic:known-unknown',
      name: 'Synthetic unresolved tradeoff',
      type: 'ProductExploration',
      summary: 'Synthetic acceptance data.',
      originQuadrant: 'known_unknown',
      confirmationStatus: 'pending',
      confirmationBasis: {
        existenceReason: 'The synthetic fixture explicitly raises the tradeoff.',
        quadrantReason: 'The tradeoff is recognized but unresolved.',
        proposedBy: { kind: 'agent', label: 'Acceptance Agent' }
      },
      attributes: { fixture: 'synthetic' }
    }],
    relationships: []
  };
}
