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
const LISTS = new Set(['/v1/preference-conflicts', '/v1/publication-drafts']);

function application() {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, { fetchImpl: async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: options.headers ?? {},
      body: options.body ? JSON.parse(options.body) : null });
    const payload = url.pathname.endsWith('/graph') ? GRAPH : LISTS.has(url.pathname) ? []
      : { entries: [], unchanged_count: 0 };
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
  await ownerReads.sessionMigration({ personal_space_id: SPACE });
  await ownerReads.preferenceConflicts({ personalSpaceId: SPACE, status: 'ai_pending', limit: 50, offset: 100 });
  await ownerReads.publicationDrafts({ personalSpaceId: SPACE, status: 'all' });
  assert.deepEqual(sent, [
    { path: '/v1/knowledge/item-views', method: 'POST', review: true },
    { path: '/v1/knowledge/turn-receipts', method: 'POST', review: true },
    { path: '/v1/session-records', method: 'POST', review: true },
    { path: '/v1/knowledge/session-migrations/preview', method: 'POST', review: true },
    { path: `/v1/preference-conflicts?personal_space_id=${SPACE}&limit=50&status=ai_pending&offset=100`, method: 'GET',
      review: true },
    { path: `/v1/publication-drafts?personal_space_id=${SPACE}&status=all`, method: 'GET', review: true }]);
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

// The console's GET on the graph routes, through its port or (none) as an Agent.
async function consoleGet(app, path, ownerReads) {
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  await handleGraphApiRequest({ request: Object.assign(Readable.from([]), { method: 'GET', headers: {} }), response,
    url: new URL(`http://127.0.0.1${path}`), app, ownerReads });
  return sent;
}

function recordingPort() {
  const sent = [];
  const ownerReads = knowledgeOwnerReads('synthetic-data-dir', { send: async (path, body, options) => {
    sent.push({ path: path.split('?')[0], query: Object.fromEntries(new URL(path, 'http://p').searchParams),
      review: options.review, method: options.method });
    return { ok: true, status: 200, payload: path.includes('/graph') ? GRAPH : [] };
  } });
  return { sent, ownerReads };
}

test('preference conflicts: an Agent tool reads as a plain session; the console lists them all through its port', async () => {
  const { app, calls } = application();
  await callAgentTool(app, 'list_preference_conflicts', { personalSpaceId: SPACE, status: 'ai_pending' });
  assert.deepEqual(calls.map(call => [call.path, call.query]), [
    ['/v1/preference-conflicts', { personal_space_id: SPACE, limit: '500', status: 'ai_pending' }]]);
  assert.ok(!reviewHeader(calls[0].headers), 'no proof: no conflict naming an FLA\'s own item');
  const { sent, ownerReads } = recordingPort();
  const listed = await consoleGet(app, `/api/preference-conflicts?personalSpaceId=${SPACE}&status=ai_pending`, ownerReads);
  assert.equal(listed.status, 200);
  assert.deepEqual(sent, [{ path: '/v1/preference-conflicts', method: 'GET', review: true,
    query: { personal_space_id: SPACE, limit: '500', status: 'ai_pending' } }]);
  // The writing-taste profile counts the person's conflicts the same way, with the graph.
  sent.length = 0;
  await consoleGet(app, `/api/writing-taste-profile?personalSpaceId=${SPACE}`, ownerReads);
  assert.deepEqual(sent.map(({ path, review }) => [path, review]).sort(), [
    ['/v1/preference-conflicts', true], [`/v1/spaces/${SPACE}/graph`, true]]);
  assert.equal(calls.length, 1, 'the console\'s reads never leave on the Agent client');
});

test('a conflict\'s defer and resolve name the Agent\'s FLA; the console defers and completes with its proof', async () => {
  const { app, calls } = application();
  const pair = { personalSpaceId: SPACE, conflictId: 'conflict-1', preferenceKey: 'synthetic', preferenceScope: 'global',
    leftItemId: 'left', leftItemKind: 'entity', rightItemId: 'right', rightItemKind: 'entity', reason: 'Synthetic.' };
  const fla = { personalProjectId: 'alpha', projectAgentId: 'g' };
  await callAgentTool(app, 'defer_preference_conflict', { ...pair, ...fla });
  await callAgentTool(app, 'defer_preference_conflict', pair);
  await callAgentTool(app, 'resolve_deferred_preference_conflict', { personalSpaceId: SPACE, conflictId: 'conflict-1',
    resolution: 'keep_left', reason: 'Synthetic.', ...fla });
  const readers = calls.map(call => [call.path, call.body.reader_project_id, call.body.reader_agent_id]);
  assert.deepEqual(readers, [['/v1/preference-conflicts/defer', 'alpha', 'g'],
    ['/v1/preference-conflicts/defer', undefined, undefined],
    ['/v1/preference-conflicts/conflict-1/resolve', 'alpha', 'g']]);
  assert.ok(calls.every(call => !reviewHeader(call.headers)));
  calls.length = 0;
  const sent = [];
  const ownerReads = knowledgeOwnerReads('synthetic-data-dir', { send: async (path, body, options) => {
    sent.push({ path, review: options.review, reader: body.reader_agent_id });
    return { ok: true, status: 200, payload: {} };
  } });
  const post = async (path, body) => {
    const response = { setHeader() {}, writeHead() {}, end() {} };
    await handleGraphApiRequest({ request: Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),
      { method: 'POST', headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } }),
    response, url: new URL(`http://127.0.0.1${path}`), app, ownerReads });
  };
  await post('/api/preference-conflicts/defer', pair);
  await post('/api/preference-conflicts/conflict-1/complete', { personalSpaceId: SPACE, resolution: 'merge',
    reason: 'Synthetic.' });
  assert.deepEqual(sent, [{ path: '/v1/preference-conflicts/defer', review: true, reader: undefined },
    { path: '/v1/preference-conflicts/conflict-1/complete', review: true, reader: undefined }]);
  assert.equal(calls.length, 0, 'the person\'s decision never leaves on the Agent client');
});

test('publication drafts: an Agent tool reads as a plain session; the console lists them all through its port', async () => {
  const { app, calls } = application();
  await callAgentTool(app, 'list_personal_review_queue', { personalSpaceId: SPACE });
  const drafts = calls.filter(call => call.path === '/v1/publication-drafts');
  // Reconciling submissions reads metadata only; then the Agent's list.
  assert.deepEqual(drafts.map(call => call.query), [
    { personal_space_id: SPACE, status: 'all', metadata_only: 'true' }, { personal_space_id: SPACE, status: 'pending' }]);
  assert.ok(drafts.every(call => !reviewHeader(call.headers)), 'no proof: no draft of an FLA\'s work');
  calls.length = 0;
  const { sent, ownerReads } = recordingPort();
  assert.equal((await consoleGet(app, `/api/personal-review?personalSpaceId=${SPACE}&status=submitted`, ownerReads)).status,
    200);
  // Reconciliation settles the person's drafts on the same channel: an FLA's draft, even erased, is theirs alone.
  assert.deepEqual(sent, [
    { path: '/v1/publication-drafts', method: 'GET', review: true,
      query: { personal_space_id: SPACE, status: 'all', metadata_only: 'true' } },
    { path: '/v1/publication-drafts', method: 'GET', review: true,
      query: { personal_space_id: SPACE, status: 'submitted' } }]);
  assert.deepEqual(calls, [], 'nothing of the console\'s list or settlement leaves on the Agent client');
});

test('the console decides and submits a draft on its port; an Agent tool on its own client', async () => {
  const { app, calls } = application();
  const sent = [];
  const ownerReads = knowledgeOwnerReads('synthetic-data-dir', { send: async (path, body, options) => {
    sent.push({ path: path.split('?')[0], body, review: options.review, method: options.method });
    return { ok: true, status: 200, payload: { id: 'draft-1', status: 'ignored' } };
  } });
  const response = { setHeader() {}, writeHead() {}, end() {} };
  await handleGraphApiRequest({ request: Object.assign(Readable.from([Buffer.from(JSON.stringify({ decision: 'ignore' }))]),
    { method: 'POST', headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } }),
  response, url: new URL('http://127.0.0.1/api/personal-review/draft-1/decision'), app, ownerReads });
  assert.deepEqual(sent, [{ path: '/v1/publication-drafts/draft-1/decision', method: 'POST', review: true,
    body: { decision: 'ignore', shared_proposal_id: null } }]);
  assert.deepEqual(calls, []);
  // A capture made only for a team names no local source: only this channel reads it to submit.
  await ownerReads.submissions.getPublicationDraft(SPACE, 'draft-1');
  assert.deepEqual(sent.at(-1), { path: '/v1/publication-drafts/draft-1', method: 'GET', review: true, body: null });
  await callAgentTool(app, 'review_personal_draft', { draftId: 'draft-1', decision: 'ignore' });
  assert.deepEqual(calls.map(call => call.path), ['/v1/publication-drafts/draft-1/decision']);
  assert.ok(!reviewHeader(calls[0].headers));
});

test('the console\'s settlement of an uncertain submission goes through its port with the proof', async () => {
  const { app, calls } = application();
  const sent = [];
  const draft = { id: 'draft-1', status: 'submission_unknown', submission_id: 'attempt-1',
    submission_started_at: '2026-10-24T00:00:00Z', provider_url: 'https://public.example',
    target_project_id: 'team', source_identity: { idempotency_key: 'key-1' } };
  const ownerReads = knowledgeOwnerReads('synthetic-data-dir', { send: async (path, body, options) => {
    sent.push({ path: path.split('?')[0], body, review: options.review, method: options.method });
    return { ok: true, status: 200, payload: options.method === 'GET' ? [draft] : draft };
  } });
  const lookups = [];
  const team = { lookupProposal: async (...args) => { lookups.push(args.slice(0, 2)); return { id: 'p-1', status: 'pending' }; } };
  app.workspaces.set('https://public.example', { client: team });
  await app.reconcilePersonalSubmissions({}, ownerReads);
  assert.deepEqual(lookups, [['team', 'key-1']]);
  assert.deepEqual(sent.map(({ path, review, method }) => [method, path, review]), [
    ['GET', '/v1/publication-drafts', true], ['POST', '/v1/publication-drafts/draft-1/decision', true]]);
  assert.equal(sent[1].body.decision, 'reconcile_submit_public');
  assert.deepEqual(calls, []);
});
