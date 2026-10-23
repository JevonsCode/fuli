import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { readModelBackendConfig } from '../src/model-backends/config.js';
import { handleModelBackendApiRequest } from '../src/model-backends/http.js';
import { createModelBackendPort } from '../src/model-backends/port.js';
import { createModelRoleSettings } from '../src/model-backends/role-settings.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';
import { listenFetchableServer } from '../src/server/listen.js';
import { createServer } from '../src/server.js';
import { reachableModules } from '../test-support/module-graph.js';

// rec#8: the console's model settings page. One role is saved through the
// loopback route; a refused save leaves the file byte for byte as it was,
// and no answer ever carries a key. Synthetic values only.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SYNTHETIC_KEY = 'sk-synthetic-NEVER-ECHO-0000';
const NOW = new Date('2026-10-23T12:00:00.000Z');

function edit(overrides = {}) {
  return {
    revision: null,
    connectionId: 'local-qwen',
    connection: { protocol: 'openai_chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen-test', secretRef: 'local-ref',
      reasoningEffort: 'none', pricing: null },
    settings: { enabled: true, allowedOperations: ['knowledge_review'], egress: { approvedProjects: [
      { personalSpaceId: 'space-1', personalProjectId: 'alpha' }], allowUnassigned: false },
    budget: { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 100_000,
      maxCostPerWindow: null }, fallbackToSession: true },
    ...overrides
  };
}

async function console_(t, { ledger = new ModelUsageLedger(':memory:') } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-model-settings-'));
  const path = join(directory, 'model-backends.json');
  const port = createModelBackendPort({ readConfig: () => readModelBackendConfig(path), secrets: { read: async () => null }, ledger,
    fetchImpl: async () => { throw new Error('no model call in this test'); }, now: () => NOW });
  const roleSettings = createModelRoleSettings(path);
  const server = createHttpServer(async (request, response) => {
    try {
      if (!await handleModelBackendApiRequest({ request, response, url: new URL(request.url, 'http://local'),
        modelBackends: port, roleSettings, operations: { tonborg: ['knowledge_review'] } })) response.writeHead(404).end();
    } catch (error) {
      const mapped = mapHttpError(error);
      response.writeHead(mapped.status, { 'content-type': 'application/json' }).end(JSON.stringify(mapped.body));
    }
  });
  await listenFetchableServer(server, 0);
  t.after(() => { server.close(); port.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (role, body) => fetch(`${base}/api/model-backends/roles/${role}`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const roles = async () => (await fetch(`${base}/api/model-backends/roles`)).json();
  const bytes = () => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  return { path, base, put, roles, bytes, ledger, roleSettings, port };
}

test('a saved role reads back as the settings page shows it, with key references only', async (t) => {
  const page = await console_(t);
  const saved = await page.put('tonborg', edit());
  assert.equal(saved.status, 200);
  const body = await saved.json();
  const tonborg = body.roles.find(role => role.role === 'tonborg');
  assert.equal(tonborg.state, 'enabled');
  assert.equal(tonborg.answeredBy, 'model_api');
  assert.equal(tonborg.connection.secretRef, 'local-ref');
  assert.deepEqual(tonborg.egress.approvedProjects, [{ personalSpaceId: 'space-1', personalProjectId: 'alpha' }]);
  assert.deepEqual(body.operations, { tonborg: ['knowledge_review'] });
  assert.match(body.revision, /^[0-9a-f]{64}$/);
  // What FULI wrote validates and reads back to itself, so a second edit starts from it.
  const loaded = readModelBackendConfig(page.path);
  assert.equal(loaded.state, 'ok');
  assert.deepEqual(JSON.parse(page.bytes()), JSON.parse(JSON.stringify(loaded.config)));

  const bole = await page.put('bole', edit({ revision: body.revision,
    settings: { ...edit().settings, enabled: false, budget: null, allowedOperations: [] } }));
  assert.equal(bole.status, 200);
  const both = await bole.json();
  assert.equal(both.roles.find(role => role.role === 'bole').state, 'disabled');
  assert.equal(both.roles.find(role => role.role === 'tonborg').state, 'enabled');
});

test('a refused save changes nothing and never echoes a key', async (t) => {
  const page = await console_(t);
  const first = await (await page.put('tonborg', edit())).json();
  const before = page.bytes();
  const refusals = [
    // A key in any field is not a supported field; the answer names the field, never the value.
    ['key in connection', edit({ revision: first.revision, connection: { ...edit().connection, apiKey: SYNTHETIC_KEY } }), 400],
    ['key at the top', { ...edit({ revision: first.revision }), secret: SYNTHETIC_KEY }, 400],
    ['key as the endpoint', edit({ revision: first.revision, connection: { ...edit().connection, endpoint: SYNTHETIC_KEY } }), 400],
    ['enabled without a budget', edit({ revision: first.revision, settings: { ...edit().settings, budget: null } }), 400],
    ['cost cap without prices', edit({ revision: first.revision,
      settings: { ...edit().settings, budget: { ...edit().settings.budget, maxCostPerWindow: 1 } } }), 400],
    ['unknown role', edit({ revision: first.revision }), 400, 'astro'],
    ['stale revision', edit({ revision: null }), 409]
  ];
  for (const [label, body, status, role = 'tonborg'] of refusals) {
    const response = await page.put(role, body);
    assert.equal(response.status, status, label);
    assert.doesNotMatch(await response.text(), /NEVER-ECHO/, label);
    assert.equal(page.bytes(), before, label);
  }
  assert.doesNotMatch(JSON.stringify(await page.roles()), /NEVER-ECHO/);
});

test('a file that does not validate is left as it is for repair', async (t) => {
  const page = await console_(t);
  writeFileSync(page.path, '{"version":1,"roles":{"nobody":{}}}');
  const before = page.bytes();
  const listed = await page.roles();
  assert.equal(listed.state, 'invalid');
  const response = await page.put('bole', edit({ revision: listed.revision }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'model_config_invalid');
  assert.equal(page.bytes(), before);
});

// Through the real console stack (createServer: header policy, then the
// route). The local process boundary is a loopback request with this
// console's Host and no cross-site markers. It does not show that a person
// sent the request, and it is not the human-review channel: anything that can
// reach loopback HTTP on this computer can call the route.
test('the real console refuses a save from outside the local process boundary and keeps the file', async (t) => {
  const page = await console_(t);
  const runtime = await createServer({ port: 0, dataFormatNotices: () => [], modelRoleSettings: page.roleSettings,
    app: { graphiti: true, modelBackends: page.port, async state() { throw new Error('not queried'); }, close() {} } });
  t.after(() => new Promise(done => runtime.server.close(done)));
  const { port } = runtime.server.address();
  const body = JSON.stringify(edit());
  const put = ({ headers = {}, localAddress } = {}) => new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'PUT', path: '/api/model-backends/roles/bole', localAddress,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } },
    (response) => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end(body);
  });

  for (const [label, options] of [
    ['a foreign Host', { headers: { host: 'evil.example' } }],
    ['a cross-site Origin', { headers: { origin: 'http://evil.example' } }],
    ['sec-fetch-site cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }]
  ]) {
    const response = await put(options);
    assert.equal(response.status, 403, label);
    assert.equal(page.bytes(), null, label);
  }
  // A peer that is not this computer's loopback address (127.0.0.2 stands in
  // for one, so no LAN listener is opened).
  let remote = null;
  try {
    remote = await put({ localAddress: '127.0.0.2' });
  } catch (error) {
    if (!['EADDRNOTAVAIL', 'EINVAL'].includes(error.code)) throw error;
    t.diagnostic('127.0.0.2 is not available here; the non-loopback case was not run');
  }
  if (remote) {
    assert.equal(remote.status, 403);
    assert.equal(JSON.parse(remote.text).code, 'local_user_only');
    assert.equal(page.bytes(), null);
  }
  // The same stack accepts a loopback request with this console's Host.
  assert.equal((await put()).status, 200);
  assert.notEqual(page.bytes(), null);
});

test('no MCP or Agent tool entry reaches the save, and the catalog marks it local_user_only', () => {
  const entry = agentInterfaceCatalog().uiMutationParity.find(item => item.route === 'PUT /api/model-backends/roles/:role');
  assert.equal(entry?.access, 'local_user_only');
  const save = join(ROOT, 'src/model-backends/role-settings.js');
  for (const start of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    assert.equal(reachableModules(join(ROOT, start)).has(save), false, start);
  }
});

test('usage keeps unknown values unknown with their count and session fallbacks apart', async (t) => {
  const ledger = new ModelUsageLedger(':memory:');
  const attempt = (id, overrides) => ({ requestId: `req-${id}`, attemptId: `a-${id}`, attemptNumber: 1, purpose: 'initial',
    channel: 'model_api', role: 'tonborg', operation: 'knowledge_review', personalSpaceId: 'space-1', personalProjectId: 'alpha',
    connectionId: 'local-qwen', protocol: 'openai_chat', endpointHost: '127.0.0.1:11434', requestedModel: 'qwen-test',
    actualModel: 'qwen-test', outputMode: 'json_schema', startedAt: '2026-10-23T10:00:00.000Z', durationMs: 100, outcome: 'succeeded',
    failureClass: null, failureReason: null, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: null,
      cacheWriteInputTokens: null, reasoningTokens: null, definition: 'openai_chat' },
    budgetCeilingTokens: 1000, estimatedCost: null, costCurrency: null, ...overrides });
  const unknown = { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null,
    reasoningTokens: null, definition: null };
  ledger.record(attempt(1, {}));
  ledger.record(attempt(2, { usage: unknown, outcome: 'failed', failureClass: 'transient', failureReason: 'timeout' }));
  ledger.record(attempt(3, { channel: 'session', connectionId: null, protocol: null, endpointHost: null, requestedModel: null,
    actualModel: null, outputMode: null, usage: unknown, budgetCeilingTokens: 0 }));
  const page = await console_(t, { ledger });
  const usage = await (await fetch(`${page.base}/api/model-backends/usage?from=2026-10-23T00:00:00.000Z`)).json();
  const model = usage.groups.find(group => group.channel === 'model_api');
  const session = usage.groups.find(group => group.channel === 'session');
  assert.equal(model.requests, 2);
  assert.deepEqual(model.tokens.input, { reported: 100, unknownAttempts: 1 });
  assert.equal(model.estimatedCost, null);
  assert.equal(session.requests, 1);
  assert.deepEqual(session.tokens.total, { reported: null, unknownAttempts: 1 });
  assert.equal(session.model, null);
});
