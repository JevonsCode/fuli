import assert from 'node:assert/strict';
import test from 'node:test';

import { readModelBackendConfig } from '../src/model-backends/config.js';
import { handleModelBackendApiRequest } from '../src/model-backends/http.js';
import { createModelBackendPort } from '../src/model-backends/port.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';

// rec#88: the semantic role's embedding call. Every request goes to an
// injected fake transport with synthetic texts; no real or local model runs.

const NOW = new Date('2026-11-06T12:00:00.000Z');
const TEXTS = ['Synthetic note about release steps.', 'Synthetic note about review order.'];
const SPACE = 'space-synthetic';

const budget = (extra = {}) => ({ maxInputTokens: null, maxOutputTokens: null, timeoutMs: null, windowHours: null,
  maxTokensPerWindow: null, ...extra });

function config({ connection = {}, role = {}, roles = {} } = {}) {
  return {
    version: 1,
    connections: {
      ollama: { protocol: 'openai_embeddings', endpoint: 'http://127.0.0.1:11434/v1', model: 'synthetic-embed', secretRef: null,
        headers: { 'X-Gateway': 'synthetic' }, ...connection },
      chat: { protocol: 'openai_chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'synthetic-chat', secretRef: null }
    },
    roles: {
      semantic: { enabled: true, connection: 'ollama', allowedOperations: ['knowledge_embedding'],
        egress: { approvedProjects: [{ personalSpaceId: SPACE, personalProjectId: 'alpha' }], allowUnassigned: false },
        budget: budget(), fallbackToSession: false, ...role },
      ...roles
    }
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const vectorsReply = (vectors, extra = {}) => json(200, { object: 'list', model: 'synthetic-embed-actual',
  data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })), usage: { prompt_tokens: 12, total_tokens: 12 },
  ...extra });

function harness({ raw = config(), responses = [], keys = {} } = {}) {
  const calls = [];
  const waits = [];
  const ledger = new ModelUsageLedger(':memory:');
  const port = createModelBackendPort({
    readConfig: () => readModelBackendConfig('model-backends.json', { read: () => raw }),
    secrets: { read: async ref => keys[ref] ?? null },
    ledger,
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const next = responses.shift();
      if (!next) throw new Error('No fake response queued');
      return next;
    },
    wait: async ms => { waits.push(ms); },
    now: () => NOW
  });
  return { port, calls, waits, ledger };
}

const request = (overrides = {}) => ({ role: 'semantic', operation: 'knowledge_embedding', requestId: 'embed-1',
  scope: { personalSpaceId: SPACE, personalProjectId: 'alpha', sessionRef: null }, texts: TEXTS, ...overrides });

test('the semantic role takes only the embeddings protocol, and that protocol serves no other role', () => {
  const read = raw => readModelBackendConfig('model-backends.json', { read: () => raw });
  assert.equal(read(config()).state, 'ok');
  const chatForSemantic = read(config({ role: { connection: 'chat' } }));
  assert.equal(chatForSemantic.state, 'invalid');
  assert.match(chatForSemantic.error, /roles\.semantic\.connection must use openai_embeddings/);
  const embedForAgent = read(config({ roles: { bole: { enabled: false, connection: 'ollama' } } }));
  assert.equal(embedForAgent.state, 'invalid');
  assert.match(embedForAgent.error, /roles\.bole\.connection uses openai_embeddings, which only semantic search takes/);
  assert.match(read(config({ role: { fallbackToSession: true } })).error, /session cannot turn text into vectors/);
});

test('texts go out as one OpenAI embeddings request and come back as vectors in order, with no key for a local model', async () => {
  const { port, calls, ledger } = harness({ responses: [json(200, { model: 'synthetic-embed-actual', usage: { prompt_tokens: 12 },
    data: [{ index: 1, embedding: [0.4, 0.5, 0.6] }, { index: 0, embedding: [0.731984, 0.2, 0.3] }] })] });
  const result = await port.embed(request());
  assert.equal(result.modelReceipt.status, 'completed');
  assert.deepEqual(result.vectors, [[0.731984, 0.2, 0.3], [0.4, 0.5, 0.6]]);
  assert.equal(result.dimensions, 3);
  assert.equal(result.model, 'synthetic-embed-actual');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/embeddings');
  assert.deepEqual(calls[0].body, { model: 'synthetic-embed', input: TEXTS });
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].headers['X-Gateway'], 'synthetic');
  const [group] = port.usage({ role: 'semantic' }).groups;
  assert.equal(group.requests, 1);
  assert.equal(group.tokens.input.reported, 12);
  // Neither a text nor a vector reaches the ledger.
  const stored = JSON.stringify(ledger.db.prepare('SELECT * FROM model_attempts').all());
  assert.equal(stored.includes('release steps'), false);
  assert.equal(stored.includes('731984'), false);
});

test('a configured key goes out as a bearer token', async () => {
  const { port, calls } = harness({ raw: config({ connection: { endpoint: 'https://dashscope.example.com/compatible-mode/v1',
    secretRef: 'qwen-main' } }), keys: { 'qwen-main': 'sk-SYNTHETIC' }, responses: [vectorsReply([[1, 0], [0, 1]])] });
  assert.equal((await port.embed(request())).modelReceipt.status, 'completed');
  assert.equal(calls[0].headers.authorization, 'Bearer sk-SYNTHETIC');
});

test('a wrong count, a ragged or non-numeric reply is a failure, never partial vectors', async () => {
  const replies = [
    vectorsReply([[0.1, 0.2]]),
    vectorsReply([[0.1, 0.2], [0.3]]),
    vectorsReply([[0.1, 0.2], [0.3, '0.4']]),
    vectorsReply([[0.1, 0.2], [0.3, null]]),
    json(200, { data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }),
    json(200, { error: 'no data' })
  ];
  for (const reply of replies) {
    const { port } = harness({ responses: [reply] });
    const result = await port.embed(request());
    assert.equal(result.vectors, null);
    assert.equal(result.dimensions, null);
    assert.equal(result.modelReceipt.status, 'failed');
    assert.equal(result.modelReceipt.reason, 'invalid_response');
    assert.equal(result.modelReceipt.fallbackEligible, false);
  }
});

test('a project not approved for the role, also on a loopback endpoint, sends nothing', async () => {
  const { port, calls } = harness();
  const other = await port.embed(request({ scope: { personalSpaceId: SPACE, personalProjectId: 'beta', sessionRef: null } }));
  assert.equal(other.modelReceipt.status, 'stopped');
  assert.equal(other.modelReceipt.reason, 'egress_not_approved');
  const unassigned = await port.embed(request({ scope: { personalSpaceId: SPACE, personalProjectId: null, sessionRef: null } }));
  assert.equal(unassigned.modelReceipt.reason, 'egress_not_approved');
  assert.equal(calls.length, 0);
  assert.equal(port.allowsEgress(request()), true);
  assert.equal(port.allowsEgress(request({ scope: { personalSpaceId: 'other-space', personalProjectId: 'alpha', sessionRef: null } })), false);
});

test('without the role or its operation nothing is sent, and no session is offered in its place', async () => {
  const absent = harness({ raw: { version: 1, connections: {}, roles: {} } });
  const result = await absent.port.embed(request());
  assert.equal(result.modelReceipt.status, 'not_configured');
  assert.equal(result.modelReceipt.fallbackEligible, false);
  const narrowed = harness({ raw: config({ role: { allowedOperations: [] } }) });
  assert.equal((await narrowed.port.embed(request())).modelReceipt.reason, 'operation_not_allowed');
  assert.equal(narrowed.port.operationSettings('semantic', 'knowledge_embedding'), null);
  assert.equal(absent.calls.length + narrowed.calls.length, 0);
});

test('a transient failure is retried once; a window budget pauses the call', async () => {
  const flaky = harness({ responses: [json(503, { error: { message: 'busy' } }), vectorsReply([[1], [2]])] });
  const retried = await flaky.port.embed(request());
  assert.equal(retried.modelReceipt.status, 'completed');
  assert.equal(retried.modelReceipt.attempts, 2);
  assert.equal(flaky.waits.length, 1);
  const capped = harness({ raw: config({ role: { budget: budget({ maxTokensPerWindow: 5 }) } }) });
  const paused = await capped.port.embed(request());
  assert.equal(paused.modelReceipt.status, 'paused');
  assert.equal(capped.calls.length, 0);
});

test('a call takes 1 to 64 texts and only the semantic role embeds', async () => {
  const { port } = harness();
  await assert.rejects(port.embed(request({ texts: [] })), TypeError);
  await assert.rejects(port.embed(request({ texts: Array.from({ length: 65 }, (_, index) => `text ${index}`) })), TypeError);
  await assert.rejects(port.embed(request({ role: 'bole' })), TypeError);
  await assert.rejects(port.decide({ role: 'semantic', operation: 'knowledge_embedding', requestId: 'r', scope: request().scope,
    versions: { evidence: 'e', policy: 'p' }, instructions: 'x', output: { type: 'score', levels: ['a', 'b'] } }), TypeError);
});

test('the check sends one short fixed text without a project and the route reports the dimensions', async () => {
  const { port, calls } = harness({ raw: config({ role: { egress: undefined } }), responses: [vectorsReply([[0.731984, 0.2, 0.3, 0.4]])] });
  const reply = { status: null, body: null };
  const response = { setHeader() {}, writeHead(status) { reply.status = status; }, end(text) { reply.body = JSON.parse(text); } };
  await handleModelBackendApiRequest({ request: { method: 'POST', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } },
    response, url: new URL('http://127.0.0.1/api/model-backends/roles/semantic/check'), modelBackends: port });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
  assert.equal(reply.body.dimensions, 4);
  assert.equal(reply.body.receipt.status, 'completed');
  assert.equal(JSON.stringify(reply.body).includes('731984'), false);
  assert.equal(calls[0].body.input.length, 1);
});
