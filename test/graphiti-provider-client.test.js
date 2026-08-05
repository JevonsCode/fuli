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

test('provider client classifies HTTP 5xx with a bounded diagnostic', async () => {
  const client = new GraphitiProviderClient({
    baseUrl: 'https://provider.example',
    accessToken: 'test-token',
    fetchImpl: async () => jsonResponse(500, {
      detail: 'Traceback at /Users/private/app.py:42; Bearer secret-token'
    })
  });

  await assert.rejects(
    client.listProposals('project-1'),
    (error) => error instanceof ProviderRequestError &&
      error.status === 500 &&
      error.code === 'provider_http_5xx' &&
      error.message === 'Graphiti provider returned HTTP 500.' &&
      error.diagnostic?.category === 'provider_http_5xx' &&
      !JSON.stringify(error.diagnostic).includes('Traceback') &&
      !JSON.stringify(error.diagnostic).includes('secret-token') &&
      !JSON.stringify(error.diagnostic).includes('/Users/')
  );
});

test('provider client turns structured validation failures into actionable messages', async () => {
  const detail = [{
    type: 'value_error',
    loc: ['body', 'episode', 'entities', 0],
    msg: 'Value error, non-known-known knowledge requires a reasoning summary',
    input: { summary: 'must not be copied into the error message' }
  }];
  const client = new GraphitiProviderClient({
    baseUrl: 'https://provider.example',
    accessToken: 'test-token',
    fetchImpl: async () => jsonResponse(422, { detail })
  });

  await assert.rejects(
    client.commit({}),
    (error) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.status, 422);
      assert.equal(
        error.message,
        'Graphiti provider rejected the request — episode.entities[0] — ' +
          'Value error, non-known-known knowledge requires a reasoning summary'
      );
      assert.deepEqual(error.validationErrors, [{
        field: 'episode.entities[0]',
        message: 'Value error, non-known-known knowledge requires a reasoning summary'
      }]);
      assert.ok(!JSON.stringify(error.details).includes('must not be copied'));
      return true;
    }
  );
});

test('provider client bounds validation details and removes colon delimiters', async () => {
  const detail = Array.from({ length: 7 }, (_, index) => ({
    type: 'value_error',
    loc: ['body', 'episode', 'entities', index],
    msg: `Value error, field ${index}: reason`,
    input: { secret: `payload-${index}` }
  }));
  const client = new GraphitiProviderClient({
    baseUrl: 'https://provider.example',
    accessToken: 'test-token',
    fetchImpl: async () => jsonResponse(422, { detail })
  });

  await assert.rejects(
    client.commit({}),
    (error) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.validationErrors.length, 5);
      assert.equal(error.details.validationErrors.length, 5);
      assert.ok(!error.message.includes(':'));
      assert.ok(!JSON.stringify(error).includes('payload-'));
      return true;
    }
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
    candidate_key: 'entity:one', outcome: 'delegated_to_ai'
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

test('provider client maps workflow reads without exposing the human review channel', async () => {
  const calls = [];
  const client = new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:8787',
    accessToken: 'local-test-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, {});
    }
  });
  const scope = {
    personal_space_id: 'personal-1',
    personal_project_id: 'project-1'
  };

  await client.searchWorkflowCandidates(scope);
  await client.recommendWorkflowCandidates({
    ...scope,
    after_step_key: 'step-x'
  });
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    '/v1/workflow-candidates/search',
    '/v1/workflow-candidates/recommendations'
  ]);
  assert.equal(calls.every(({ options }) => options.method === 'POST'), true);
  assert.equal(client.reviewWorkflowCandidate, undefined);
});

test('workflow observations require and send the MCP-host-only capability', async () => {
  const calls = [];
  const client = new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:8787',
    accessToken: 'local-test-token',
    workflowObservationToken: 'mcp-host-workflow-observation-token-123456',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { status: 'committed' });
    }
  });
  const actorOnlyClient = new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:8787',
    accessToken: 'actor-only-token',
    fetchImpl: async () => {
      throw new Error('request must not be sent without the host capability');
    }
  });

  assert.throws(
    () => actorOnlyClient.recordWorkflowObservation({}),
    /MCP host workflow observation credential/
  );
  await client.recordWorkflowObservation({ observation_id: 'observation-1' });

  assert.equal(new URL(calls[0].url).pathname, '/v1/workflow-observations');
  assert.equal(
    calls[0].options.headers['x-fuli-workflow-observation-token'],
    'mcp-host-workflow-observation-token-123456'
  );
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
