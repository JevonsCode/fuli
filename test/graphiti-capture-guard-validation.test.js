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
  workspaces: [{
    providerUrl: 'https://workspace.example',
    accessToken: 'workspace-token',
    principalId: 'person-remote'
  }]
};

test('capture guards expose controlled validation errors', async () => {
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch()
  });

  await assert.rejects(
    app.captureSessionKnowledge({
      ...episodeInput('project'),
      spaceId: 'project-1',
      sensitivity: 'restricted'
    }),
    (error) => error instanceof ApplicationError &&
      error.code === 'validation' &&
      /cannot enter a team-shared project queue/.test(error.message)
  );

  await assert.rejects(
    app.captureSessionKnowledge({
      ...episodeInput('personal'),
      spaceId: 'other-personal-space'
    }),
    (error) => error instanceof ApplicationError &&
      error.code === 'validation' &&
      /active personal space/.test(error.message)
  );
});

function episodeInput(targetKind) {
  return {
    targetKind,
    spaceId: 'personal-space',
    providerUrl: targetKind === 'project' ? 'https://workspace.example' : null,
    idempotencyKey: 'session-1-batch-1',
    sessionId: 'session-1',
    name: 'Session knowledge',
    sourceKind: 'conversation',
    sourceDescription: 'Agent structured session evidence',
    referenceTime: '2026-07-21T10:00:00.000Z',
    sensitivity: 'normal',
    entities: [{
      key: 'preference:language',
      name: '中文',
      type: 'Preference',
      originQuadrant: 'known_known',
      confirmationStatus: 'confirmed',
      confirmationBasis: {
        existenceReason: 'The user explicitly stated the language preference.',
        quadrantReason: 'The preference was explicitly expressed.',
        proposedBy: { kind: 'agent', label: 'Codex' },
        confirmedBy: { kind: 'user', label: 'Current user' },
        confirmedAt: '2026-07-21T10:00:00.000Z'
      }
    }],
    relationships: []
  };
}

function providerFetch() {
  return async () => new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
