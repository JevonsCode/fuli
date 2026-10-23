import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { readModelBackendConfig } from '../src/model-backends/config.js';
import { createModelBackendPort } from '../src/model-backends/port.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';
import { openAiStream } from './fixtures/model-transport.js';

// A configured endpoint that answers 307 or 308 must not get the request body
// resent to the redirect target, which no egress or endpoint check has seen.
// Local fake servers on free ports stand in for the model; no real model runs.

const KEYS = { synthetic: 'synthetic-test-key' };
const PROTOCOLS = { openai_chat: 'm-openai', anthropic_messages: 'm-anthropic', typesafe_systemone: 'jev-test' };

async function listen(t, handler) {
  const server = await new Promise(resolve => {
    const created = createServer(handler).listen(0, '127.0.0.1', () => resolve(created));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

function portFor(endpoint, protocol, fetchImpl = globalThis.fetch) {
  const config = {
    version: 1,
    connections: { target: { protocol, endpoint: `${endpoint}/v1`, model: PROTOCOLS[protocol],
      secretRef: protocol === 'openai_chat' ? null : 'synthetic' } },
    roles: { bole: { enabled: true, connection: 'target', allowedOperations: ['pick'],
      egress: { approvedProjects: [{ personalSpaceId: 'space', personalProjectId: 'alpha' }], allowUnassigned: false },
      budget: { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 100_000 },
      fallbackToSession: true } }
  };
  return createModelBackendPort({
    readConfig: () => readModelBackendConfig('model-backends.json', { read: () => config }),
    secrets: { read: async ref => KEYS[ref] ?? null },
    ledger: new ModelUsageLedger(':memory:'),
    fetchImpl, wait: async () => {}, now: () => new Date('2026-10-23T12:00:00.000Z')
  });
}

const request = () => ({
  role: 'bole', operation: 'pick', requestId: 'req-1', sourceEventId: 'event-1',
  scope: { personalSpaceId: 'space', personalProjectId: 'alpha', sessionRef: 'codex:thread-1' },
  versions: { evidence: 'ev-1', policy: 'pol-1' },
  instructions: 'Which synthetic Agent should take the next review?',
  evidence: [{ id: 'e1', personalProjectId: 'alpha', text: 'Synthetic project content that must stay on the endpoint.' }],
  output: { type: 'choice', options: [{ id: 'ada', description: 'Ada, reviewer' }, { id: 'bo', description: 'Bo, writer' }] }
});

function assertRedirectRefused(result) {
  assert.equal(result.envelope, null);
  assert.equal(result.modelReceipt.status, 'stopped');
  assert.equal(result.modelReceipt.failureClass, 'refusal');
  assert.equal(result.modelReceipt.reason, 'endpoint_redirected');
  assert.equal(result.modelReceipt.fallbackEligible, false);
  assert.equal(result.modelReceipt.attempts, 1);
}

for (const status of [307, 308]) {
  for (const protocol of Object.keys(PROTOCOLS)) {
    test(`a ${status} from the ${protocol} endpoint is refused, not retried, not handed to the session, and never followed`, async t => {
      const reached = [];
      const elsewhere = await listen(t, (incoming, response) => { reached.push(incoming.url); response.end('{}'); });
      const hits = [];
      const endpoint = await listen(t, (incoming, response) => {
        hits.push(incoming.url);
        response.writeHead(status, { location: `${elsewhere}${incoming.url}` }).end();
      });

      assertRedirectRefused(await portFor(endpoint, protocol).decide(request()));
      assert.equal(hits.length, 1);
      assert.deepEqual(reached, []);
    });
  }
}

test('a response that reports it was redirected is refused even when the fetch ignored redirect: error', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(init.redirect);
    return Object.defineProperty(openAiStream('{}'), 'redirected', { value: true });
  };
  assertRedirectRefused(await portFor('http://127.0.0.1:9', 'openai_chat', fetchImpl).decide(request()));
  assert.deepEqual(sent, ['error']);
});

test('a normal answer from a local endpoint still completes', async t => {
  const reply = JSON.stringify({ decision: 'propose', payload: { choice: 'ada' }, reason: 'Synthetic evidence.',
    evidenceIds: ['e1'], uncertainty: null });
  const stream = await openAiStream(reply).text();
  const endpoint = await listen(t, (incoming, response) => {
    incoming.resume();
    incoming.on('end', () => response.writeHead(200, { 'content-type': 'text/event-stream' }).end(stream));
  });
  const result = await portFor(endpoint, 'openai_chat').decide(request());
  assert.equal(result.modelReceipt.status, 'completed');
  assert.deepEqual(result.envelope.payload, { choice: 'ada' });
});
