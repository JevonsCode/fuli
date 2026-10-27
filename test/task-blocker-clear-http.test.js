import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { handleTaskBlockerRequest } from '../src/http/task-blocker-api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { taskBlockerConsole } from '../src/task-blockers/console-port.js';
import { reachableModules } from '../test-support/module-graph.js';

// 标记为已解除: the person ends a block whose session will never continue.
// Synthetic Provider: it records what the console sent and answers like it.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const app = { config: { personal: { spaceId: 'personal-space' } } };
const CLEARED = {
  task_id: 'task-a', personal_space_id: 'personal-space', personal_project_id: 'project-a', title: 'Synthetic task',
  status: 'running', participants: [],
  events: [
    { event_id: 'e1', task_id: 'task-a', status: 'blocked', actor_kind: 'agent', summary: 'Need the region.',
      created_at: '2026-10-11T08:00:00Z' },
    { event_id: 'e2', task_id: 'task-a', status: 'running', actor_kind: 'human', summary: 'Solved by hand.',
      blocker_cleared_by: 'person', blocker_clear_note: 'Solved by hand.', created_at: '2026-10-28T08:00:00Z' },
  ],
};

function blockers(reply = () => ({ status: 200, body: CLEARED })) {
  const calls = [];
  const port = taskBlockerConsole('synthetic-data-dir', { send: async (path, body, options) => {
    calls.push({ path, body, ...options });
    const { status, body: payload } = reply();
    return { ok: status < 400, status, payload };
  } });
  return { port, calls };
}

async function post(port, path, body, remoteAddress = '127.0.0.1') {
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', headers: { 'content-type': 'application/json' }, socket: { remoteAddress } });
  try {
    const handled = await handleTaskBlockerRequest({ request, response,
      url: new URL(`http://127.0.0.1${path}`), app, blockerConsole: port });
    return { handled, ...sent };
  } catch (error) {
    return { handled: true, ...mapHttpError(error) };
  }
}

const PATH = '/api/project-agent-tasks/task-a/blocker/clear';

test('the clear goes to the Provider on the human-review channel and returns the task with its history', async () => {
  const { port, calls } = blockers();
  const cleared = await post(port, PATH,
    { personalSpaceId: 'personal-space', personalProjectId: 'project-a', note: '  Solved by hand.  ' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.status, 'running');
  assert.deepEqual(cleared.body.events.at(-1).blockerClearedBy, 'person');
  assert.equal(cleared.body.events.at(-1).blockerClearNote, 'Solved by hand.');
  const blank = await post(port, PATH, { personalSpaceId: 'personal-space', personalProjectId: 'project-a', note: ' ' });
  assert.equal(blank.status, 200);
  assert.deepEqual(calls, [
    { path: '/v1/project-agent-tasks/task-a/blocker/clear', review: true,
      body: { personal_space_id: 'personal-space', personal_project_id: 'project-a', note: 'Solved by hand.' } },
    { path: '/v1/project-agent-tasks/task-a/blocker/clear', review: true,
      body: { personal_space_id: 'personal-space', personal_project_id: 'project-a', note: null } },
  ]);
});

test('a task that is no longer blocked comes back with the Provider\'s refusal', async () => {
  const { port } = blockers(() => ({ status: 409, body: { detail: 'the task is no longer blocked; reload it' } }));
  const refused = await post(port, PATH, { personalSpaceId: 'personal-space', personalProjectId: 'project-a' });
  assert.equal(refused.status, 409);
});

test('bad input and another space are refused before reaching the Provider', async () => {
  const { port, calls } = blockers();
  for (const body of [
    { personalSpaceId: 'someone-else', personalProjectId: 'project-a' },
    { personalSpaceId: 'personal-space' },
    { personalSpaceId: 'personal-space', personalProjectId: 'project-a', note: 'x'.repeat(501) },
    { personalSpaceId: 'personal-space', personalProjectId: 'project-a', note: 42 },
  ]) {
    assert.equal((await post(port, PATH, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});

test('only the person marks a block cleared: on this computer, never by an Agent tool', async () => {
  const { port, calls } = blockers();
  const remote = await post(port, PATH, { personalSpaceId: 'personal-space', personalProjectId: 'project-a' },
    '192.168.1.20');
  assert.equal(remote.status, 403);
  assert.equal(remote.body.code, 'local_user_only');
  const unavailable = await post(null, PATH, { personalSpaceId: 'personal-space', personalProjectId: 'project-a' });
  assert.equal(unavailable.status, 503);
  assert.equal(calls.length, 0);
  const entry = agentInterfaceCatalog().uiMutationParity
    .find(({ route }) => route === 'POST /api/project-agent-tasks/:taskId/blocker/clear');
  assert.equal(entry.access, 'local_user_only');
  assert.deepEqual(listAgentTools().filter(({ name }) => /unblock|blocker/.test(name)), []);
  // The Agent's own status report cannot claim the person's clear either.
  const activity = listAgentTools().find(({ name }) => name === 'record_project_agent_task_activity');
  assert.equal(JSON.stringify(activity.inputSchema).includes('blockerClearedBy'), false);
  const writing = ['src/task-blockers/console-port.js', 'src/http/task-blocker-api-router.js']
    .map((path) => join(ROOT, path));
  for (const entryPoint of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    const modules = reachableModules(join(ROOT, entryPoint));
    assert.deepEqual(writing.filter((path) => modules.has(path)), [], entryPoint);
  }
});
