import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { readModelBackendConfig } from '../src/model-backends/config.js';
import { createModelBackendPort } from '../src/model-backends/port.js';
import { compactReceipt } from '../src/model-backends/receipt.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';
import { listenFetchableServer } from '../src/server/listen.js';
import { openAiStream } from './fixtures/model-transport.js';

// rec#10 D-32: after a valid answer the port reads once which build a local
// Ollama lists for the configured tag. That is a catalog observation for the
// settings page, never proof of what served the answer: it reaches no receipt,
// and it never costs the answer its deadline, budget or repair. A fake Ollama
// on a free loopback port stands in for the model; no real model runs, and no
// key is configured.

const MODEL = 'synthetic-model:4b';
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const REPLY = JSON.stringify({ decision: 'propose', payload: { choice: 'ada' }, reason: 'Synthetic evidence.',
  evidenceIds: ['e1'], uncertainty: null });
const LISTED = () => ({ status: 200, body: { models: [{ name: MODEL, model: MODEL, digest: DIGEST }] } });

const request = () => ({
  role: 'tonborg', operation: 'pick', requestId: 'req-1', sourceEventId: 'event-1',
  scope: { personalSpaceId: 'space', personalProjectId: 'alpha', sessionRef: 'codex:thread-1' },
  versions: { evidence: 'ev-1', policy: 'pol-1' },
  instructions: 'Which synthetic Agent should take the next review?',
  evidence: [{ id: 'e1', personalProjectId: 'alpha', text: 'Synthetic project content.' }],
  output: { type: 'choice', options: [{ id: 'ada', description: 'Ada, reviewer' }, { id: 'bo', description: 'Bo, writer' }] }
});

// tags(): the /api/tags answer as { status, body } or { redirect }, or null to
// never answer; replies: what /v1/chat/completions streams, in order.
async function fakeOllama(t, { tags = LISTED, replies = [REPLY], chatModel = MODEL } = {}) {
  const seen = [];
  const server = createServer(async (incoming, response) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    seen.push({ method: incoming.method, url: incoming.url, authorization: incoming.headers.authorization ?? null, body });
    if (incoming.url === '/api/tags') {
      const answer = tags();
      if (!answer) return;
      if (answer.redirect) return response.writeHead(307, { location: answer.redirect }).end();
      response.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
      return;
    }
    if (incoming.url === '/v1/chat/completions') {
      const reply = replies[seen.filter(hit => hit.url === '/v1/chat/completions').length - 1] ?? REPLY;
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(await openAiStream(reply, { model: chatModel }).text());
      return;
    }
    response.writeHead(404).end();
  });
  await listenFetchableServer(server, 0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, seen,
    reads: () => seen.filter(hit => hit.url === '/api/tags').length };
}

function portFor(endpoint, { fetchImpl = globalThis.fetch, protocol = 'openai_chat', timeoutMs = 30_000, now, timeoutSignal } = {}) {
  const config = {
    version: 1,
    connections: { local: { protocol, endpoint, model: MODEL, secretRef: protocol === 'openai_chat' ? null : 'synthetic' } },
    roles: { tonborg: { enabled: true, connection: 'local', allowedOperations: ['pick'],
      egress: { approvedProjects: [{ personalSpaceId: 'space', personalProjectId: 'alpha' }], allowUnassigned: false },
      budget: { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs, windowHours: 24, maxTokensPerWindow: 100_000 },
      fallbackToSession: true } }
  };
  const ledger = new ModelUsageLedger(':memory:');
  const port = createModelBackendPort({ readConfig: () => readModelBackendConfig('model-backends.json', { read: () => config }),
    secrets: { read: async () => 'synthetic-key' }, ledger, fetchImpl, wait: async () => {},
    ...(now ? { now } : {}), ...(timeoutSignal ? { timeoutSignal } : {}) });
  const localBuild = () => port.localBuild('tonborg', 'local', config.connections.local);
  return { port, ledger, localBuild };
}

const observations = ledger => ledger.db.prepare('SELECT observed_tag_digest AS digest, outcome FROM model_attempts ORDER BY attempt_number')
  .all().map(row => ({ ...row }));

test('after a valid answer the listed build is observed once and kept for Settings only, never in a receipt', async t => {
  const ollama = await fakeOllama(t);
  const { port, ledger, localBuild } = portFor(ollama.endpoint);

  const { envelope, modelReceipt } = await port.decide(request());
  assert.deepEqual(envelope.payload, { choice: 'ada' });
  assert.equal(Object.hasOwn(modelReceipt, 'modelDigest'), false);
  assert.equal(JSON.stringify(compactReceipt(modelReceipt)).includes(DIGEST), false);
  assert.equal(JSON.stringify(modelReceipt).includes(DIGEST), false);
  assert.deepEqual(observations(ledger), [{ digest: DIGEST, outcome: 'succeeded' }]);
  // One read, after the answer, with no key and no content.
  assert.deepEqual(ollama.seen.map(hit => `${hit.method} ${hit.url}`), ['POST /v1/chat/completions', 'GET /api/tags']);
  assert.deepEqual([ollama.seen[1].authorization, ollama.seen[1].body], [null, '']);
  const shown = localBuild();
  assert.deepEqual([shown.status, shown.digest], ['observed', DIGEST]);
  assert.match(shown.completedAt, /^\d{4}-\d{2}-\d{2}T/);
});

const NOT_OBSERVED = {
  'only another tag of the model is listed (no :latest normalization)': {
    tags: () => ({ status: 200, body: { models: [{ name: 'synthetic-model:latest', digest: DIGEST }] } }) },
  'the tag is listed with two digests': { tags: () => ({ status: 200,
    body: { models: [{ name: MODEL, digest: DIGEST }, { name: MODEL, digest: OTHER_DIGEST }] } }) },
  'the digest is not a sha256 hex digest': { tags: () => ({ status: 200, body: { models: [{ name: MODEL, digest: 'sha256-short' }] } }) },
  'the tag is listed without a digest': { tags: () => ({ status: 200, body: { models: [{ name: MODEL }] } }) },
  'the server has no Ollama tags route': { tags: () => ({ status: 404, body: { error: 'not found' } }) },
  'the tags route redirects': { tags: () => ({ redirect: 'http://127.0.0.1:9/api/tags' }) },
  'the answer names another model': { chatModel: 'synthetic-model:8b', reads: 0 }
};

for (const [name, { reads = 1, ...ollamaOptions }] of Object.entries(NOT_OBSERVED)) {
  test(`not observed when ${name}; the answer is unaffected`, async t => {
    const ollama = await fakeOllama(t, ollamaOptions);
    const { port, ledger, localBuild } = portFor(ollama.endpoint);
    const { envelope } = await port.decide(request());
    assert.deepEqual(envelope.payload, { choice: 'ada' });
    assert.deepEqual(observations(ledger), [{ digest: null, outcome: 'succeeded' }]);
    assert.equal(ollama.reads(), reads);
    assert.equal(localBuild().status, 'not_observed');
  });
}

test('a 1 s deadline with a tags route that never answers: the answer succeeds within the deadline, nothing observed', async t => {
  const tagsRead = Promise.withResolvers();
  const ollama = await fakeOllama(t, { tags: () => { tagsRead.resolve(); return null; } });
  // A clock that stands still keeps the attempt at the port's 1 s minimum; the
  // deadline itself is a signal this test controls, so the tags read is
  // cancelled by that deadline rather than by elapsed wall time.
  const frozen = new Date('2026-10-24T08:00:00.000Z');
  const deadline = new AbortController();
  const localBuildDeadline = new AbortController();
  let signals = 0;
  const timeoutSignal = () => (++signals === 1 ? deadline.signal : localBuildDeadline.signal);
  let tagsSignal = null;
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname === '/api/tags') tagsSignal = init.signal;
    return globalThis.fetch(url, init);
  };
  const { port, ledger } = portFor(ollama.endpoint, { timeoutMs: 1000, now: () => frozen, fetchImpl, timeoutSignal });
  const decision = port.decide(request());
  await tagsRead.promise;
  assert.equal(tagsSignal.aborted, false);
  deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  const { envelope, modelReceipt } = await decision;
  assert.equal(modelReceipt.status, 'completed');
  assert.deepEqual(envelope.payload, { choice: 'ada' });
  assert.deepEqual(observations(ledger), [{ digest: null, outcome: 'succeeded' }]);
  assert.equal(ollama.reads(), 1);
  // The read ended with the attempt's deadline, not with a later timer.
  assert.equal(tagsSignal.reason, deadline.signal.reason);
});

test('with too little of the deadline left after the answer the build is not read at all', async t => {
  const ollama = await fakeOllama(t);
  // The clock moves 29.95 s while the answer streams: 50 ms remain.
  let at = Date.parse('2026-10-24T08:00:00.000Z');
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname === '/v1/chat/completions') at += 29_950;
    return globalThis.fetch(url, init);
  };
  const { port, ledger } = portFor(ollama.endpoint, { fetchImpl, now: () => new Date(at) });
  const { modelReceipt } = await port.decide(request());
  assert.equal(modelReceipt.status, 'completed');
  assert.deepEqual(observations(ledger), [{ digest: null, outcome: 'succeeded' }]);
  assert.equal(ollama.reads(), 0);
});

test('an invalid answer is repaired first; only the validated answer is followed by a read', async t => {
  const ollama = await fakeOllama(t, { replies: ['not json', REPLY] });
  const { port, ledger } = portFor(ollama.endpoint);
  const { envelope, modelReceipt } = await port.decide(request());
  assert.deepEqual(envelope.payload, { choice: 'ada' });
  assert.equal(modelReceipt.attempts, 2);
  assert.deepEqual(observations(ledger), [{ digest: null, outcome: 'invalid_output' }, { digest: DIGEST, outcome: 'succeeded' }]);
  assert.deepEqual(ollama.seen.map(hit => hit.url), ['/v1/chat/completions', '/v1/chat/completions', '/api/tags']);
});

test('a failed answer is never followed by a read', async () => {
  const seen = [];
  const fetchImpl = async url => {
    seen.push(new URL(url).pathname);
    return Response.json({ error: { message: 'bad request' } }, { status: 400 });
  };
  const { port, ledger } = portFor('http://127.0.0.1:11434/v1', { fetchImpl });
  const { modelReceipt } = await port.decide(request());
  assert.notEqual(modelReceipt.status, 'completed');
  assert.deepEqual(seen, ['/v1/chat/completions']);
  assert.deepEqual(observations(ledger).map(row => row.digest), [null]);
});

test('HTTPS, loopback HTTPS, a non-/v1 path and another protocol are not on the read path: not applicable, never read', async () => {
  for (const [endpoint, protocol] of [['https://models.example.test/v1', 'openai_chat'], ['https://127.0.0.1:11434/v1', 'openai_chat'],
    ['http://127.0.0.1:11434/openai', 'openai_chat'], ['http://127.0.0.1:11434/v1', 'anthropic_messages']]) {
    const urls = [];
    const fetchImpl = async url => { urls.push(new URL(url).pathname); return openAiStream(REPLY, { model: MODEL }); };
    const { port, localBuild } = portFor(endpoint, { fetchImpl, protocol });
    if (protocol === 'openai_chat') assert.equal((await port.decide(request())).modelReceipt.status, 'completed');
    assert.equal(urls.includes('/api/tags'), false, endpoint);
    assert.deepEqual(localBuild(), { status: 'not_applicable', digest: null, completedAt: null }, `${protocol} ${endpoint}`);
  }
});

test('before any answer on the configured connection there is no record', async t => {
  const ollama = await fakeOllama(t);
  assert.deepEqual(portFor(ollama.endpoint).localBuild(), { status: 'no_record', digest: null, completedAt: null });
});
