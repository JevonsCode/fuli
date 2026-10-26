import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DataFormatError } from '../packages/roundtable/src/storage/data-format-error.js';
import { listAgentTools } from '../src/agent-tools.js';
import { handleDataFormatApiRequest } from '../src/http/data-format-api-router.js';
import { createServer } from '../src/server.js';
import { reachableModules } from '../test-support/module-graph.js';

// rec#17 D-09 part 2: the console confirms and undoes migrations on loopback
// only, and no MCP or Agent tool path reaches the operations that change data.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLAN = { digest: 'a'.repeat(64), stores: [], blocked: [], undoable: [] };

function migrations(calls, { applyError = null } = {}) {
  return {
    preview: async () => PLAN,
    apply: async (input) => { calls.push(['apply', input]); if (applyError) throw applyError; return { status: 'applied', results: [], skipped: [] }; },
    rollback: async (input) => { calls.push(['rollback', input]); return { status: 'rolled_back', version: 2 }; },
    prune: () => []
  };
}

async function withServer(port, run) {
  const runtime = await createServer({ port: 0, dataFormatNotices: () => [], dataFormatMigrations: port,
    app: { graphiti: true, async state() { throw new Error('not queried'); }, close() {} } });
  try { return await run(runtime.url); } finally { await new Promise((done) => runtime.server.close(done)); }
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body) });

test('the console previews, applies with the digest and undoes, as entrypoint http', async () => {
  const calls = [];
  await withServer(migrations(calls), async (url) => {
    assert.deepEqual(await (await fetch(`${url}/api/data-format`)).json(), PLAN);
    assert.equal((await post(`${url}/api/data-format/apply`, { digest: PLAN.digest })).status, 200);
    assert.equal((await post(`${url}/api/data-format/rollback`, { label: 'agent-apps/registry.sqlite',
      migrationId: 'agent-apps/7-identity-keys' })).status, 200);
    assert.equal((await post(`${url}/api/data-format/apply`, { digest: 'not-a-digest' })).status, 400);
    assert.equal((await post(`${url}/api/data-format/apply`, { digest: PLAN.digest, yes: true })).status, 400);
  });
  assert.deepEqual(calls, [['apply', { digest: PLAN.digest, actor: { entrypoint: 'http' } }],
    ['rollback', { label: 'agent-apps/registry.sqlite', migrationId: 'agent-apps/7-identity-keys',
      actor: { entrypoint: 'http' } }]]);
});

test('a stale confirmation is a 409 the page can read again', async () => {
  const stale = new DataFormatError('data-format', 'data_format_stale_preview', 'The stores changed.');
  await withServer(migrations([], { applyError: stale }), async (url) => {
    const response = await post(`${url}/api/data-format/apply`, { digest: PLAN.digest });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'data_format_stale_preview');
  });
});

test('apply and undo are refused from another device', async () => {
  const calls = [];
  const sent = [];
  const response = { setHeader() {}, writeHead(status) { sent.push(status); return this; }, end() {} };
  for (const action of ['apply', 'rollback']) {
    const request = { method: 'POST', socket: { remoteAddress: '192.168.1.20' }, headers: {} };
    await handleDataFormatApiRequest({ request, response, url: new URL(`http://lan/api/data-format/${action}`),
      migrations: migrations(calls) });
  }
  assert.deepEqual(sent, [403, 403]);
  assert.deepEqual(calls, []);
});

test('no MCP or Agent tool module reaches the operations that change data formats', () => {
  const changing = ['src/data-format/migration-operations.js', 'src/data-format/graph-format-client.js',
    'src/graphiti/human-review-channel.js',
    'src/data-format/backup-retention.js', 'packages/roundtable/src/storage/database-migration.js',
    'src/storage/json-format-migration.js'].map((path) => join(ROOT, path));
  for (const entry of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    const modules = reachableModules(join(ROOT, entry));
    assert.deepEqual(changing.filter((path) => modules.has(path)), [], entry);
  }
  assert.deepEqual(listAgentTools().map((tool) => tool.name).filter((name) => /migrat|data_format|restore/.test(name)), []);
  // The provider routes that change records take the human-review token, which only this channel sends.
  const senders = [...reachableModules(join(ROOT, 'src/cli.js'))].filter((file) => file.startsWith(join(ROOT, 'src'))
    && readFileSync(file, 'utf8').includes('x-fuli-human-review-token'));
  assert.deepEqual(senders, [join(ROOT, 'src/graphiti/human-review-channel.js')]);
});

test('a migration request holds the graph runtime lease, so an adaptive runtime wakes and stays up', async () => {
  const { handleApiRequest } = await import('../src/http/api-router.js');
  const owners = [];
  const system = { withGraphRuntimeLease: async (owner, run) => { owners.push(owner); return run(); } };
  const sent = [];
  const response = { setHeader() {}, writeHead(status) { sent.push(status); return this; }, end() {} };
  const handled = await handleApiRequest({ request: { method: 'GET', url: '/api/data-format', headers: {},
    socket: { remoteAddress: '127.0.0.1' } }, response, app: {}, system, dataFormatMigrations: migrations([]) });

  assert.equal(handled, true);
  assert.deepEqual(owners, ['http:GET:/api/data-format']);
  assert.deepEqual(sent, [200]);
});
