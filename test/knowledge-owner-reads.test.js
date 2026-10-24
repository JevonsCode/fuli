import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { callAgentTool } from '../src/agent-tools.js';
import { readTurnReceipt } from '../src/agents/turn-receipt.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { taskKnowledgeReader } from '../src/graphiti/knowledge-reader.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { knowledgeOwnerReads } from '../src/knowledge-owner-reads/console-port.js';
import { reachableModules } from '../test-support/module-graph.js';

// The FLA read boundary (0.20.1): an Agent reads personal knowledge as its
// FLA or as a plain session, and the Provider hides every other FLA's own
// knowledge; only the console's human-review port reads it in full.
// Synthetic Provider only: it records what each path sent.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPACE = 'personal-space';
const CONFIG = { version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
  accessToken: 'synthetic-token', principalId: 'synthetic-owner', spaceId: SPACE } };
const GRAPH = { space_id: SPACE, nodes: [], edges: [], truncated: false };

function application() {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, { fetchImpl: async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: options.headers ?? {},
      body: options.body ? JSON.parse(options.body) : null });
    const payload = url.pathname.endsWith('/graph') ? GRAPH : { entries: [], unchanged_count: 0 };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  return { app, calls };
}

function reviewHeader(headers) {
  return Object.keys(headers).some(name => name.toLowerCase() === 'x-fuli-human-review-token');
}

test('no MCP or Agent tool module reaches the console\'s full reads', () => {
  const full = ['src/knowledge-owner-reads/console-port.js', 'src/graphiti/human-review-channel.js']
    .map(path => join(ROOT, path));
  for (const entry of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    const modules = reachableModules(join(ROOT, entry));
    assert.deepEqual(full.filter(path => modules.has(path)), [], entry);
  }
});

test('get_knowledge_graph reads as the FLA it names, or as a plain session, never with the review proof', async () => {
  const { app, calls } = application();
  await callAgentTool(app, 'get_knowledge_graph', { spaceId: SPACE, personalProjectId: 'alpha', projectAgentId: 'g' });
  await callAgentTool(app, 'get_knowledge_graph', { spaceId: SPACE, personalProjectId: 'alpha' });
  const graphs = calls.filter(call => call.path === `/v1/spaces/${SPACE}/graph`);
  assert.deepEqual(graphs.map(call => call.query), [
    { limit: '500', personal_project_id: 'alpha', reader_project_id: 'alpha', reader_agent_id: 'g' },
    { limit: '500', personal_project_id: 'alpha' }]);
  assert.ok(graphs.every(call => !reviewHeader(call.headers)));
});

test('the console graph goes through the human-review port; without it the page reads as an Agent', async () => {
  const { app, calls } = application();
  const sent = [];
  const ownerReads = knowledgeOwnerReads('synthetic-data-dir', { send: async (path, body, options) => {
    sent.push({ path, body, ...options });
    return { ok: true, status: 200, payload: GRAPH };
  } });
  const get = async (ports) => {
    const response = { setHeader() {}, writeHead() {}, end() {} };
    await handleGraphApiRequest({ request: Object.assign(Readable.from([]), { method: 'GET', headers: {} }), response,
      url: new URL(`http://127.0.0.1/api/graph?spaceId=${SPACE}&personalProjectId=alpha`), app, ownerReads: ports });
  };
  await get(ownerReads);
  assert.deepEqual(sent, [{ path: `/v1/spaces/${SPACE}/graph?limit=500&personal_project_id=alpha`, body: null,
    review: true, method: 'GET' }]);
  assert.equal(calls.length, 0, 'the full read never leaves on the Agent client');
  await get(null);
  assert.deepEqual(calls.map(call => call.query), [{ limit: '500', personal_project_id: 'alpha' }]);
  assert.ok(!reviewHeader(calls[0].headers), 'no proof: the Provider hides every FLA\'s own knowledge');
});

test('every console full read carries the review proof on its own route', async () => {
  const sent = [];
  const ownerReads = knowledgeOwnerReads('synthetic-data-dir', { send: async (path, body, options) => {
    sent.push({ path, method: options.method, review: options.review });
    return { ok: true, status: 200, payload: {} };
  } });
  await ownerReads.itemView({ personal_space_id: SPACE });
  await ownerReads.turnReceipt({ personal_space_id: SPACE });
  await ownerReads.sessionRecords({ personal_space_id: SPACE });
  assert.deepEqual(sent, [
    { path: '/v1/knowledge/item-views', method: 'POST', review: true },
    { path: '/v1/knowledge/turn-receipts', method: 'POST', review: true },
    { path: '/v1/session-records', method: 'POST', review: true }]);
  const refused = knowledgeOwnerReads('synthetic-data-dir', { send: async () => ({ ok: false, status: 403,
    payload: { detail: 'independent human review proof required' } }) });
  await assert.rejects(refused.itemView({}), { status: 403 });
});

test('a turn\'s receipt is read as its task\'s FLA, or as a plain session', async () => {
  const { app, calls } = application();
  const saved = [{ status: 'committed', episode_id: 'episode-1' }];
  await readTurnReceipt(app, saved, { reader: taskKnowledgeReader({ personalProjectId: 'alpha', projectAgentId: 'g' }) });
  await readTurnReceipt(app, saved, { reader: taskKnowledgeReader({ personalProjectId: 'alpha', projectAgentId: null }) });
  assert.deepEqual(calls.map(call => call.body), [
    { personal_space_id: SPACE, episode_ids: ['episode-1'], reader_project_id: 'alpha', reader_agent_id: 'g' },
    { personal_space_id: SPACE, episode_ids: ['episode-1'] }]);
  assert.ok(calls.every(call => !reviewHeader(call.headers)));
});
