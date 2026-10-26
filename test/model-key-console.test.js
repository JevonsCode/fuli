import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { handleModelKeyRequest } from '../src/model-backends/keys-http.js';
import { createModelSecretStore } from '../src/model-backends/secret-store.js';
import { createServer } from '../src/server.js';
import { reachableModules } from '../test-support/module-graph.js';

// The model settings page saves a model API key where `fuli models set-key`
// does, on loopback only; no answer, log or URL ever carries the key.
// Synthetic keys and a temporary directory only.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SYNTHETIC_KEY = 'sk-synthetic-NEVER-ECHO-4242';
// A reversible stand-in for DPAPI, so the test runs the same on every system.
const PROTECTOR = Object.freeze({ scheme: 'synthetic-v1', protect: async (bytes) => bytes.toString('base64'),
  unprotect: async (data) => Buffer.from(data, 'base64') });

async function withConsole(t, run) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-model-keys-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'model-secrets.json');
  const secrets = createModelSecretStore({ path, platform: 'win32', protector: PROTECTOR });
  const runtime = await createServer({ port: 0, dataFormatNotices: () => [], dataFormatMigrations: null,
    modelSecrets: secrets, app: { close() {} } });
  try { return await run({ url: runtime.url, secrets, path }); }
  finally { await new Promise((done) => runtime.server.close(done)); }
}

const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body) });

test('the page saves and replaces a key, and learns only that it is saved', async (t) => {
  const logged = [];
  for (const method of ['log', 'info', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => logged.push(args.join(' ')));
  }
  await withConsole(t, async ({ url, secrets, path }) => {
    assert.deepEqual(await (await fetch(`${url}/api/model-backends/keys`)).json(), { saved: [] });
    const saved = await put(`${url}/api/model-backends/keys/deepseek`, { key: SYNTHETIC_KEY });
    const answer = await saved.text();
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(answer), { reference: 'deepseek', saved: true });
    assert.equal(await secrets.read('deepseek'), SYNTHETIC_KEY);
    const listed = await (await fetch(`${url}/api/model-backends/keys`)).text();
    assert.deepEqual(JSON.parse(listed), { saved: ['deepseek'] });
    assert.doesNotMatch(listed, /NEVER-ECHO/);
    // Stored protected, not as typed.
    assert.doesNotMatch(readFileSync(path, 'utf8'), /NEVER-ECHO/);

    assert.equal((await put(`${url}/api/model-backends/keys/deepseek`, { key: `${SYNTHETIC_KEY}-2` })).status, 200);
    assert.equal(await secrets.read('deepseek'), `${SYNTHETIC_KEY}-2`);

    const spaced = await put(`${url}/api/model-backends/keys/deepseek`, { key: 'sk synthetic NEVER-ECHO' });
    assert.equal(spaced.status, 400);
    assert.doesNotMatch(await spaced.text(), /NEVER-ECHO/);
    assert.equal((await put(`${url}/api/model-backends/keys/bad%20ref`, { key: SYNTHETIC_KEY })).status, 400);
    assert.equal((await put(`${url}/api/model-backends/keys/deepseek`, { key: SYNTHETIC_KEY, extra: 1 })).status, 400);
    assert.equal((await fetch(`${url}/api/model-backends/keys/deepseek`)).status, 405);
    assert.equal(await secrets.read('deepseek'), `${SYNTHETIC_KEY}-2`);
  });
  assert.equal(logged.filter((line) => line.includes('NEVER-ECHO')).length, 0);
});

test('keys are saved and listed only from this computer', async () => {
  const sent = [];
  const response = { setHeader() {}, writeHead(status) { sent.push(status); return this; }, end() {} };
  const secrets = { references: () => assert.fail('not read'), set: async () => assert.fail('not saved') };
  for (const [method, path] of [['GET', '/api/model-backends/keys'], ['PUT', '/api/model-backends/keys/deepseek']]) {
    await handleModelKeyRequest({ request: { method, socket: { remoteAddress: '192.168.1.20' }, headers: {} }, response,
      url: new URL(`http://lan${path}`), secrets });
  }
  assert.deepEqual(sent, [403, 403]);
});

test('the key route is a local user decision no Agent or MCP entry reaches', () => {
  const entry = agentInterfaceCatalog().uiMutationParity.find((item) => item.route === 'PUT /api/model-backends/keys/:reference');
  assert.equal(entry?.access, 'local_user_only');
  const route = join(ROOT, 'src/model-backends/keys-http.js');
  for (const start of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    assert.equal(reachableModules(join(ROOT, start)).has(route), false, start);
  }
});
