import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { DELEGATION_HEADER, DELEGATION_OPERATION_HEADER, encodeDelegation } from '../src/agent-delegation/delegation-header.js';
import { createAgentDelegation } from '../src/agent-delegation/port.js';
import { createDelegatedConsoleClient } from '../src/agent-delegation/console-client.js';
import { handleDelegatedRequest } from '../src/http/agent-delegation-gate.js';
import { handleAgentDelegationRequest } from '../src/http/agent-delegation-api-router.js';
import { recentSessionUserMessages } from '../src/graphiti/session-records.js';
import { createServer } from '../src/server.js';

// rec#11 D-81, synthetic data only.
const CALL = { actor: { agentId: 'fla-synthetic', projectId: 'project-a', client: 'codex', sessionId: 'session-a' },
  reason: 'The person asked to turn recall answers off', bodyFields: ['answerFromConfirmed'] };

// One cleanup per test: every port closes before its directory is removed
// (Windows keeps an open SQLite file locked).
const cleanups = new WeakMap();
function cleanup(t) {
  if (!cleanups.has(t)) {
    const state = { ports: [], directories: [] };
    cleanups.set(t, state);
    t.after(() => {
      for (const port of state.ports) port.close();
      for (const directory of state.directories) rmSync(directory, { recursive: true, force: true });
    });
  }
  return cleanups.get(t);
}

function dataDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'd81-delegation-'));
  cleanup(t).directories.push(directory);
  return directory;
}

function delegation(t, directory = dataDir(t)) {
  const port = createAgentDelegation(directory, { now: () => '2026-11-03T08:00:00.000Z' });
  cleanup(t).ports.push(port);
  return port;
}

function request(method, url, { header = encodeDelegation(CALL), remoteAddress = '127.0.0.1', body = {} } = {}) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method, url, headers: { 'content-type': 'application/json', ...(header === null ? {} : { [DELEGATION_HEADER]: header }) },
    socket: { remoteAddress }
  });
}

function response() {
  const sent = { headers: {} };
  return Object.assign(sent, {
    setHeader(name, value) { sent.headers[name.toLowerCase()] = value; },
    writeHead(status) { sent.statusCode = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; }
  });
}

async function gate(port, method, url, options = {}) {
  const sent = response();
  let ran = false;
  await handleDelegatedRequest({ request: request(method, url, options), response: sent, delegation: port,
    agentAccessEnabled: () => options.agentAccess !== false,
    handle: async () => { ran = true; sent.writeHead(options.status ?? 200); sent.end('{"ok":true}'); return true; } });
  return { ran, sent };
}

test('each category starts at its catalog default and the person\'s switch is kept on disk', (t) => {
  const directory = dataDir(t);
  const port = delegation(t, directory);
  const enabled = (policy) => Object.fromEntries(policy.categories.map(({ id, enabled: on }) => [id, on]));
  assert.deepEqual(enabled(port.read()), { settings: true, organisation: true, projects: true, services_apps: true,
    roundtable: true, decisions: true, lan_roundtable: false, model_settings: false, public_projects: false });
  assert.equal(enabled(port.setCategory('lan_roundtable', true)).lan_roundtable, true);
  assert.equal(enabled(port.setCategory('settings', false)).settings, false);
  const reopened = delegation(t, directory);
  assert.deepEqual([enabled(reopened.read()).lan_roundtable, enabled(reopened.read()).settings], [true, false]);
  assert.equal(reopened.read().updatedAt, '2026-11-03T08:00:00.000Z');
  assert.throws(() => port.setCategory('local_user_only', true), /category must be one of/);
  assert.throws(() => port.setCategory('settings', 'yes'), /enabled must be true or false/);
});

test('a delegated change runs while its category is on, and is recorded with who, why and its undo', async (t) => {
  const port = delegation(t);
  const { ran, sent } = await gate(port, 'PATCH', '/api/recall-policy');
  assert.equal(ran, true);
  assert.equal(sent.statusCode, 200);
  const [operation] = port.read().operations;
  assert.equal(sent.headers[DELEGATION_OPERATION_HEADER], operation.id);
  assert.deepEqual({ ...operation, id: undefined }, { id: undefined, at: '2026-11-03T08:00:00.000Z',
    route: 'PATCH /api/recall-policy', path: '/api/recall-policy', category: 'settings', actor: CALL.actor,
    reason: CALL.reason, bodyFields: ['answerFromConfirmed'], status: 200, outcome: 'succeeded',
    undo: 'Set answerFromConfirmed back.', relayed: null });
  // A refused change is recorded as failed; the person reads both.
  await gate(port, 'PUT', '/api/occupations/writer', { status: 409 });
  assert.deepEqual(port.read().operations.map(({ route, outcome }) => [route, outcome]),
    [['PUT /api/occupations/:key', 'failed'], ['PATCH /api/recall-policy', 'succeeded']]);
});

test('a category the person took back, or an off-by-default one, refuses before any handler runs', async (t) => {
  const port = delegation(t);
  port.setCategory('projects', false);
  const off = await gate(port, 'POST', '/api/personal-projects/app/parent');
  assert.equal(off.ran, false);
  assert.equal(off.sent.statusCode, 403);
  assert.equal(off.sent.body.code, 'delegation_category_off');
  assert.match(off.sent.body.error, /设置 › AI 权限/);
  assert.match(off.sent.body.error, /Settings › AI permissions/);
  const lan = await gate(port, 'POST', '/api/peer/join');
  assert.deepEqual([lan.ran, lan.sent.body.code], [false, 'delegation_category_off']);
  port.setCategory('lan_roundtable', true);
  assert.equal((await gate(port, 'POST', '/api/peer/join')).ran, true);
  assert.deepEqual(port.read().operations.map(({ route }) => route), ['POST /api/peer/join']);
});

test('local-user-only changes stay refused even when the policy file is tampered with', async (t) => {
  const directory = dataDir(t);
  writeFileSync(join(directory, 'agent-delegation-policy.json'), JSON.stringify({ version: 1, updatedAt: null,
    categories: { local_user_only: true, data_format: true, knowledge: true, undefined: true, '*': true } }));
  const port = delegation(t, directory);
  for (const [method, url] of [['POST', '/api/knowledge/entity/item-a/hard-delete'], ['POST', '/api/data-format/apply'],
    ['PATCH', '/api/agent-access-policy'], ['PUT', '/api/agent-delegation/categories/model_settings'],
    ['PUT', '/api/model-backends/keys/synthetic'], ['POST', '/api/agent-apps/app-a/delete-data'],
    ['POST', '/api/roundtable/threads'], ['PUT', '/api/judgment/policy'], ['POST', '/api/agent-apps/app-a/confirm'],
    ['POST', '/api/not-a-console-route']]) {
    const { ran, sent } = await gate(port, method, url);
    assert.deepEqual([ran, sent.statusCode, sent.body.code], [false, 403, 'local_user_only'], url);
  }
  // A route with its own Agent tool is called with that tool instead.
  const tool = await gate(port, 'PATCH', '/api/capture-policy');
  assert.deepEqual([tool.ran, tool.sent.body.code], [false, 'agent_tool_route']);
  assert.deepEqual(port.read().operations, []);
  assert.equal(port.read().categories.some(({ id }) => id === 'local_user_only'), false);
});

test('the gate passes the person\'s own requests and refuses delegation from another computer or with Agent access off', async (t) => {
  const port = delegation(t);
  const own = await gate(port, 'POST', '/api/knowledge/entity/item-a/hard-delete', { header: null });
  assert.equal(own.ran, true);
  const remote = await gate(port, 'PATCH', '/api/recall-policy', { remoteAddress: '192.168.1.20' });
  assert.deepEqual([remote.ran, remote.sent.statusCode], [false, 403]);
  const access = await gate(port, 'PATCH', '/api/recall-policy', { agentAccess: false });
  assert.deepEqual([access.ran, access.sent.body.code], [false, 'agent_access_disabled']);
  const malformed = await gate(port, 'PATCH', '/api/recall-policy', { header: 'not-json' });
  assert.deepEqual([malformed.ran, malformed.sent.statusCode], [false, 400]);
  assert.deepEqual(port.read().operations, []);
});

test('Settings › AI permissions reads every category and switches one only from this computer', async (t) => {
  const port = delegation(t);
  const route = async (method, path, body, remoteAddress = '127.0.0.1') => {
    const sent = response();
    const handled = await handleAgentDelegationRequest({ request: request(method, path, { header: null, body, remoteAddress }),
      response: sent, url: new URL(path, 'http://127.0.0.1'), delegation: port });
    return { handled, sent };
  };
  assert.equal((await route('GET', '/api/agent-delegation')).sent.body.categories.length, 9);
  const changed = await route('PUT', '/api/agent-delegation/categories/model_settings', { enabled: true });
  assert.equal(changed.sent.body.categories.find(({ id }) => id === 'model_settings').enabled, true);
  const remote = await route('PUT', '/api/agent-delegation/categories/settings', { enabled: false }, '192.168.1.20');
  assert.equal(remote.sent.statusCode, 403);
  assert.equal(port.read().categories.find(({ id }) => id === 'settings').enabled, true);
  assert.equal((await route('GET', '/api/other')).handled, false);
});

function toolApp(send) {
  return {
    getAgentAccessPolicy: () => ({ enabled: true }),
    config: { personal: { spaceId: 'space-a' } },
    taskContextRegistry: { context: async () => ({ sessionId: 'session-a', personalProjectId: 'project-a',
      projectAgentId: 'fla-synthetic', sourceApplication: 'codex' }) },
    delegatedConsole: { send }
  };
}

test('run_delegated_action sends the exact route with the calling task as actor and returns the receipt', async () => {
  const sent = [];
  const app = toolApp(async (input) => { sent.push(input); return { result: { saved: true }, operationId: 'op-synthetic' }; });
  const result = await callAgentTool(app, 'run_delegated_action', { taskContextToken: 'fuli-task-synthetic',
    route: 'PUT /api/occupations/:key', params: { key: 'tech writer' }, body: { label: 'Writer' }, reason: 'Asked to rename' });
  assert.deepEqual(sent, [{ method: 'PUT', path: '/api/occupations/tech%20writer', body: { label: 'Writer' },
    call: { actor: { agentId: 'fla-synthetic', projectId: 'project-a', client: 'codex', sessionId: 'session-a' },
      reason: 'Asked to rename', bodyFields: ['label'] } }]);
  assert.equal(result.operationId, 'op-synthetic');
  assert.equal(result.category, 'organisation');
  assert.match(result.delegation_receipt.markdown, /PUT \/api\/occupations\/:key.*op-synthetic/);
});

test('run_delegated_action refuses local-user-only routes and missing params before sending anything', async () => {
  const sent = [];
  const app = toolApp(async (input) => { sent.push(input); return { result: {}, operationId: 'x' }; });
  const call = (input) => callAgentTool(app, 'run_delegated_action',
    { taskContextToken: 'fuli-task-synthetic', reason: 'synthetic', ...input });
  await assert.rejects(call({ route: 'POST /api/knowledge/:itemKind/:itemId/hard-delete',
    params: { itemKind: 'entity', itemId: 'a' } }), { code: 'local_user_only' });
  await assert.rejects(call({ route: 'POST /api/data-format/apply' }), { code: 'local_user_only' });
  await assert.rejects(call({ route: 'PATCH /api/capture-policy' }), { code: 'agent_tool_route' });
  await assert.rejects(call({ route: 'PUT /api/occupations/:key' }), /params\.key is required/);
  assert.deepEqual(sent, []);
});

test('the real console runs an FLA\'s change through the gate, records it, and refuses a local-user-only one', async (t) => {
  const port = delegation(t);
  const saved = [];
  const app = { graphiti: true, getAgentAccessPolicy: () => ({ enabled: true }),
    updateRecallPolicy: (input) => { saved.push(input); return { answerFromConfirmed: input.answerFromConfirmed }; },
    async state() { throw new Error('not queried'); }, close() {} };
  const runtime = await createServer({ port: 0, dataFormatNotices: () => [], agentDelegation: port, app });
  t.after(() => new Promise((done) => runtime.server.close(done)));
  const client = createDelegatedConsoleClient({ consoleUrl: () => runtime.url });
  const sent = await client.send({ method: 'PATCH', path: '/api/recall-policy', body: { answerFromConfirmed: false }, call: CALL });
  assert.deepEqual(sent.result, { answerFromConfirmed: false });
  assert.deepEqual(saved, [{ answerFromConfirmed: false }]);
  assert.deepEqual(port.read().operations.map(({ id, route, outcome }) => [id, route, outcome]),
    [[sent.operationId, 'PATCH /api/recall-policy', 'succeeded']]);
  await assert.rejects(client.send({ method: 'PATCH', path: '/api/agent-access-policy', body: { enabled: true }, call: CALL }),
    { code: 'local_user_only' });
  port.setCategory('settings', false);
  await assert.rejects(client.send({ method: 'PATCH', path: '/api/recall-policy', body: { answerFromConfirmed: true }, call: CALL }),
    { code: 'delegation_category_off' });
  assert.equal(saved.length, 1);
});

test('the console client carries the call in its header and turns a refusal into the console\'s error', async () => {
  const requests = [];
  const client = createDelegatedConsoleClient({ consoleUrl: () => 'http://127.0.0.1:9',
    fetchImpl: async (url, init) => {
      requests.push([url, init]);
      return new Response(JSON.stringify({ error: 'taken back', code: 'delegation_category_off' }), { status: 403 });
    } });
  await assert.rejects(client.send({ method: 'POST', path: '/api/peer/join', body: {}, call: CALL }),
    { code: 'delegation_category_off', message: 'taken back' });
  assert.equal(requests[0][0], 'http://127.0.0.1:9/api/peer/join');
  assert.equal(requests[0][1].headers[DELEGATION_HEADER], encodeDelegation(CALL));
  const unreachable = createDelegatedConsoleClient({ consoleUrl: () => 'http://127.0.0.1:9',
    fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(unreachable.send({ method: 'POST', path: '/api/peer/join', body: {}, call: CALL }),
    { code: 'console_unreachable' });
});

// rec#80: the person decides in chat, an FLA relays their exact words.
const RELAYED = { words: '这个冲突保留新的那条', messageRef: { source: 'session_record', taskId: 'task-2', conversationId: 'conversation-a',
  at: '2026-11-04T09:00:00.000Z' } };

function relayApp(send, messages) {
  const reads = [];
  const at = (index, second = 0) => new Date(Date.UTC(2026, 10, 4, 0, index, second)).toISOString();
  const app = { ...toolApp(send), personal: { readSessionRecords: async (input) => {
    reads.push(input);
    return { turns: messages.map((text, index) => ({ task_id: `task-${index + 1}`, conversation_id: 'conversation-a',
      personal_project_id: 'project-a', project_agent_id: 'fla-synthetic', created_at: at(index), capture_off: null,
      not_recorded: [], messages: [{ role: 'user', text, created_at: at(index) },
        { role: 'assistant', text: '好的', created_at: at(index, 1) }] })), items: [] };
  } } };
  app.recentSessionUserMessages = (task, limit) => recentSessionUserMessages(app, task, limit);
  return { app, reads };
}

test('a relayed decision runs only with the person\'s exact words from their recent messages of this session', async () => {
  const sent = [];
  const { app, reads } = relayApp(async (input) => { sent.push(input); return { result: { ok: true }, operationId: 'op-relay' }; },
    ['先看一下冲突', '这个冲突  保留新的那条，旧的不要了']);
  const call = (input) => callAgentTool(app, 'run_delegated_action', { taskContextToken: 'fuli-task-synthetic',
    route: 'POST /api/preference-conflicts/:conflictId/complete', params: { conflictId: 'conflict-a' },
    body: { personalSpaceId: 'space-a', resolution: 'keep_right', reason: 'The person chose the newer one' },
    reason: 'The person ruled in chat', ...input });
  await assert.rejects(call({}), { code: 'person_words_required' });
  await assert.rejects(call({ personWords: '好' }), { code: 'person_words_required' });
  await assert.rejects(call({ personWords: '保留旧的那条' }), (error) => error.code === 'person_words_not_found'
    && /问你/.test(error.message) && /exact words/.test(error.message));
  assert.deepEqual(sent, []);
  // Spacing and letter case do not matter; the words are kept as the Agent passed them.
  const result = await call({ personWords: '这个冲突 保留新的那条' });
  assert.deepEqual(sent.map(({ call: delegated }) => delegated.relayed), [{ words: '这个冲突 保留新的那条',
    messageRef: { source: 'session_record', taskId: 'task-2', conversationId: 'conversation-a', at: '2026-11-04T00:01:00.000Z' } }]);
  assert.equal(result.category, 'decisions');
  assert.match(result.delegation_receipt.markdown, /你的决定：「这个冲突 保留新的那条」.*由我转达.*op-relay/);
  // Read as the calling task's own session and FLA, never a session the Agent names.
  assert.deepEqual(reads[0], { personal_space_id: 'space-a', source_application: 'codex', session_id: 'session-a',
    reader_project_id: 'project-a', reader_agent_id: 'fla-synthetic' });
});

test('words older than the person\'s last 20 messages of the session are not found', async () => {
  const messages = ['Keep The Newer One', ...Array.from({ length: 20 }, (_, index) => `message ${index}`)];
  const { app } = relayApp(async () => assert.fail('nothing is sent'), messages);
  await assert.rejects(callAgentTool(app, 'run_delegated_action', { taskContextToken: 'fuli-task-synthetic',
    route: 'POST /api/judgment/feedback', body: {}, reason: 'Relayed', personWords: 'keep the newer one' }),
  { code: 'person_words_not_found' });
  const recent = relayApp(async () => ({ result: {}, operationId: 'op-case' }), messages.slice(1).concat('Keep The Newer One'));
  const result = await callAgentTool(recent.app, 'run_delegated_action', { taskContextToken: 'fuli-task-synthetic',
    route: 'POST /api/judgment/feedback', body: {}, reason: 'Relayed', personWords: 'keep the newer one' });
  assert.equal(result.relayed.words, 'keep the newer one');
});

test('a delegable change ignores personWords and reads no messages', async () => {
  const sent = [];
  const { app, reads } = relayApp(async (input) => { sent.push(input); return { result: {}, operationId: 'op-plain' }; }, []);
  const result = await callAgentTool(app, 'run_delegated_action', { taskContextToken: 'fuli-task-synthetic',
    route: 'PATCH /api/recall-policy', body: { answerFromConfirmed: false }, reason: 'Asked', personWords: '没说过的话' });
  assert.deepEqual([reads.length, 'relayed' in sent[0].call, 'relayed' in result], [0, false, false]);
  assert.match(result.delegation_receipt.markdown, /已代你操作 PATCH \/api\/recall-policy/);
});

test('the gate runs a relayed decision only with the words in its header and records them', async (t) => {
  const port = delegation(t);
  const bare = await gate(port, 'POST', '/api/agent-attention/respond');
  assert.deepEqual([bare.ran, bare.sent.statusCode, bare.sent.body.code], [false, 400, 'person_words_required']);
  const relayed = await gate(port, 'POST', '/api/agent-attention/respond',
    { header: encodeDelegation({ ...CALL, relayed: RELAYED }) });
  assert.equal(relayed.ran, true);
  const [operation] = port.read().operations;
  assert.deepEqual([operation.route, operation.category, operation.relayed],
    ['POST /api/agent-attention/respond', 'decisions', RELAYED]);
  // A local-user-only change stays refused whatever words come with it.
  const local = await gate(port, 'POST', '/api/knowledge/entity/item-a/hard-delete',
    { header: encodeDelegation({ ...CALL, relayed: RELAYED }) });
  assert.deepEqual([local.ran, local.sent.body.code], [false, 'local_user_only']);
  port.setCategory('decisions', false);
  const off = await gate(port, 'POST', '/api/judgment/feedback', { header: encodeDelegation({ ...CALL, relayed: RELAYED }) });
  assert.deepEqual([off.ran, off.sent.body.code], [false, 'delegation_category_off']);
});

test('the real console keeps a relayed batch confirmation as the person\'s, relayed by the FLA', async (t) => {
  const port = delegation(t);
  const confirmed = [];
  const app = { graphiti: true, getAgentAccessPolicy: () => ({ enabled: true }),
    confirmKnowledgeBatch: (input) => { confirmed.push(input); return { confirmed: input.items.length }; },
    async state() { throw new Error('not queried'); }, close() {} };
  const runtime = await createServer({ port: 0, dataFormatNotices: () => [], agentDelegation: port, app });
  t.after(() => new Promise((done) => runtime.server.close(done)));
  const client = createDelegatedConsoleClient({ consoleUrl: () => runtime.url });
  const body = { personalSpaceId: 'space-a', groupKind: 'topic', groupValue: 'citations', reason: 'Confirmed in chat',
    confirmer: { kind: 'authoritative_source', label: 'Claimed by the body' }, items: [] };
  await client.send({ method: 'POST', path: '/api/knowledge/batch-confirmation', body,
    call: { ...CALL, bodyFields: Object.keys(body), relayed: RELAYED } });
  assert.deepEqual([confirmed[0].confirmer, confirmed[0].operationActor],
    [{ kind: 'user', label: '由 fla-synthetic 转达' }, 'human']);
  // The person's own confirmation in the console keeps what they chose.
  const own = await fetch(new URL('/api/knowledge/batch-confirmation', runtime.url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(own.status, 200);
  assert.deepEqual(confirmed[1].confirmer, body.confirmer);
  assert.deepEqual(port.read().operations.map(({ route, relayed }) => [route, relayed]),
    [['POST /api/knowledge/batch-confirmation', RELAYED]]);
});
