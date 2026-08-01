import assert from 'node:assert/strict';
import test from 'node:test';

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

test('persistent knowledge review stays personal and preserves every outcome', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/knowledge/reviews/start': { review_id: 'review-1' },
      '/v1/knowledge/reviews/candidates': { candidates: [] },
      '/v1/knowledge/reviews/progress': { decision_id: 'decision-1' },
      '/v1/knowledge/reviews/finish': { review_id: 'review-1', status: 'paused' }
    })
  });

  await app.startKnowledgeReview({
    personalSpaceId: 'personal-space',
    scope: 'project',
    personalProjectId: 'fuli'
  });
  await app.listKnowledgeReviewCandidates({
    personalSpaceId: 'personal-space',
    reviewId: 'review-1',
    limit: 3
  });
  await app.recordKnowledgeReviewProgress({
    personalSpaceId: 'personal-space',
    reviewId: 'review-1',
    candidateKey: 'entity:item-1',
    outcome: 'deferred',
    note: 'User chose to revisit this next time.'
  });
  await app.finishKnowledgeReview({
    personalSpaceId: 'personal-space',
    reviewId: 'review-1',
    disposition: 'paused'
  });

  assert.deepEqual(calls.map(({ path }) => path), [
    '/v1/knowledge/reviews/start',
    '/v1/knowledge/reviews/candidates',
    '/v1/knowledge/reviews/progress',
    '/v1/knowledge/reviews/finish'
  ]);
  assert.deepEqual(calls[0].body, {
    personal_space_id: 'personal-space',
    scope: 'project',
    personal_project_id: 'fuli'
  });
  assert.equal(calls[2].body.candidate_key, 'entity:item-1');
  assert.equal(calls[2].body.outcome, 'deferred');
  assert.equal(calls[3].body.disposition, 'paused');
});

function providerFetch(calls, routes) {
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({
      origin: url.origin,
      path: url.pathname,
      method: options.method ?? 'GET',
      body: options.body ? JSON.parse(options.body) : null
    });
    return new Response(JSON.stringify(routes[url.pathname] ?? []), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}
