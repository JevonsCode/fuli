import assert from 'node:assert/strict';
import test from 'node:test';

import { attentionRecord } from '../src/graphiti/agent-attention.js';
import { projectAgentTaskBlocker, projectAgentTaskRecord } from '../src/graphiti/project-agent-mapping.js';
import { clearSessionTaskBlockers } from '../src/graphiti/task-blocker-progress.js';

const SESSION = '3b241101-e2bb-4255-8caf-4136c566a962';
const PROCESS_SESSION = 'fuli-host-0d1f2e3c-4b5a-4697-8a9b-0c1d2e3f4a5b';
const blocker = (session) => ({ reason: 'Need the staging database name.', since: '2026-10-27T08:05:00Z',
  agent_id: 'synthetic-engineer', source_application: 'codex', source_session_id: session, source_session_url: null });

test('a block names the client session the person can return to, and only such a session', () => {
  assert.deepEqual(projectAgentTaskBlocker(blocker(SESSION)), { reason: 'Need the staging database name.',
    since: '2026-10-27T08:05:00Z', agentId: 'synthetic-engineer', application: 'codex', sessionId: SESSION,
    sessionUrl: null, observed: true });
  // An identity FULI gave its own MCP process is no conversation: not shown, progress not observable.
  const process = projectAgentTaskBlocker(blocker(PROCESS_SESSION));
  assert.equal(process.sessionId, null);
  assert.equal(process.observed, false);
  assert.equal(projectAgentTaskBlocker(null), null);
});

test('task records and attention requests carry the block, and events say why one ended', () => {
  const task = projectAgentTaskRecord({ task_id: 'task-a', status: 'blocked', blocker: blocker(SESSION),
    events: [{ event_id: 'event-a', task_id: 'task-a', status: 'running', summary: 'Unblocked.', blocker_cleared_by: 'session_reply' }] });
  assert.equal(task.blocker.sessionId, SESSION);
  assert.equal(task.events[0].blockerClearedBy, 'session_reply');
  const request = attentionRecord({ request_id: 'request-a', task_id: 'task-a', kind: 'blocked', task_blocker: blocker(SESSION) });
  assert.equal(request.taskId, 'task-a');
  assert.equal(request.taskBlocker.reason, 'Need the staging database name.');
  assert.equal(Object.hasOwn(request, 'task_blocker'), false);
});

test('progress in a client session asks the Provider to end the blocks that session reported', async () => {
  const calls = [];
  const application = { config: { personal: { spaceId: 'synthetic-space' } }, personal: {
    async clearSessionTaskBlockers(input) {
      calls.push(input);
      if (input.source_session_id === 'failing-session') throw new Error('Provider unavailable');
      return { cleared_task_ids: ['task-a'] };
    }
  } };
  const cleared = await clearSessionTaskBlockers(application, { sourceApplication: 'codex',
    sessionIds: [SESSION, SESSION, PROCESS_SESSION, null, 'failing-session'], cause: 'session_reply', captureAllowed: true });
  assert.deepEqual(cleared, ['task-a']);
  assert.deepEqual(calls.map(call => call.source_session_id), [SESSION, 'failing-session']);
  assert.deepEqual(calls[0], { personal_space_id: 'synthetic-space', source_application: 'codex',
    source_session_id: SESSION, cause: 'session_reply' });
  // With recording off for that session nothing is written; nor without the Provider route.
  calls.length = 0;
  assert.deepEqual(await clearSessionTaskBlockers(application, { sourceApplication: 'codex', sessionIds: [SESSION],
    cause: 'session_activity', captureAllowed: false }), []);
  assert.deepEqual(calls, []);
  assert.deepEqual(await clearSessionTaskBlockers({ personal: {} }, { sourceApplication: 'codex', sessionIds: [SESSION],
    cause: 'session_activity', captureAllowed: true }), []);
});
