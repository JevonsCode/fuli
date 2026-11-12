import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { readModelBackendConfig } from '../src/model-backends/config.js';
import { handleModelBackendApiRequest } from '../src/model-backends/http.js';
import { createModelBackendPort } from '../src/model-backends/port.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';
import { listenFetchableServer } from '../src/server/listen.js';
import { openAiStream } from './fixtures/model-transport.js';

// rec#122: roles that name the same whole connection configuration (id,
// protocol, endpoint, model, key reference) share whether it answers. A newer
// answer by any of them supersedes an older network failure; a role's own
// failure for any other reason stays the role's. Every call goes to a fake
// transport; the endpoints are synthetic and nothing listens there.

const ENDPOINT = 'http://127.0.0.1:1/v1';
const READY = JSON.stringify({ decision: 'propose', payload: { choice: 'ready' }, reason: 'Ready.', evidenceIds: [], uncertainty: null });

const connection = (overrides = {}) => ({ protocol: 'openai_chat', endpoint: ENDPOINT, model: 'synthetic-model', secretRef: 'synthetic-ref',
  ...overrides });
const role = name => ({ enabled: true, connection: name, allowedOperations: ['pick'],
  egress: { approvedProjects: [], allowUnassigned: false },
  budget: { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 100_000 },
  fallbackToSession: true });

// transport: what the fake endpoint does next, per role ('up', 'down' or 'forbidden').
function harness({ connections = { shared: connection() }, roles = { assistant: 'shared', jefa: 'shared', tonborg: 'shared' } } = {}) {
  const config = { version: 1, connections, roles: Object.fromEntries(Object.entries(roles).map(([name, use]) => [name, role(use)])) };
  const transport = {};
  let current = null;
  let at = Date.parse('2026-11-12T08:00:00.000Z');
  const fetchImpl = async () => {
    const mode = transport[current] ?? 'up';
    if (mode === 'down') throw new TypeError('fetch failed');
    if (mode === 'forbidden') return Response.json({ error: { message: 'not allowed for this project' } }, { status: 403 });
    return openAiStream(READY, { model: 'synthetic-model' });
  };
  const ledger = new ModelUsageLedger(':memory:');
  const port = createModelBackendPort({ readConfig: () => readModelBackendConfig('model-backends.json', { read: () => config }),
    secrets: { read: async () => 'synthetic-key' }, ledger, fetchImpl, wait: async () => {}, now: () => new Date(at) });
  // One check by a role, a minute after the previous one.
  const check = async (name, mode = 'up') => {
    at += 60_000;
    transport[name] = mode;
    current = name;
    return port.checkConnection(name);
  };
  const health = name => port.health(name, config.roles[name].connection, config.connections[config.roles[name].connection]);
  return { port, config, check, health, ledger };
}

test('a newer answer by another role on the same configuration supersedes an older network failure', async () => {
  const { port, check, health } = harness();
  await check('tonborg', 'down');
  assert.deepEqual([health('tonborg').status, health('tonborg').scope, health('tonborg').reason], ['failing', 'connection', 'network']);
  // A role that never called shares what the connection did.
  assert.equal(health('jefa').status, 'failing');

  const answered = await check('assistant');
  assert.equal(answered.modelReceipt.status, 'completed');
  for (const name of ['assistant', 'jefa', 'tonborg']) {
    assert.deepEqual(health(name), { status: 'ok', at: health('assistant').at, reason: null, scope: 'connection' }, name);
  }
  // Tonborg's failure stays in its own history.
  const tonborg = port.usage({ role: 'tonborg' }).groups[0];
  assert.deepEqual([tonborg.requests, tonborg.failedRequests], [1, 1]);
});

test('a newer network failure by one role reaches every role on the same configuration', async () => {
  const { check, health } = harness();
  await check('assistant');
  await check('jefa', 'down');
  assert.deepEqual([health('assistant').status, health('assistant').scope, health('assistant').reason], ['failing', 'connection', 'network']);
  await check('tonborg');
  assert.equal(health('jefa').status, 'ok');
});

test('a role\'s own failure for another reason is not cleared by another role\'s answer', async () => {
  const { check, health } = harness();
  await check('tonborg', 'forbidden');
  await check('assistant');
  const tonborg = health('tonborg');
  assert.deepEqual([tonborg.status, tonborg.scope, tonborg.reason], ['failing', 'role', 'permission_denied']);
  assert.equal(health('assistant').status, 'ok');
  // Nor does it mark the connection as failing for the others.
  assert.deepEqual([health('jefa').status, health('jefa').scope], ['ok', 'connection']);
  // Only the role's own answer clears it.
  await check('tonborg');
  assert.deepEqual([health('tonborg').status, health('tonborg').scope], ['ok', 'connection']);
});

test('another endpoint, model, protocol or key reference shares nothing', async () => {
  const others = { endpoint: connection({ endpoint: 'http://127.0.0.1:2/v1' }), model: connection({ model: 'synthetic-other' }),
    protocol: connection({ protocol: 'anthropic_messages' }), key: connection({ secretRef: 'synthetic-other-ref' }) };
  for (const [name, other] of Object.entries(others)) {
    const { check, health } = harness({ connections: { shared: connection(), other }, roles: { assistant: 'shared', tonborg: 'other' } });
    await check('tonborg', 'down');
    await check('assistant');
    assert.deepEqual([health('tonborg').status, health('tonborg').reason], ['failing', 'network'], name);
    assert.equal(health('assistant').status, 'ok', name);
  }
});

test('after the configuration changes in place, its earlier answers no longer count', async () => {
  for (const change of [{ endpoint: 'http://127.0.0.1:3/v1' }, { model: 'synthetic-next' }, { secretRef: 'synthetic-next-ref' }]) {
    const { config, check, health } = harness();
    await check('assistant');
    assert.equal(health('tonborg').status, 'ok');
    config.connections.shared = connection(change);
    assert.deepEqual(health('tonborg'), { status: 'unknown', at: null, reason: null, scope: null }, JSON.stringify(change));
  }
});

test('the roles read shows each role the shared connection health', async t => {
  const { port, check } = harness();
  await check('tonborg', 'down');
  await check('jefa', 'forbidden');
  await check('assistant');
  const server = createServer(async (request, response) => {
    if (!await handleModelBackendApiRequest({ request, response, url: new URL(request.url, 'http://local'), modelBackends: port })) {
      response.writeHead(404).end();
    }
  });
  await listenFetchableServer(server, 0);
  t.after(() => server.close());
  const read = await (await fetch(`http://127.0.0.1:${server.address().port}/api/model-backends/roles`)).json();
  const shown = Object.fromEntries(read.roles.filter(view => view.health).map(view => [view.role, [view.health.status, view.health.scope]]));
  assert.deepEqual(shown, { assistant: ['ok', 'connection'], jefa: ['failing', 'role'], tonborg: ['ok', 'connection'] });
});
