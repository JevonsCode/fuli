import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { DELEGATION_HEADER, encodeDelegation } from '../src/agent-delegation/delegation-header.js';
import { createAgentDelegation } from '../src/agent-delegation/port.js';
import { DELEGATION_CATEGORIES, agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { categoryOffRefusal } from '../src/agent-delegation/refusals.js';
import { handleDelegatedRequest } from '../src/http/agent-delegation-gate.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { handleTaskCloseRequest } from '../src/http/task-close-api-router.js';
import { taskCloseConsole } from '../src/task-closing/console-port.js';
import { reachableModules } from '../test-support/module-graph.js';

// rec#123: the person completes or cancels a task themself, or an FLA relays
// their words. Synthetic Provider; the real delegation gate, permission and log.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const app = { config: { personal: { spaceId: 'personal-space' } } };
const PATH = '/api/project-agent-tasks/task-a/close';
const ROUTE = 'POST /api/project-agent-tasks/:taskId/close';

function closing() {
  const calls = [];
  const port = taskCloseConsole('synthetic-data-dir', { send: async (path, body, options) => {
    calls.push({ path, body, ...options });
    return { ok: true, status: 200, payload: { task_id: 'task-a', personal_space_id: 'personal-space',
      personal_project_id: 'project-a', title: 'Synthetic', status: body.status, participants: [], events: [] } };
  } });
  return { port, calls };
}

async function post(port, body, { headers = {}, remoteAddress = '127.0.0.1', delegation = createAgentDelegation(null) } = {}) {
  const sent = {};
  const response = { statusCode: 200, setHeader() {}, writeHead(status) { sent.status = status; this.statusCode = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', url: PATH, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress } });
  const handle = () => handleTaskCloseRequest({ request, response, url: new URL(`http://127.0.0.1${PATH}`), app,
    closeConsole: port });
  try {
    await handleDelegatedRequest({ request, response, handle, agentAccessEnabled: () => true, delegation });
    return { status: sent.status ?? 200, body: sent.body };
  } catch (error) {
    return mapHttpError(error);
  }
}

const relayedCall = (relayed) => ({ [DELEGATION_HEADER]: encodeDelegation({ reason: 'The person said it is done.',
  actor: { agentId: 'fla-b', projectId: 'project-a', client: 'claude_code', sessionId: 'session-b' },
  bodyFields: ['personalSpaceId', 'personalProjectId', 'status'], ...(relayed ? { relayed } : {}) }) });
const WORDS = { words: '这个任务做完了，可以关掉', messageRef: { source: 'current_turn', taskId: null, conversationId: null,
  at: '2026-11-13T08:00:00Z' } };
const BODY = { personalSpaceId: 'personal-space', personalProjectId: 'project-a', status: 'completed' };

test('an FLA relays the person\'s words and the task closes as theirs, naming the relaying FLA', async () => {
  const { port, calls } = closing();
  const delegation = createAgentDelegation(null);
  const closed = await post(port, { ...BODY, note: 'Config synced on both machines.' },
    { headers: relayedCall(WORDS), delegation });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'completed');
  assert.deepEqual(calls, [{ path: '/v1/project-agent-tasks/task-a/close', review: true, body: {
    personal_space_id: 'personal-space', personal_project_id: 'project-a', status: 'completed',
    summary: '「这个任务做完了，可以关掉」 Config synced on both machines.',
    relayed_by: 'fla-b', source_application: 'claude_code', source_session_id: 'session-b' } }]);
  const [operation] = delegation.read().operations;
  assert.equal(operation.route, ROUTE);
  assert.equal(operation.relayed.words, WORDS.words);
});

test('without the person\'s words, or with Relay your decisions off, nothing closes', async () => {
  const { port, calls } = closing();
  const unworded = await post(port, BODY, { headers: relayedCall(null) });
  assert.equal(unworded.body.code, 'person_words_required');
  const off = createAgentDelegation(null);
  off.setCategory('decisions', false);
  const refused = await post(port, BODY, { headers: relayedCall(WORDS), delegation: off });
  assert.equal(refused.body.code, 'delegation_category_off');
  assert.match(refused.body.error, /设置 › AI 权限 › 转达你的决定/);
  assert.match(refused.body.error, /Settings › AI permissions › Relay your decisions/);
  assert.deepEqual(calls, []);
});

test('a bare assent relayed as the person\'s words does not close a task', async () => {
  const { port, calls } = closing();
  for (const words of ['可以', '好的！', 'OK.', 'okay', 'Yes!', 'sure', '嗯嗯', '行吧', 'go ahead', '没问题']) {
    const refused = await post(port, BODY, { headers: relayedCall({ ...WORDS, words }) });
    assert.equal(refused.status, 400, words);
    assert.equal(refused.body.code, 'person_words_not_a_close', words);
    assert.match(refused.body.error, /in their own words that the task is done or cancelled/);
  }
  assert.deepEqual(calls, []);
  assert.equal((await post(port, BODY, { headers: relayedCall({ ...WORDS, words: '取消这个任务吧' }) })).status, 200);
  // Short is fine when it says so itself.
  for (const words of ['做完了', '取消吧', 'done']) assert.notEqual((await post(port, BODY, { headers: relayedCall({ ...WORDS, words }) })).body.code, 'person_words_not_a_close', words);
});

test('the person\'s own close, bad input and a remote caller', async () => {
  const { port, calls } = closing();
  const own = await post(port, { ...BODY, status: 'cancelled' });
  assert.equal(own.status, 200);
  assert.deepEqual(calls[0].body, { personal_space_id: 'personal-space', personal_project_id: 'project-a',
    status: 'cancelled', summary: 'Closed by the person in FULI.' });
  for (const body of [{ ...BODY, status: 'failed' }, { ...BODY, personalSpaceId: 'someone-else' },
    { ...BODY, personalProjectId: undefined }, { ...BODY, note: 42 }]) {
    assert.equal((await post(port, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post(port, BODY, { remoteAddress: '192.168.1.20' })).status, 403);
  assert.equal((await post(null, BODY)).status, 503);
  assert.equal(calls.length, 1);
});

test('closing as the person is a relayed decision only the console reaches', () => {
  const entry = agentInterfaceCatalog().uiMutationParity.find(({ route }) => route === ROUTE);
  assert.equal(entry.access, 'agent_relayed');
  assert.equal(entry.category, 'decisions');
  const writing = ['src/task-closing/console-port.js', 'src/http/task-close-api-router.js'].map((path) => join(ROOT, path));
  for (const entryPoint of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    const modules = reachableModules(join(ROOT, entryPoint));
    assert.deepEqual(writing.filter((path) => modules.has(path)), [], entryPoint);
  }
  // Every permission's refusal names its own switch.
  for (const { id } of DELEGATION_CATEGORIES) assert.match(categoryOffRefusal(id).message, /AI permissions › \S/);
});
