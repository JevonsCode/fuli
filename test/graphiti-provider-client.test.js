import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GraphitiProviderClient,
  ProviderRequestError
} from '../src/graphiti/provider-client.js';

test('hard-deletion watermark uses ordinary auth and sends only the personal space', async () => {
  const calls = [];
  const watermark = { count: 2, latest_deleted_at: '2026-10-23T00:00:00Z' };
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse(200, watermark); } });
  const result = await client.readHardDeletionWatermark({ personalSpaceId: 'synthetic-space', itemId: 'not-forwarded' });
  assert.deepEqual(result, watermark);
  assert.equal(calls[0].url, 'http://provider.test/v1/knowledge/hard-deletions/watermark');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { personal_space_id: 'synthetic-space' });
  assert.equal(calls[0].options.headers.authorization, 'Bearer synthetic-token');
  assert.equal(calls[0].options.headers['x-fuli-human-review-token'], undefined);
});

test('worker lookup and admission transmit capability only in a dedicated header', async () => {
  const calls = [];
  const capability = 'synthetic-worker-capability-never-in-payload';
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse(200, {}); } });
  const scope = { personal_space_id: 'worker-space', personal_project_id: 'worker-project' };
  const signal = new AbortController().signal;
  await client.getProjectAgentWorkerRun('worker/run', scope, { capability, signal });
  await client.admitProjectAgentWorkerContext('worker/run', { ...scope,
    source_application: 'codex', session_id: 'sealed-session' }, { capability, signal });
  assert.match(calls[0].url, /worker%2Frun\?personal_space_id=worker-space/);
  assert.match(calls[1].url, /worker%2Frun\/contexts$/);
  assert.equal(calls[1].options.method, 'POST');
  for (const { url, options } of calls) {
    assert.equal(options.headers['x-fuli-worker-capability'], capability);
    assert.equal((url + (options.body ?? '')).includes(capability), false);
  }
});

test('worker admission errors never expose a capability through Provider detail or cancellation reason', async () => {
  const capability = 'synthetic-capability-must-be-redacted-123';
  const scope = { personal_space_id: 'worker-space', personal_project_id: 'worker-project' };
  for (const kind of ['rejected', 'cancelled', 'timeout']) {
    const controller = new AbortController();
    const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
      requestTimeoutMs: 10, fetchImpl: async (_url, { signal }) => {
        if (kind === 'rejected') return jsonResponse(403, { detail: capability });
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          if (kind === 'cancelled') controller.abort(new Error(capability));
        });
      } });
    await assert.rejects(client.admitProjectAgentWorkerContext('run', scope, { capability, signal: controller.signal }), error => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal((error.stack + JSON.stringify(error)).includes(capability), false);
      assert.equal(error.code, kind === 'timeout' ? 'provider_timeout' : kind === 'cancelled' ? 'request_cancelled' : 'provider_error');
      return true;
    });
  }
});

test('host WorkerRun lifecycle uses exact HTTP ports and never places capabilities in request bodies', async () => {
  const calls = [];
  const capability = 'synthetic-worker-capability-never-in-payload';
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse(200, {}); } });
  const scope = { personal_space_id: 'worker-space', personal_project_id: 'worker-project' };
  const session = { ...scope, source_application: 'codex', session_id: 'sealed-session' };
  await client.prepareProjectAgentWorkerRun({ ...scope, runtime_capability_hash: 'a'.repeat(64) });
  await client.claimProjectAgentWorkerStart('worker/run', scope, { capability });
  await client.sealProjectAgentWorkerSession('worker/run', session, { capability });
  await client.closeProjectAgentWorkerRun('worker/run', { ...scope, reason: 'completed' }, { capability, signal: null });
  await client.revokeProjectAgentWorkerRun('worker/run', { ...scope, reason: 'cancelled' }, { signal: null });
  assert.deepEqual(calls.map(({ url, options }) => [options.method, new URL(url).pathname]), [
    ['PUT', '/v1/project-agent-worker-runs'], ['POST', '/v1/project-agent-worker-runs/worker%2Frun/start-claim'],
    ['PUT', '/v1/project-agent-worker-runs/worker%2Frun/session'], ['POST', '/v1/project-agent-worker-runs/worker%2Frun/close'],
    ['POST', '/v1/project-agent-worker-runs/worker%2Frun/revoke']
  ]);
  for (let index = 0; index < calls.length; index++) {
    const { options } = calls[index];
    assert.equal(options.headers['x-fuli-worker-capability'], [1, 2, 3].includes(index) ? capability : undefined);
    assert.equal(options.body.includes(capability), false);
  }
});

test('preference reads transmit explicit task dimensions independently without storing the task prompt', async () => {
  let url;
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async value => { url = new URL(value); return jsonResponse(200, {}); } });
  await client.collaborationPreferences('synthetic-space', 'synthetic-project', 100, null,
    { sessionId: 'synthetic-session', workKind: 'implementation', workflow: 'timesheet' });
  assert.equal(url.searchParams.get('session_id'), 'synthetic-session');
  assert.equal(url.searchParams.get('work_kind'), 'implementation');
  assert.equal(url.searchParams.get('workflow'), 'timesheet');
  assert.equal(url.searchParams.has('taskPrompt'), false);
});

test('preference reads omit MCP process identities but preserve native session scope', async () => {
  let url;
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async value => { url = new URL(value); return jsonResponse(200, {}); } });
  await client.collaborationPreferences('synthetic-space', null, 100, null,
    { sourceSessionId: 'fuli-host-process' });
  assert.equal(url.searchParams.has('session_id'), false);
  await client.collaborationPreferences('synthetic-space', null, 100, null,
    { sessionId: 'native-session', sourceSessionId: 'fuli-host-process' });
  assert.equal(url.searchParams.get('session_id'), 'native-session');
  await client.collaborationPreferences('synthetic-space', null, 100, null,
    { sourceSessionId: 'native-source-session' });
  assert.equal(url.searchParams.get('session_id'), 'native-source-session');
});

test('current-task lookup bounds its own timeout without increasing a stricter client timeout', async () => {
  for (const [requestTimeoutMs, lookupTimeoutMs, maximumMs] of [[1000, 15, 250], [15, 1500, 250]]) {
    const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token', requestTimeoutMs,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
    const start = performance.now();
    await assert.rejects(client.currentTaskContext({ session_id: 'synthetic' }, { timeoutMs: lookupTimeoutMs }),
      error => error instanceof ProviderRequestError && error.code === 'provider_timeout');
    assert.ok(performance.now() - start < maximumMs);
  }
});

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
  await client.readKnowledgeReviewDecision({
    personal_space_id: 'personal-1', review_id: 'review-1', candidate_key: 'entity:one'
  });
  await client.finishKnowledgeReview({
    personal_space_id: 'personal-1', review_id: 'review-1', disposition: 'paused'
  });

  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    '/v1/knowledge/reviews/start',
    '/v1/knowledge/reviews/candidates',
    '/v1/knowledge/reviews/progress',
    '/v1/knowledge/reviews/decision',
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

test('provider client classifies malformed successful JSON as an invalid response', async () => {
  const client = new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:8787',
    accessToken: 'test-token',
    fetchImpl: async () => new Response('{malformed', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  });

  await assert.rejects(
    client.health(),
    (error) => error instanceof ProviderRequestError &&
      error.code === 'provider_invalid_response' &&
      error.status === 0 &&
      error.message === 'Graphiti provider returned invalid JSON.'
  );
});

test('provider client rejects non-JSON and empty successful responses', async () => {
  for (const response of [
    new Response('<html>proxy error</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    }),
    new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  ]) {
    const client = new GraphitiProviderClient({
      baseUrl: 'http://127.0.0.1:8787',
      accessToken: 'test-token',
      fetchImpl: async () => response
    });

    await assert.rejects(
      client.health(),
      (error) => error instanceof ProviderRequestError &&
        error.code === 'provider_invalid_response' &&
        error.status === 0
    );
  }
});

test('provider client keeps malformed non-2xx responses on the HTTP error path', async () => {
  const client = new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:8787',
    accessToken: 'test-token',
    fetchImpl: async () => new Response('{malformed', {
      status: 503,
      headers: { 'content-type': 'application/json' }
    })
  });

  await assert.rejects(
    client.health(),
    (error) => error instanceof ProviderRequestError &&
      error.code === 'provider_http_5xx' &&
      error.status === 503
  );
});

test('provider client keeps the graph data format refusal and its reason (rec#17)', async () => {
  const client = new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:8787',
    accessToken: 'test-token',
    fetchImpl: async () => new Response(JSON.stringify({ detail: { code: 'data_format_read_only',
      message: 'The graph needs migration graph/9-group-id-separators; FULI keeps the graph read-only.' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    })
  });

  await assert.rejects(client.listSpaces(), (error) => error instanceof ProviderRequestError
    && error.code === 'data_format_read_only' && error.status === 503
    && /graph\/9-group-id-separators.*read-only/.test(error.message));
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

test('a rotated access token is adopted once and the rejected request repeated', async () => {
  const seen = [];
  let refreshes = 0;
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'old-token',
    refreshAccessToken: async () => { refreshes += 1; return 'new-token'; },
    fetchImpl: async (_url, options) => {
      seen.push(options.headers.authorization);
      return options.headers.authorization === 'Bearer new-token'
        ? jsonResponse(200, { ok: true }) : jsonResponse(401, { detail: 'invalid access token' });
    } });

  assert.deepEqual(await client.conversation('query', { mode: 'policy' }), { ok: true });
  assert.deepEqual(seen, ['Bearer old-token', 'Bearer new-token']);
  await client.conversation('query', { mode: 'policy' });
  assert.equal(refreshes, 1, 'the adopted token is kept for later requests');
});

test('a 401 is reported unchanged when no different token is available', async () => {
  for (const refreshAccessToken of [async () => 'same-token', async () => null, async () => { throw new Error('unreadable'); }]) {
    let calls = 0;
    const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'same-token',
      refreshAccessToken,
      fetchImpl: async () => { calls += 1; return jsonResponse(401, { detail: 'invalid access token' }); } });
    await assert.rejects(client.listSpaces(), (error) => error instanceof ProviderRequestError && error.status === 401);
    assert.equal(calls, 1);
  }
  let refreshed = false;
  const unauthenticated = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'token',
    refreshAccessToken: async () => { refreshed = true; return 'other'; },
    fetchImpl: async () => jsonResponse(401, { detail: 'nope' }) });
  await assert.rejects(unauthenticated.health());
  assert.equal(refreshed, false);
});
