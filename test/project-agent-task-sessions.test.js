import assert from 'node:assert/strict';
import test from 'node:test';

import { handleGraphApiRequest } from '../src/http/graph-api-router.js';

// 今天's 正在干活 shows which client each open task runs in. Synthetic task
// records only; the application double answers the one list read.
const event = (id, client, sessionId, at) => ({ eventId: id, taskId: 'task-a', status: 'running', actorKind: 'agent',
  summary: 'Synthetic progress', sourceApplication: client, sourceSessionId: sessionId, createdAt: at });
const task = (taskId, status, extra = {}) => ({ taskId, personalSpaceId: 'space-a', personalProjectId: 'project-a',
  title: `Synthetic ${taskId}`, status, participants: [], sourceApplication: null, sourceSessionId: null, events: [], ...extra });

async function listed(tasks) {
  const reads = [];
  const app = { listProjectAgentTasks: async (input) => { reads.push(input); return tasks; } };
  let status; let body;
  const response = { setHeader() {}, writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
  const handled = await handleGraphApiRequest({ request: { method: 'GET' }, response, app,
    url: new URL('http://127.0.0.1/api/project-agent-tasks?personalSpaceId=space-a&limit=200') });
  return { handled, status, body, reads };
}

test('an open task names its clients from its own records, one latest session each, latest first, at most three', async () => {
  const { handled, status, body, reads } = await listed([task('task-a', 'running', {
    sourceApplication: 'claude_code', sourceSessionId: 'session-origin',
    events: [
      event('e1', 'codex', '00000000-0000-4000-8000-000000000001', '2026-11-01T08:00:00Z'),
      event('e2', 'cursor', 'session-cursor', '2026-11-02T08:00:00Z'),
      event('e3', 'codex', '00000000-0000-4000-8000-000000000003', '2026-11-03T08:00:00Z'),
      event('e4', 'kiro', 'session-kiro', '2026-11-04T08:00:00Z'),
    ],
  })]);
  assert.deepEqual([handled, status, reads.length], [true, 200, 1]);
  // Codex reported from two sessions: its latest stands for it. The fourth client is left out.
  assert.deepEqual(body[0].sessions, [
    { client: 'kiro', sessionId: 'session-kiro' },
    { client: 'codex', sessionId: '00000000-0000-4000-8000-000000000003' },
    { client: 'cursor', sessionId: 'session-cursor' },
  ]);
  // The rest of the row is what the list already said.
  assert.equal(body[0].title, 'Synthetic task-a');
});

test('the session a task came from counts when no progress named one', async () => {
  const { body } = await listed([task('task-b', 'queued', { sourceApplication: 'claude_code', sourceSessionId: 'session-origin' })]);
  assert.deepEqual(body[0].sessions, [{ client: 'claude_code', sessionId: 'session-origin' }]);
});

test('nothing is guessed: no session, a session without its client, FULI\'s own process session or a finished task name none', async () => {
  const { body } = await listed([
    task('old', 'running'),
    task('no-client', 'running', { events: [event('e1', null, 'session-x', '2026-11-01T08:00:00Z')] }),
    task('process', 'running', { events: [event('e1', 'cursor', 'fuli-host-00000000-0000-4000-8000-000000000002', '2026-11-01T08:00:00Z')] }),
    task('done', 'completed', { sourceApplication: 'codex', sourceSessionId: 'session-done' }),
  ]);
  assert.deepEqual(body.map(row => row.sessions), [[], [], [], []]);
});
