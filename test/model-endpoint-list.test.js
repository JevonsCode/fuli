import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { handleModelListRequest } from '../src/model-backends/models-http.js';
import { createModelSecretStore } from '../src/model-backends/secret-store.js';
import { createServer } from '../src/server.js';
import { reachableModules } from '../test-support/module-graph.js';

// The settings dialog asks the typed endpoint which models it has. Fake model
// servers on free ports and synthetic keys only; no real FULI or model.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SYNTHETIC_KEY = 'sk-synthetic-NEVER-ECHO-5151';
const PROTECTOR = Object.freeze({ scheme: 'synthetic-v1', protect: async (bytes) => bytes.toString('base64'),
  unprotect: async (data) => Buffer.from(data, 'base64') });

// A fake model server: routes maps a path to (request) => { status, body, headers }.
async function fakeModelServer(t, routes) {
  const seen = [];
  const server = createHttpServer((request, response) => {
    seen.push({ path: request.url, headers: request.headers });
    const answer = routes[request.url]?.(request);
    if (answer === 'hang') return;
    const { status = 404, body = { error: 'not found' }, headers = {} } = answer ?? {};
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

async function withConsole(t, run) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-model-list-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const secrets = createModelSecretStore({ path: join(directory, 'model-secrets.json'), platform: 'win32', protector: PROTECTOR });
  const runtime = await createServer({ port: 0, dataFormatNotices: () => [], dataFormatMigrations: null,
    modelSecrets: secrets, app: { close() {} } });
  try { return await run({ url: runtime.url, secrets }); }
  finally { await new Promise((done) => runtime.server.close(done)); }
}

const list = (url, body) => fetch(`${url}/api/model-backends/models`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('an Ollama endpoint lists its models from /v1/models', async (t) => {
  const model = await fakeModelServer(t, { '/v1/models': () => ({ status: 200,
    body: { object: 'list', data: [{ id: 'synthetic-chat:4b' }, { id: 'synthetic-embed:0.6b' }, { id: 'synthetic-chat:4b' }] } }) });
  await withConsole(t, async ({ url }) => {
    const answer = await list(url, { protocol: 'openai_embeddings', endpoint: `${model.base}/v1/` });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await answer.json(), { models: [{ id: 'synthetic-chat:4b' }, { id: 'synthetic-embed:0.6b' }], source: 'models' });
  });
  assert.equal(model.seen[0].headers.authorization, undefined);
});

test('a loopback Ollama without /v1/models lists its tags', async (t) => {
  const model = await fakeModelServer(t, { '/api/tags': () => ({ status: 200,
    body: { models: [{ name: 'synthetic-embed:0.6b', digest: 'a'.repeat(64) }, { name: '' }, { name: 'synthetic-chat:4b' }] } }) });
  await withConsole(t, async ({ url }) => {
    const answer = await list(url, { protocol: 'openai_chat', endpoint: `${model.base}/v1` });
    assert.deepEqual(await answer.json(), { models: [{ id: 'synthetic-chat:4b' }, { id: 'synthetic-embed:0.6b' }], source: 'ollama_tags' });
  });
  assert.deepEqual(model.seen.map(({ path }) => path), ['/v1/models', '/api/tags']);
});

test('an OpenAI-compatible endpoint gets the saved key, which no answer or log carries', async (t) => {
  const logged = [];
  for (const method of ['log', 'info', 'warn', 'error']) t.mock.method(console, method, (...args) => logged.push(args.join(' ')));
  const model = await fakeModelServer(t, {
    '/compatible-mode/v1/models': (request) => (request.headers.authorization === `Bearer ${SYNTHETIC_KEY}`
      ? { status: 200, body: { data: [{ id: 'synthetic-plus' }, { id: 'synthetic-embedding-v4' }] } }
      : { status: 401, body: { error: { message: 'Incorrect API key' } } }),
  });
  await withConsole(t, async ({ url, secrets }) => {
    const missing = await list(url, { protocol: 'openai_chat', endpoint: `${model.base}/compatible-mode/v1`, secretRef: 'synthetic' });
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).code, 'missing_key');
    await secrets.set('synthetic', SYNTHETIC_KEY, model.base);
    const answer = await list(url, { protocol: 'openai_chat', endpoint: `${model.base}/compatible-mode/v1`, secretRef: 'synthetic' });
    const text = await answer.text();
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(text).models.map(({ id }) => id), ['synthetic-embedding-v4', 'synthetic-plus']);
    assert.doesNotMatch(text, /NEVER-ECHO/);
    const refused = await list(url, { protocol: 'openai_chat', endpoint: `${model.base}/compatible-mode/v1` });
    assert.equal(refused.status, 502);
    assert.deepEqual(await refused.json(), { error: 'The endpoint\'s models could not be listed (auth_failed)', code: 'auth_failed' });
    // The same key for another origin (rec#10 on fuli#784) is refused before any request leaves.
    const seen = model.seen.length;
    const elsewhere = await list(url, { protocol: 'openai_chat',
      endpoint: `${model.base.replace('127.0.0.1', 'localhost')}/compatible-mode/v1`, secretRef: 'synthetic' });
    assert.equal(elsewhere.status, 409);
    assert.equal((await elsewhere.json()).code, 'secret_endpoint_mismatch');
    assert.equal(model.seen.length, seen);
  });
  assert.equal(logged.filter((line) => line.includes('NEVER-ECHO')).length, 0);
});

test('Anthropic lists its models with the key in x-api-key and refuses to ask without one', async (t) => {
  const model = await fakeModelServer(t, { '/v1/models': () => ({ status: 200, body: { data: [{ id: 'synthetic-claude', type: 'model' }] } }) });
  await withConsole(t, async ({ url, secrets }) => {
    const keyless = await list(url, { protocol: 'anthropic_messages', endpoint: `${model.base}/v1` });
    assert.equal(keyless.status, 409);
    assert.equal((await keyless.json()).code, 'missing_key');
    await secrets.set('anthropic', SYNTHETIC_KEY, model.base);
    const answer = await list(url, { protocol: 'anthropic_messages', endpoint: `${model.base}/v1`, secretRef: 'anthropic' });
    assert.deepEqual(await answer.json(), { models: [{ id: 'synthetic-claude' }], source: 'models' });
    const unsupported = await list(url, { protocol: 'typesafe_systemone', endpoint: `${model.base}/v1`, secretRef: 'anthropic' });
    assert.equal((await unsupported.json()).code, 'listing_unsupported');
  });
  assert.equal(model.seen.length, 1);
  assert.equal(model.seen[0].headers['x-api-key'], SYNTHETIC_KEY);
  assert.equal(model.seen[0].headers['anthropic-version'], '2023-06-01');
});

test('an endpoint FULI would not save is refused before any request', async (t) => {
  await withConsole(t, async ({ url }) => {
    for (const body of [{ protocol: 'openai_chat', endpoint: 'ftp://127.0.0.1/v1' },
      { protocol: 'openai_chat', endpoint: 'http://user:pass@127.0.0.1/v1' }, { protocol: 'openai_chat', endpoint: 'http://127.0.0.1/v1?x=1' },
      { protocol: 'other', endpoint: 'http://127.0.0.1/v1' }, { protocol: 'openai_chat', endpoint: 'http://127.0.0.1/v1', secretRef: 'bad ref' },
      { protocol: 'openai_chat', endpoint: 'http://127.0.0.1/v1', extra: 1 }]) {
      assert.equal((await list(url, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await fetch(`${url}/api/model-backends/models`)).status, 405);
  });
});

// The handler alone, on its own server, with a short timeout.
async function listingServer(t, timeoutMs) {
  const server = createHttpServer((request, response) => {
    handleModelListRequest({ request, response, url: new URL(request.url, 'http://127.0.0.1'), secrets: null, timeoutMs });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('a slow endpoint times out and a redirect is refused, not followed', async (t) => {
  const elsewhere = await fakeModelServer(t, { '/v1/models': () => ({ status: 200, body: { data: [{ id: 'synthetic-elsewhere' }] } }) });
  const model = await fakeModelServer(t, {
    '/slow/v1/models': () => 'hang',
    '/moved/v1/models': () => ({ status: 307, headers: { location: `${elsewhere.base}/v1/models` }, body: {} }),
  });
  const url = await listingServer(t, 300);
  const slow = await list(url, { protocol: 'openai_chat', endpoint: `${model.base}/slow/v1` });
  assert.deepEqual([slow.status, (await slow.json()).code], [502, 'timeout']);
  const moved = await list(url, { protocol: 'openai_chat', endpoint: `${model.base}/moved/v1` });
  assert.deepEqual([moved.status, (await moved.json()).code], [502, 'endpoint_redirected']);
  assert.equal(elsewhere.seen.length, 0);
});

test('only this computer lists an endpoint, and no Agent or MCP entry reaches the route', async () => {
  const sent = [];
  const response = { setHeader() {}, writeHead(status) { sent.push(status); return this; }, end() {} };
  await handleModelListRequest({ request: { method: 'POST', socket: { remoteAddress: '192.168.1.20' }, headers: {} }, response,
    url: new URL('http://lan/api/model-backends/models'), secrets: { read: () => assert.fail('not read') } });
  assert.deepEqual(sent, [403]);
  const entry = agentInterfaceCatalog().uiMutationParity.find((item) => item.route === 'POST /api/model-backends/models');
  assert.equal(entry?.access, 'local_user_only');
  const route = join(ROOT, 'src/model-backends/models-http.js');
  for (const start of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    assert.equal(reachableModules(join(ROOT, start)).has(route), false, start);
  }
});
