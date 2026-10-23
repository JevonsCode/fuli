import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createReviewGate } from '../src/judgment/review-gate.js';
import { reviewGateKey } from '../src/judgment/review-build.js';
import { readModelBackendConfig } from '../src/model-backends/config.js';
import { createModelBackendPort } from '../src/model-backends/port.js';
import { compactReceipt } from '../src/model-backends/receipt.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';
import { openAiStream } from './fixtures/model-transport.js';

// rec#8: the port reports the digest of the build that served an answer only
// when the backend proves it for that call, so the D-24 gate can match a real
// build. A fake Ollama on a free loopback port stands in for the model; no
// real model runs, and no key is configured.

const MODEL = 'synthetic-model:4b';
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const REPLY = JSON.stringify({ decision: 'propose', payload: { choice: 'ada' }, reason: 'Synthetic evidence.',
  evidenceIds: ['e1'], uncertainty: null });

const request = () => ({
  role: 'tonborg', operation: 'pick', requestId: 'req-1', sourceEventId: 'event-1',
  scope: { personalSpaceId: 'space', personalProjectId: 'alpha', sessionRef: 'codex:thread-1' },
  versions: { evidence: 'ev-1', policy: 'pol-1' },
  instructions: 'Which synthetic Agent should take the next review?',
  evidence: [{ id: 'e1', personalProjectId: 'alpha', text: 'Synthetic project content.' }],
  output: { type: 'choice', options: [{ id: 'ada', description: 'Ada, reviewer' }, { id: 'bo', description: 'Bo, writer' }] }
});

// tags(n): the nth /api/tags answer as { status, body } (or a function that
// never answers); chat: what /v1/chat/completions streams.
async function fakeOllama(t, { tags = () => ({ status: 200, body: { models: [{ name: MODEL, model: MODEL, digest: DIGEST }] } }),
  chatModel = MODEL } = {}) {
  const seen = [];
  const server = createServer(async (incoming, response) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    seen.push({ method: incoming.method, url: incoming.url, authorization: incoming.headers.authorization ?? null, body });
    if (incoming.url === '/api/tags') {
      const answer = tags(seen.filter(hit => hit.url === '/api/tags').length);
      if (!answer) return;
      response.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
      return;
    }
    if (incoming.url === '/v1/chat/completions') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(await openAiStream(REPLY, { model: chatModel }).text());
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, seen };
}

function portFor(endpoint, { fetchImpl = globalThis.fetch, ledger = new ModelUsageLedger(':memory:'), timeoutMs = 30_000 } = {}) {
  const config = {
    version: 1,
    connections: { local: { protocol: 'openai_chat', endpoint, model: MODEL, secretRef: null } },
    roles: { tonborg: { enabled: true, connection: 'local', allowedOperations: ['pick'],
      egress: { approvedProjects: [{ personalSpaceId: 'space', personalProjectId: 'alpha' }], allowUnassigned: false },
      budget: { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs, windowHours: 24, maxTokensPerWindow: 100_000 },
      fallbackToSession: true } }
  };
  const port = createModelBackendPort({ readConfig: () => readModelBackendConfig('model-backends.json', { read: () => config }),
    secrets: { read: async () => null }, ledger, fetchImpl, wait: async () => {} });
  return { port, ledger };
}

const digests = ledger => ledger.db.prepare('SELECT model_digest AS digest FROM model_attempts ORDER BY attempt_number').all()
  .map(row => row.digest);

test('a local Ollama that lists the exact tag with the same digest before and after the answer proves the served build', async t => {
  const ollama = await fakeOllama(t);
  const { port, ledger } = portFor(ollama.endpoint);

  const { envelope, modelReceipt } = await port.decide(request());
  assert.deepEqual(envelope.payload, { choice: 'ada' });
  assert.equal(modelReceipt.modelDigest, DIGEST);
  assert.equal(compactReceipt(modelReceipt).modelDigest, DIGEST);
  assert.deepEqual(digests(ledger), [DIGEST]);
  // Read before and after the call, with no key and no content.
  assert.deepEqual(ollama.seen.map(hit => `${hit.method} ${hit.url}`),
    ['GET /api/tags', 'POST /v1/chat/completions', 'GET /api/tags']);
  for (const read of ollama.seen.filter(hit => hit.url === '/api/tags')) assert.deepEqual([read.authorization, read.body], [null, '']);
  // Settings reads the last served build of the role's configured model.
  const [view] = port.roles().roles.filter(role => role.role === 'tonborg');
  assert.equal(port.lastServed(view).modelDigest, DIGEST);
});

test('a known digest only allows matching: the empty D-24 registry still keeps the review a suggestion', async t => {
  const ollama = await fakeOllama(t);
  const { modelReceipt } = await portFor(ollama.endpoint).port.decide(request());
  const gate = createReviewGate().status(reviewGateKey({ modelId: modelReceipt.actualModel, modelDigest: modelReceipt.modelDigest }));
  assert.deepEqual([gate.status, gate.reason, gate.modelDigest], ['not_passed', 'no_entry', DIGEST]);
});

const UNPROVEN = {
  'the digest changes between the reads': { tags: n => ({ status: 200, body: { models: [{ name: MODEL, digest: n === 1 ? DIGEST : OTHER_DIGEST }] } }) },
  'only another tag of the model is listed': { tags: () => ({ status: 200, body: { models: [{ name: 'synthetic-model:latest', digest: DIGEST }] } }) },
  'the tag is listed with two digests': { tags: () => ({ status: 200,
    body: { models: [{ name: MODEL, digest: DIGEST }, { name: MODEL, digest: OTHER_DIGEST }] } }) },
  'the digest is not a sha256 hex digest': { tags: () => ({ status: 200, body: { models: [{ name: MODEL, digest: 'sha256-short' }] } }) },
  'the tag is listed without a digest': { tags: () => ({ status: 200, body: { models: [{ name: MODEL }] } }) },
  'the server has no Ollama tags route': { tags: () => ({ status: 404, body: { error: 'not found' } }) },
  'the answer names another model': { chatModel: 'synthetic-model:8b' }
};

for (const [name, ollamaOptions] of Object.entries(UNPROVEN)) {
  test(`unknown when ${name}; the answer itself is unaffected`, async t => {
    const ollama = await fakeOllama(t, ollamaOptions);
    const { port, ledger } = portFor(ollama.endpoint);
    const { envelope, modelReceipt } = await port.decide(request());
    assert.deepEqual(envelope.payload, { choice: 'ada' });
    assert.equal(modelReceipt.modelDigest, null);
    assert.deepEqual(digests(ledger), [null]);
    assert.equal(createReviewGate().status(reviewGateKey({ modelId: MODEL, modelDigest: modelReceipt.modelDigest })).reason,
      'model_build_unknown');
  });
}

test('a tags read that never answers is cut off by its own limit; the answer completes with an unknown digest', async t => {
  const ollama = await fakeOllama(t, { tags: () => null });
  const started = Date.now();
  const { envelope, modelReceipt } = await portFor(ollama.endpoint).port.decide(request());
  assert.deepEqual(envelope.payload, { choice: 'ada' });
  assert.equal(modelReceipt.modelDigest, null);
  assert.ok(Date.now() - started < 10_000);
  // No answer before the call, so nothing is read after it.
  assert.deepEqual(ollama.seen.map(hit => hit.url), ['/api/tags', '/v1/chat/completions']);
});

test('an HTTPS endpoint is never asked for tags; its digest is unknown', async () => {
  const urls = [];
  const fetchImpl = async url => { urls.push(String(url)); return openAiStream(REPLY, { model: MODEL }); };
  const { modelReceipt } = await portFor('https://models.example.test/v1', { fetchImpl }).port.decide(request());
  assert.equal(modelReceipt.status, 'completed');
  assert.equal(modelReceipt.modelDigest, null);
  assert.deepEqual(urls, ['https://models.example.test/v1/chat/completions']);
});

test('a failed answer reads no digest after it', async () => {
  const seen = [];
  const fetchImpl = async url => {
    seen.push(new URL(url).pathname);
    return new URL(url).pathname === '/api/tags'
      ? Response.json({ models: [{ name: MODEL, digest: DIGEST }] })
      : Response.json({ error: { message: 'bad request' } }, { status: 400 });
  };
  const { modelReceipt } = await portFor('http://127.0.0.1:11434/v1', { fetchImpl }).port.decide(request());
  assert.notEqual(modelReceipt.status, 'completed');
  assert.equal(modelReceipt.modelDigest, null);
  assert.deepEqual(seen, ['/api/tags', '/v1/chat/completions']);
});
