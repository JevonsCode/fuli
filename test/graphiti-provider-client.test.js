import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GraphitiProviderClient,
  ProviderRequestError
} from '../src/graphiti/provider-client.js';
import { FULI_VERSION } from '../src/package-metadata.js';
import { errorToolResult } from '../src/mcp/tool-result.js';

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
  // The provider names an older connection by it (rec#74).
  assert.equal(calls[0].options.headers['x-fuli-client-version'], FULI_VERSION);
});

test('meaning index calls send the space and model with ordinary auth', async () => {
  const calls = [];
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse(200, {}); } });
  const items = [{ item_kind: 'entity', item_id: 'synthetic-item', hash: 'a'.repeat(64), vector: [0.1, 0.2] }];
  await client.semanticPending({ personalSpaceId: 'synthetic-space', model: 'synthetic-model', limit: 8,
    after: 'entity:synthetic-item' });
  await client.writeSemanticVectors({ personalSpaceId: 'synthetic-space', model: 'synthetic-model', items });
  await client.semanticStatus({ personalSpaceId: 'synthetic-space', model: 'synthetic-model' });
  assert.deepEqual(calls.map(({ url }) => url.replace('http://provider.test', '')),
    ['/v1/semantic/pending', '/v1/semantic/vectors', '/v1/semantic/status']);
  assert.deepEqual(calls.map(({ options }) => JSON.parse(options.body)), [
    { personal_space_id: 'synthetic-space', model: 'synthetic-model', limit: 8, after: 'entity:synthetic-item' },
    { personal_space_id: 'synthetic-space', model: 'synthetic-model', items },
    { personal_space_id: 'synthetic-space', model: 'synthetic-model' }
  ]);
  for (const { options } of calls) {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, 'Bearer synthetic-token');
    assert.equal(options.headers['x-fuli-human-review-token'], undefined);
  }
});

test('retrieval term calls send the space, project and items with ordinary auth', async () => {
  const calls = [];
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse(200, {}); } });
  const items = [{ item_kind: 'entity', item_id: 'synthetic-item', hash: 'a'.repeat(64), terms: ['ship window'] }];
  await client.retrievalCandidates({ personalSpaceId: 'synthetic-space', personalProjectId: 'synthetic-project',
    limit: 8, after: 'entity:synthetic-item', missingOnly: true });
  await client.writeRetrievalTerms({ personalSpaceId: 'synthetic-space', items });
  await client.retrievalStats({ personalSpaceId: 'synthetic-space' });
  assert.deepEqual(calls.map(({ url }) => url.replace('http://provider.test', '')),
    ['/v1/retrieval/candidates', '/v1/retrieval/terms', '/v1/retrieval/stats']);
  assert.deepEqual(calls.map(({ options }) => JSON.parse(options.body)), [
    { personal_space_id: 'synthetic-space', personal_project_id: 'synthetic-project', limit: 8,
      after: 'entity:synthetic-item', missing_only: true },
    { personal_space_id: 'synthetic-space', items },
    { personal_space_id: 'synthetic-space' }
  ]);
  for (const { options } of calls) {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, 'Bearer synthetic-token');
    assert.equal(options.headers['x-fuli-human-review-token'], undefined);
  }
});

test('a scope export sends the space, scope and vector choice with ordinary auth and returns the envelope text', async () => {
  const calls = [];
  const text = '{"complete":true,"digest":"' + 'a'.repeat(64) + '","graphFormat":25,"nodes":[],"replicaProtocol":1,'
    + '"scope":"project:synthetic-project","spaceId":"synthetic-space"}';
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonText(text); } });
  const exported = await client.exportScope({ personalSpaceId: 'synthetic-space', scope: 'project:synthetic-project' });
  assert.deepEqual({ ...exported }, { text, scope: 'project:synthetic-project', spaceId: 'synthetic-space',
    digest: 'a'.repeat(64), complete: true, graphFormat: 25, replicaProtocol: 1, bytes: text.length });
  assert.ok(Object.isFrozen(exported));
  await client.exportScope({ personalSpaceId: 'synthetic-space', scope: 'global', vectors: false });
  assert.deepEqual(calls.map(({ url }) => url), ['http://provider.test/v1/scopes/export',
    'http://provider.test/v1/scopes/export']);
  assert.deepEqual(calls.map(({ options }) => JSON.parse(options.body)), [
    { personal_space_id: 'synthetic-space', scope: 'project:synthetic-project', vectors: true },
    { personal_space_id: 'synthetic-space', scope: 'global', vectors: false }
  ]);
  for (const { options } of calls) {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, 'Bearer synthetic-token');
    assert.equal(options.headers['x-fuli-human-review-token'], undefined);
  }
});

test('an exported envelope reaches the import byte for byte, its numbers as the owner wrote them', async () => {
  // Parsing and serializing again would write 0, 1 and 0.00001, the big integer
  // rounded, and the digest would no longer match.
  const text = '{"digest":"' + 'c'.repeat(64) + '","nodes":[{"id":"Entity:synthetic","properties":{'
    + '"count":12345678901234567890,"name":"Synthetic Grüße 你好 \\u00e9","name_embedding":[0.0,1.0,1e-05,-2.5E+3]}}],'
    + '"scope":"global"}';
  const calls = [];
  const result = { scope: 'global', nodes: { created: 1 } };
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.endsWith('/v1/scopes/export') ? jsonText(text) : jsonResponse(200, result);
    } });
  const exported = await client.exportScope({ personalSpaceId: 'synthetic-space', scope: 'global' });
  assert.deepEqual(await client.importScope({ envelope: exported.text, owner: 'b'.repeat(64) }), result);
  const sent = calls[1].options.body;
  assert.equal(typeof sent, 'string');
  assert.ok(Buffer.from(sent, 'utf8').equals(Buffer.from(text, 'utf8')));
  assert.equal(exported.bytes, Buffer.byteLength(text));
  assert.equal(calls[1].url, `http://provider.test/v1/scopes/import?owner=${'b'.repeat(64)}`);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers['content-type'], 'application/json');
  assert.equal(calls[1].options.headers.authorization, 'Bearer synthetic-token');
  assert.equal(calls[1].options.headers['x-fuli-human-review-token'], undefined);
});

test('an export larger than the cap a copy takes is not read into memory, and is refused as too large', async () => {
  const text = `{"digest":"${'a'.repeat(64)}","scope":"global","nodes":[${'{"id":"Entity:synthetic"},'.repeat(20)}{}]}`;
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async () => new Response(new Blob([text]).stream(), { status: 200, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.exportScope({ personalSpaceId: 'synthetic-space', scope: 'global', maxBytes: 100 }),
    { status: 413, code: 'scope_too_large' });
  const within = await client.exportScope({ personalSpaceId: 'synthetic-space', scope: 'global', maxBytes: text.length });
  assert.equal(within.text, text);
});

test('a scope import takes only the envelope text, never a parsed envelope', () => {
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async () => assert.fail('nothing is sent') });
  assert.throws(() => client.importScope({ envelope: { scope: 'global' }, owner: 'b'.repeat(64) }), TypeError);
});

test('a refused scope import keeps its code', async () => {
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async () => jsonResponse(409, { detail: { code: 'replica_scope_owned_here', message: 'Synthetic.' } }) });
  await assert.rejects(client.importScope({ envelope: '{}', owner: 'b'.repeat(64) }),
    (error) => error.status === 409 && error.code === 'replica_scope_owned_here' && error.message === 'Synthetic.');
});

test('a hire for a follower\'s recruitment and an item\'s view reach their Provider routes', async () => {
  const calls = [];
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => { calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      return jsonResponse(200, { status: 'synthetic' }); } });
  await client.hireForFollowerRecruitment({ personalSpaceId: 'synthetic-space', recruitmentId: 'synthetic-recruitment',
    agentId: 'synthetic-agent', profile: { name: 'Synthetic Lead' }, occupation: { role: 'synthetic_role', tags: [] },
    taskId: 'synthetic-task', recruitmentSourceApplication: 'kiro',
    reason: 'Synthetic reason', origin: { computer: 'Synthetic computer', fingerprint: 'a'.repeat(64),
      project: 'Synthetic project' } });
  await client.readKnowledgeItemView({ personalSpaceId: 'synthetic-space', itemKind: 'entity', itemId: 'synthetic-item' });
  assert.deepEqual(calls, [
    { url: 'http://provider.test/v1/project-agents/owner-hire', method: 'POST', body: { personal_space_id: 'synthetic-space',
      recruitment_id: 'synthetic-recruitment', agent_id: 'synthetic-agent', profile: { name: 'Synthetic Lead' },
      occupation: { role: 'synthetic_role', tags: [] }, reason: 'Synthetic reason',
      task_id: 'synthetic-task', recruitment_source_application: 'kiro',
      origin_computer: 'Synthetic computer', origin_fingerprint: 'a'.repeat(64), origin_project: 'Synthetic project' } },
    { url: 'http://provider.test/v1/knowledge/item-views', method: 'POST',
      body: { personal_space_id: 'synthetic-space', item_kind: 'entity', item_id: 'synthetic-item' } }]);
});

test('a hire the Provider refuses keeps its code', async () => {
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async () => jsonResponse(409, { detail: { code: 'agent_id_taken', message: 'Synthetic.' } }) });
  await assert.rejects(client.hireForFollowerRecruitment({ personalSpaceId: 'synthetic-space', recruitmentId: 'synthetic-recruitment',
    agentId: 'synthetic-agent', profile: {}, occupation: null, reason: null, origin: { computer: null, fingerprint: null, project: null } }),
  (error) => error.status === 409 && error.code === 'agent_id_taken');
});

test('conversation triage reaches every Provider operation, decline and reopen included', async () => {
  const urls = [];
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (url) => { urls.push(url); return jsonResponse(200, {}); } });
  for (const operation of ['record', 'read', 'topics', 'form', 'decline', 'reopen']) {
    await client.conversationTriage(operation, { personal_space_id: 'synthetic-space' });
  }
  assert.deepEqual(urls.map(url => url.replace('http://provider.test/v1/conversation-triage/', '')),
    ['record', 'read', 'topics', 'form', 'decline', 'reopen']);
  assert.throws(() => client.conversationTriage('delete', {}), /Unknown conversation triage operation/);
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

test('host WorkerRun revocation uses its exact HTTP port and no capability header', async () => {
  const calls = [];
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse(200, {}); } });
  const scope = { personal_space_id: 'worker-space', personal_project_id: 'worker-project' };
  await client.revokeProjectAgentWorkerRun('worker/run', { ...scope, reason: 'cancelled' }, { signal: null });
  assert.deepEqual(calls.map(({ url, options }) => [options.method, new URL(url).pathname]),
    [['POST', '/v1/project-agent-worker-runs/worker%2Frun/revoke']]);
  assert.equal(calls[0].options.headers['x-fuli-worker-capability'], undefined);
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
    fetchImpl: async () => jsonResponse(403, { detail: 'space access required' })
  });

  await assert.rejects(
    client.listSpaces(),
    (error) => error instanceof ProviderRequestError &&
      error.status === 403 && error.message === 'space access required'
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
    client.listSpaces(),
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
        message: 'Value error, non-known-known knowledge requires a reasoning summary',
        type: 'value_error'
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

// 11-11: workflow observations were removed; an old runtime config's token is
// still accepted but never sent.
test('a client built with the old workflow observation token never sends it', async () => {
  const calls = [];
  const client = new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:8787',
    accessToken: 'local-test-token',
    workflowObservationToken: 'mcp-host-workflow-observation-token-123456',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, {});
    }
  });
  await client.reviseKnowledgeItem('item-1', { personal_space_id: 'personal-1' });
  assert.equal(client.recordWorkflowObservation, undefined);
  // 11-23: nor does it read learned workflow candidates any more.
  assert.equal(client.searchWorkflowCandidates, undefined);
  assert.equal('x-fuli-workflow-observation-token' in calls[0].options.headers, false);
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

test('a write the Provider refused on a read-only copy is a controlled error that says where to make it', async () => {
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async () => jsonResponse(409, { detail: {
      code: 'replica_read_only', record: 'Entity:synthetic-habit', scopes: ['global'], owner: 'a'.repeat(64),
      message: 'Entity:synthetic-habit is part of global, which another computer owns.' } }) });
  const error = await client.reviseKnowledgeItem('synthetic-habit', { personal_space_id: 'synthetic-space' })
    .then(() => assert.fail('refused'), refused => refused);
  assert.ok(error instanceof ProviderRequestError);
  assert.equal(error.code, 'replica_read_only');
  assert.equal(error.status, 409);
  assert.match(error.message, /^Entity:synthetic-habit belongs to the computer this one follows/);
  assert.match(error.message, /在主机上改，或等这台电脑连上主机/);
  const result = errorToolResult(error);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'replica_read_only', 'never internal_error');
  assert.match(result.content[0].text, /Make this change on that computer/);
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

test('the duplicate-merge pass sends the space, and a limit only when given, with ordinary auth; so does the preference organising read', async () => {
  const calls = [];
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse(200, { merged: [] }); } });
  await client.mergeDuplicates({ personalSpaceId: 'synthetic-space' });
  await client.mergeDuplicates({ personalSpaceId: 'synthetic-space', limit: 5 });
  assert.deepEqual(calls.map(({ url }) => url.replace('http://provider.test', '')),
    ['/v1/knowledge/duplicates/merge', '/v1/knowledge/duplicates/merge']);
  assert.deepEqual(calls.map(({ options }) => JSON.parse(options.body)), [
    { personal_space_id: 'synthetic-space' }, { personal_space_id: 'synthetic-space', limit: 5 }]);
  assert.equal(calls[0].options.headers.authorization, 'Bearer synthetic-token');
  await client.readPreferenceOrganizing({ personalSpaceId: 'synthetic-space', offset: 50 });
  assert.equal(calls[2].url, 'http://provider.test/v1/knowledge/preferences/organizing');
  assert.deepEqual(JSON.parse(calls[2].options.body), { personal_space_id: 'synthetic-space', offset: 50 });
});

function jsonText(text) {
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
}

test('project transfers preserve the original package bytes and require a usable seal', async () => {
  const digest = 'a'.repeat(64);
  const image = '{ "digest": "' + digest + '", "text": "样本" }';
  let reply = image;
  const sent = [];
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic',
    fetchImpl: async (url, options) => {
      sent.push({ url: new URL(url), body: options.body });
      return new Response(reply, { headers: { 'content-type': 'application/json' } });
    } });
  const phase = (phase, bundle) => client.projectHandover({ personalSpaceId: 'space', projectId: 'project', moveId: 'same', phase, bundle });
  assert.deepEqual(await phase('seal'), { text: image, digest });
  await phase('stage', image);
  assert.equal(sent[1].body, image);
  assert.equal(sent[1].url.searchParams.get('phase'), 'stage');
  await assert.rejects(phase('stage', JSON.parse(image)), TypeError);
  assert.equal(sent.length, 2);
  reply = '{"empty":true}';
  assert.deepEqual(await phase('baseline'), { empty: true });
  await assert.rejects(phase('seal'), /digest/i);
  reply = '{"digest":"wrong"}';
  await assert.rejects(phase('baseline'), /digest/i);
});
