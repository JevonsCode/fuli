import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GraphitiProviderClient,
  ProviderRequestError
} from '../src/graphiti/provider-client.js';

test('provider client sends bearer-authenticated structured commits', async () => {
  const calls = [];
  const client = new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:8787/',
    accessToken: 'local-test-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { status: 'committed' });
    }
  });

  const payload = { space_id: 'personal-1', episode: { idempotency_key: 'session:1' } };
  assert.deepEqual(await client.commit(payload), { status: 'committed' });
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/v1/knowledge/commits');
  assert.equal(calls[0].options.headers.authorization, 'Bearer local-test-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
});

test('provider client maps controlled provider errors', async () => {
  const client = new GraphitiProviderClient({
    baseUrl: 'https://provider.example',
    accessToken: 'test-token',
    fetchImpl: async () => jsonResponse(403, { detail: 'maintainer role required' })
  });

  await assert.rejects(
    client.listProposals('project-1'),
    (error) => error instanceof ProviderRequestError &&
      error.status === 403 && error.message === 'maintainer role required'
  );
});

test('provider client maps every persistent knowledge review endpoint', async () => {
  const calls = [];
  const client = new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:8787',
    accessToken: 'local-test-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, {});
    }
  });

  await client.startKnowledgeReview({ personal_space_id: 'personal-1', scope: 'all' });
  await client.listKnowledgeReviewCandidates({
    personal_space_id: 'personal-1', review_id: 'review-1', limit: 3
  });
  await client.recordKnowledgeReviewProgress({
    personal_space_id: 'personal-1', review_id: 'review-1',
    candidate_key: 'entity:one', outcome: 'skipped'
  });
  await client.finishKnowledgeReview({
    personal_space_id: 'personal-1', review_id: 'review-1', disposition: 'paused'
  });

  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    '/v1/knowledge/reviews/start',
    '/v1/knowledge/reviews/candidates',
    '/v1/knowledge/reviews/progress',
    '/v1/knowledge/reviews/finish'
  ]);
  assert.equal(calls.every(({ options }) => options.method === 'POST'), true);
});

test('provider client reports network failures without exposing credentials', async () => {
  const client = new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:8787',
    accessToken: 'secret-token',
    fetchImpl: async () => { throw new Error('connection refused'); }
  });

  await assert.rejects(
    client.health(),
    (error) => error.code === 'provider_unavailable' &&
      !error.message.includes('secret-token')
  );
});

test('provider client aborts a request after the configured timeout', async () => {
  let requestSignal;
  const client = new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:8787',
    accessToken: 'secret-token',
    requestTimeoutMs: 20,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true
        });
      });
    }
  });

  await assert.rejects(
    client.health(),
    (error) => error instanceof ProviderRequestError &&
      error.code === 'provider_timeout' &&
      error.status === 504 &&
      error.details === null &&
      !error.message.includes('secret-token')
  );
  assert.equal(requestSignal.aborted, true);
});

test('provider client rejects invalid timeout configuration', () => {
  assert.throws(
    () => new GraphitiProviderClient({
      baseUrl: 'http://127.0.0.1:8787',
      accessToken: 'test-token',
      requestTimeoutMs: 0
    }),
    /timeout/
  );
});

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
