import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { knowledgeOwnerReads } from '../src/knowledge-owner-reads/console-port.js';

// rec#5 C6 through the local console's HTTP route. Synthetic Provider: it
// records what the console sent and answers like the Provider.
const CONFIG = { version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
  accessToken: 'synthetic-token', principalId: 'synthetic-owner', spaceId: 'personal-space' } };
const STORED = { session_id: 's-1', source_application: 'claude_code', truncated: false,
  projects: [{ id: 'alpha', name: 'Alpha', temporary: false }],
  turns: [{ task_id: 'task-1', turn_id: null, created_at: '2026-10-20T02:00:00Z', personal_project_id: 'alpha',
    conversation_id: 'c-1', capture_off: null, not_recorded: [],
    messages: [{ role: 'user', text: 'Synthetic question', created_at: '2026-10-20T02:00:00Z' }] }],
  items: [] };

// The list shows every FLA's items, so it leaves on the console's human-review
// channel, never on the Agent's access token alone.
function application() {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, { fetchImpl: async (rawUrl, options = {}) => {
    calls.push({ path: new URL(rawUrl).pathname, method: options.method, body: JSON.parse(options.body ?? 'null') });
    return new Response(JSON.stringify(STORED), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  app.ownerReads = knowledgeOwnerReads('synthetic-data-dir', { send: async (path, body, { review, method }) => {
    calls.push({ path, method, body, review });
    return { ok: true, status: 200, payload: structuredClone(STORED) };
  } });
  return { app, calls };
}

async function get(app, path, ownerReads = app.ownerReads) {
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  try {
    await handleGraphApiRequest({ request: Object.assign(Readable.from([]), { method: 'GET', headers: {} }), response,
      url: new URL(`http://127.0.0.1${path}`), app, ownerReads });
    return sent;
  } catch (error) {
    return mapHttpError(error);
  }
}

test('the receipt link opens the session list: one Provider read of exactly that session', async () => {
  const { app, calls } = application();
  const result = await get(app, '/api/session-records?personalSpaceId=personal-space&sourceApplication=claude_code&sessionId=s-1');
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ path: '/v1/session-records', method: 'POST', review: true,
    body: { personal_space_id: 'personal-space', source_application: 'claude_code', session_id: 's-1' } }]);
  assert.equal(result.body.total, 1);
  assert.deepEqual(result.body.entries[0].project, { id: 'alpha', name: 'Alpha', temporary: false });
  assert.match(result.body.entries[0].link, /\/s\/s-1\?client=claude_code&item=personal-space\/turn%3Atask-1$/);
});

test('the receipt\'s short link names only the session: the Provider finds its client', async () => {
  const { app, calls } = application();
  const result = await get(app, '/api/session-records?personalSpaceId=personal-space&sessionId=s-1');
  assert.equal(result.status, 200);
  assert.deepEqual(calls[0].body, { personal_space_id: 'personal-space', source_application: null, session_id: 's-1' });
  assert.equal(result.body.session.sourceApplication, 'claude_code', 'the client the Provider found');
});

test('the link grants nothing: another space or no session is refused before the Provider', async () => {
  const { app, calls } = application();
  assert.equal((await get(app, '/api/session-records?personalSpaceId=other&sourceApplication=codex&sessionId=s-1')).status, 400);
  assert.equal((await get(app, '/api/session-records?personalSpaceId=personal-space&sourceApplication=codex')).status, 400);
  assert.equal(calls.length, 0);
});

test('without the human-review channel the console has no full read and asks no Provider', async () => {
  const { app, calls } = application();
  const result = await get(app, '/api/session-records?personalSpaceId=personal-space&sourceApplication=codex&sessionId=s-1',
    null);
  assert.equal(result.status, 503);
  assert.equal(calls.length, 0);
});

test('the console read and the Agent tool are one interface', () => {
  const domain = agentInterfaceCatalog().readWorkflows.find(entry => entry.domain === 'session-records');
  assert.deepEqual(domain.toolNames, ['read_session_records']);
  assert.deepEqual(domain.readRoutes, ['GET /api/session-records']);
});
