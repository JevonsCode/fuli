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

test('an event that is not a record is skipped instead of failing the whole list', async () => {
  const { handled, status, body } = await listed([task('task-a', 'running', {
    events: [null, undefined, 'not an event', event('e1', 'codex', '00000000-0000-4000-8000-000000000009', '2026-11-01T08:00:00Z')],
  })]);
  assert.deepEqual([handled, status], [true, 200]);
  assert.deepEqual(body[0].sessions, [{ client: 'codex', sessionId: '00000000-0000-4000-8000-000000000009' }]);
});

test('one client however its name is written, and other takes no place', async () => {
  const { body } = await listed([task('task-a', 'running', {
    sourceApplication: 'Codex',
    events: [
      event('e1', 'other', 'session-other', '2026-11-01T08:00:00Z'),
      event('e2', 'claude-code', 'session-older', '2026-11-02T08:00:00Z'),
      event('e3', 'Claude Code', 'session-newer', '2026-11-03T08:00:00Z'),
    ],
  })]);
  // `claude-code` and `Claude Code` are one client, whose newest session stands;
  // `other` would show nothing in the console, and the task's own `Codex` is the same client.
  assert.deepEqual(body[0].sessions, [
    { client: 'claude_code', sessionId: 'session-newer' },
    { client: 'codex', sessionId: null },
  ]);
});

test('stops reading older events once three clients each have a session', async () => {
  let olderReads = 0;
  const older = event('e0', 'kiro', 'session-kiro', '2026-10-31T08:00:00Z');
  // Non-enumerable, so only the walk itself reads it (the response's JSON does not).
  Object.defineProperty(older, 'sourceApplication', { enumerable: false, get() { olderReads += 1; return 'kiro'; } });
  const { status, body } = await listed([task('task-a', 'running', {
    events: [
      older,
      event('e1', 'codex', '00000000-0000-4000-8000-000000000001', '2026-11-01T08:00:00Z'),
      event('e2', 'cursor', 'session-cursor', '2026-11-02T08:00:00Z'),
      event('e3', 'claude_code', 'session-claude', '2026-11-03T08:00:00Z'),
    ],
  })]);
  assert.equal(status, 200);
  assert.deepEqual(body[0].sessions.map(session => session.client), ['claude_code', 'cursor', 'codex']);
  assert.equal(olderReads, 0);
});

test('nothing is guessed: no client or a finished task names none; a client known only by FULI\'s own process session is listed without a session', async () => {
  const { body } = await listed([
    task('old', 'running'),
    task('no-client', 'running', { events: [event('e1', null, 'session-x', '2026-11-01T08:00:00Z')] }),
    task('process', 'running', { events: [event('e1', 'cursor', 'fuli-host-00000000-0000-4000-8000-000000000002', '2026-11-01T08:00:00Z')] }),
    task('done', 'completed', { sourceApplication: 'codex', sourceSessionId: 'session-done' }),
    // The real session of a client wins over its process session, whichever was reported later.
    task('both', 'running', { sourceApplication: 'codex', sourceSessionId: 'session-real',
      events: [event('e1', 'codex', 'fuli-host-00000000-0000-4000-8000-000000000003', '2026-11-01T09:00:00Z')] }),
  ]);
  assert.deepEqual(body.map(row => row.sessions), [[], [], [{ client: 'cursor', sessionId: null }], [],
    [{ client: 'codex', sessionId: 'session-real' }]]);
});
