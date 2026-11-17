import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { connectionHealthIdentity, connectionIdentity, readModelBackendConfig } from '../src/model-backends/config.js';
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
const BUDGET = { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 100_000 };
const role = (name, budget = BUDGET) => ({ enabled: true, connection: name, allowedOperations: ['pick'],
  egress: { approvedProjects: [], allowUnassigned: false }, budget, fallbackToSession: true });

// transport: what the fake endpoint does next, per role ('up', 'down' or 'forbidden').
// budget: every role's own limits, when not the usual ones.
function harness({ connections = { shared: connection() }, roles = { assistant: 'shared', jefa: 'shared', tonborg: 'shared' },
  budget = BUDGET } = {}) {
  const config = { version: 1, connections,
    roles: Object.fromEntries(Object.entries(roles).map(([name, use]) => [name, role(use, budget)])) };
  const transport = {};
  let current = null;
  let at = Date.parse('2026-11-12T08:00:00.000Z');
  const fetchImpl = async () => {
    const mode = transport[current] ?? 'up';
    if (mode === 'down') throw new TypeError('fetch failed');
    if (mode === 'slow') throw new DOMException('The operation timed out.', 'TimeoutError');
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
  // One decision by a role, a minute after the previous one; budget is what
  // its caller asks for ({ timeoutMs, hotPath } on a hot path).
  const decide = async (name, mode, budget = null) => {
    at += 60_000;
    transport[name] = mode;
    current = name;
    return port.decide({ role: name, operation: 'pick', requestId: `pick:${at}`,
      scope: { personalSpaceId: 'synthetic-space', personalProjectId: null, sessionRef: null },
      versions: { evidence: 'none', policy: 'none' }, instructions: 'Choose the option ready.',
      output: { type: 'choice', options: [{ id: 'ready', description: 'Ready.' }, { id: 'none', description: 'Not ready.' }] },
      decisions: ['propose'], ...(budget ? { budget } : {}) });
  };
  const health = name => port.health(name, config.roles[name].connection, config.connections[config.roles[name].connection]);
  return { port, config, check, decide, health, ledger };
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

// rec#139: a hot path asks for a few seconds where the role allows far more,
// and says it is one (budget.hotPath).
const HOT_PATH = { timeoutMs: 3000, hotPath: true };
// A role that sets no time limit of its own has the port's default end.
const NO_TIME_LIMIT = { ...BUDGET, timeoutMs: null };

test('a timeout under a time limit a hot-path caller tightened is not the role\'s failure', async () => {
  const { check, decide, health } = harness();
  await check('jefa');
  const skipped = await decide('jefa', 'slow', HOT_PATH);
  assert.deepEqual([skipped.modelReceipt.status, skipped.modelReceipt.reason], ['failed', 'timeout']);
  // The caller would not wait; the role's answer before it still stands.
  assert.deepEqual([health('jefa').status, health('jefa').scope], ['ok', 'connection']);
});

test('a hot-path timeout is not the role\'s failure when the role sets no time limit of its own', async () => {
  const { check, decide, health } = harness({ budget: NO_TIME_LIMIT });
  await check('jefa');
  await decide('jefa', 'slow', HOT_PATH);
  assert.deepEqual([health('jefa').status, health('jefa').scope], ['ok', 'connection']);
});

// Retrieval terms and retrospectives ask for less than the role allows too,
// but nobody waits on them: their timeouts stay the role's (rv on rec#139).
test('a timeout under a tighter limit that is not a hot path is still the role\'s failure', async () => {
  const { check, decide, health } = harness({ budget: NO_TIME_LIMIT });
  await check('jefa');
  await decide('jefa', 'slow', { timeoutMs: 300_000 });
  assert.deepEqual([health('jefa').status, health('jefa').scope, health('jefa').reason], ['failing', 'role', 'timeout']);
});

test('a timeout within the role\'s own time limit is still the role\'s failure', async () => {
  const { check, decide, health } = harness();
  await check('jefa');
  await decide('jefa', 'slow');
  assert.deepEqual([health('jefa').status, health('jefa').scope, health('jefa').reason], ['failing', 'role', 'timeout']);
  // A limit no tighter than the role's is the role's own, hot path or not.
  await check('jefa');
  await decide('jefa', 'slow', { timeoutMs: 30_000, hotPath: true });
  assert.deepEqual([health('jefa').status, health('jefa').scope], ['failing', 'role']);
});

test('an older attempt that does not say whether its caller tightened the limit still counts', async () => {
  const { check, decide, health, ledger } = harness();
  await check('jefa');
  // Stored as before model-usage format 4: the migration leaves caller_deadline NULL.
  const record = ledger.record.bind(ledger);
  ledger.record = attempt => record({ ...attempt, callerDeadline: undefined });
  await decide('jefa', 'slow', HOT_PATH);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM model_attempts WHERE caller_deadline IS NOT NULL').get().n, 0);
  assert.deepEqual([health('jefa').status, health('jefa').scope, health('jefa').reason], ['failing', 'role', 'timeout']);
});

test('another failure under a tightened time limit stays the role\'s, and a caller timeout does not clear it', async () => {
  const { decide, health } = harness();
  await decide('jefa', 'forbidden', HOT_PATH);
  assert.deepEqual([health('jefa').status, health('jefa').scope, health('jefa').reason], ['failing', 'role', 'permission_denied']);
  await decide('jefa', 'slow', HOT_PATH);
  assert.deepEqual([health('jefa').status, health('jefa').reason], ['failing', 'permission_denied']);
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

// The trust gate (rec#10 D-36) compares connectionIdentity with the identity a
// saved answer carries. It is the value 0.27.0 computed for the same
// configuration, so an upgrade does not refuse saved answers as
// connection_changed; only health also tells key references apart.
test('the trust gate\'s connection identity is unchanged; only health tells key references apart', () => {
  const saved = connection();
  assert.equal(connectionIdentity('shared', saved), '4b03655a06b05aaf2ba1ed2c9f0d16ebdad7ce1271e82623a1883b56f85ac7f2');
  const rekeyed = connection({ secretRef: 'synthetic-next-ref' });
  assert.equal(connectionIdentity('shared', rekeyed), connectionIdentity('shared', saved));
  assert.notEqual(connectionHealthIdentity('shared', rekeyed), connectionHealthIdentity('shared', saved));
  assert.notEqual(connectionHealthIdentity('shared', saved), connectionIdentity('shared', saved));
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
