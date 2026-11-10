import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskContextRegistry } from './fixtures/in-memory-task-context-registry.js';
import { checkpointTaskKnowledge } from '../src/graphiti/task-knowledge-checkpoint.js';
import { currentCheckpointWorkLog } from '../src/graphiti/checkpoint-amendment.js';

// rec#85: a checkpoint sent too early is corrected by an explicit amendment,
// never by overwriting it. Synthetic identities only; no Provider or data dir.
function scenario() {
  const taskContextRegistry = new TaskContextRegistry();
  const task = taskContextRegistry.begin({ sessionId: 'synthetic-session',
    personalProjectId: 'synthetic-project', projectAgentId: 'synthetic-worker',
    sourceApplication: 'codex', workLogRequired: true });
  // A synthetic conversation port records each appended summary event.
  const events = [];
  const capture = { enabled: true };
  const app = { taskContextRegistry, config: { personal: { spaceId: 'synthetic-space' } },
    getCapturePolicy: () => ({ enabled: capture.enabled }), listProjectAgents: async () => [],
    personal: { getProjectAgent: async () => null, conversation: async (operation, input) => {
      events.push(...input.events.map(event => ({ id: event.event_id, content: event.content })));
      return { status: 'saved', conversation_id: 'synthetic-conversation' };
    } } };
  const early = { taskContextToken: task.token, sourceApplication: 'codex', disposition: 'retain_nothing',
    reason: 'Nothing new.', workLog: { status: 'no_change', summary: 'No message needed a reply.' } };
  const corrected = { ...early, reason: 'A late message needed a reply.',
    workLog: { status: 'completed', summary: 'Answered the late synthetic deadline question.' } };
  return { app, task, early, corrected, events, capture };
}

test('a changed second checkpoint is still refused, and the refusal names amend', async () => {
  const { app, task, early, corrected } = scenario();
  await checkpointTaskKnowledge(app, early);
  await assert.rejects(checkpointTaskKnowledge(app, corrected), error =>
    /different input/.test(error.message) && /amend: true/.test(error.message));
  assert.equal(app.taskContextRegistry.context(task.token, 'codex').checkpoint.amendments, undefined);
});

test('an amendment appends the corrected work log and keeps the original as history', async () => {
  const { app, task, early, corrected } = scenario();
  await checkpointTaskKnowledge(app, early);
  const result = await checkpointTaskKnowledge(app, { ...corrected, amend: true });
  assert.equal(result.status, 'amended');
  assert.equal(result.amendment, 1);
  assert.equal(result.replayed, undefined);
  assert.ok(result.agent_receipt);
  const stored = app.taskContextRegistry.context(task.token, 'codex').checkpoint;
  assert.deepEqual(stored.workLog, early.workLog);
  assert.deepEqual(stored.amendments.map(item => item.work_log), [corrected.workLog]);
  assert.deepEqual(currentCheckpointWorkLog({ work_log: early.workLog, amendments: stored.amendments }), corrected.workLog);
  assert.deepEqual(currentCheckpointWorkLog({ work_log: early.workLog }), early.workLog);
  // A retry of the same amendment replays it; the original's own retry still replays too.
  const retry = await checkpointTaskKnowledge(app, { ...corrected, amend: true });
  assert.equal(retry.replayed, true);
  assert.equal(retry.amendment, 1);
  assert.equal((await checkpointTaskKnowledge(app, early)).replayed, true);
  // amend with the original's own input is that checkpoint's replay, not an amendment.
  assert.equal((await checkpointTaskKnowledge(app, { ...early, amend: true })).status, 'checkpointed');
});

test('an amendment cannot change capture decisions or arrive before the checkpoint', async () => {
  const { app, early, corrected } = scenario();
  await assert.rejects(checkpointTaskKnowledge(app, { ...corrected, amend: true }), /Nothing to amend yet/);
  await checkpointTaskKnowledge(app, early);
  await assert.rejects(checkpointTaskKnowledge(app, { ...corrected, amend: true,
    remember: [{ kind: 'project_fact', text: 'Synthetic fact.' }] }), /only reason and workLog.*remember/);
  await assert.rejects(checkpointTaskKnowledge(app, { ...corrected, amend: true, collaborators: ['synthetic-peer'] }),
    /collaborators/);
  await assert.rejects(checkpointTaskKnowledge(app, { ...corrected, amend: true,
    disposition: 'capture_candidates' }), /keeps the checkpoint disposition retain_nothing/);
  await assert.rejects(checkpointTaskKnowledge(app, { ...corrected, amend: true, workLog: null }), /workLog summary/);
});

test('only the same session\'s current task can be amended', async () => {
  const { app, early, corrected } = scenario();
  await checkpointTaskKnowledge(app, early);
  await assert.rejects(checkpointTaskKnowledge(app, { ...corrected, amend: true, sourceApplication: 'cursor' }),
    /unknown or superseded/);
  await assert.rejects(checkpointTaskKnowledge(app, { ...corrected, amend: true, remoteSessionId: 'other-session' }),
    /another remote session/);
  app.taskContextRegistry.begin({ sessionId: 'synthetic-session', personalProjectId: 'synthetic-project',
    projectAgentId: 'synthetic-worker', sourceApplication: 'codex' });
  await assert.rejects(checkpointTaskKnowledge(app, { ...corrected, amend: true }), /unknown or superseded/);
});

test('a retry of an older amendment uses its own stored entry and event', async () => {
  const { app, task, early, corrected, events } = scenario();
  await checkpointTaskKnowledge(app, early);
  const second = { ...corrected, workLog: { status: 'failed', summary: 'The synthetic reply bounced.' } };
  await checkpointTaskKnowledge(app, { ...corrected, amend: true });
  await checkpointTaskKnowledge(app, { ...second, amend: true });
  const replay = await checkpointTaskKnowledge(app, { ...corrected, amend: true });
  assert.equal(replay.replayed, true);
  assert.equal(replay.amendment, 1);
  assert.deepEqual(events.slice(1).map(event => [event.id, event.content]), [
    [`${task.token}:amendment:1`, corrected.workLog.summary],
    [`${task.token}:amendment:2`, second.workLog.summary],
    [`${task.token}:amendment:1`, corrected.workLog.summary]]);
});

test('each amendment keeps its own capture decision across retries', async () => {
  const { app, task, early, corrected, events, capture } = scenario();
  await checkpointTaskKnowledge(app, early);
  // Off when amended, on when retried: the retry never records the off-period words.
  capture.enabled = false;
  const off = await checkpointTaskKnowledge(app, { ...corrected, amend: true });
  assert.equal(off.conversation.status, 'capture_disabled');
  capture.enabled = true;
  const retried = await checkpointTaskKnowledge(app, { ...corrected, amend: true });
  assert.equal(retried.replayed, true);
  assert.equal(retried.conversation.status, 'capture_disabled');
  const stored = app.taskContextRegistry.context(task.token, 'codex').checkpoint.amendments[0];
  assert.match(stored.reason, /^Capture was off for this task/);
  assert.doesNotMatch(JSON.stringify(stored), /late synthetic deadline/);
  assert.equal(events.some(event => /late synthetic deadline/.test(event.content)), false);
  // On when amended, off when retried: nothing more is appended while off.
  const later = { ...corrected, workLog: { status: 'completed', summary: 'Second synthetic correction.' } };
  await checkpointTaskKnowledge(app, { ...later, amend: true });
  const appended = events.length;
  capture.enabled = false;
  assert.equal((await checkpointTaskKnowledge(app, { ...later, amend: true })).conversation.status, 'capture_disabled');
  assert.equal(events.length, appended);
});

test('a checkpoint kept with capture off is amended without words even after capture is back on', async () => {
  const { app, task, early, corrected, events, capture } = scenario();
  capture.enabled = false;
  await checkpointTaskKnowledge(app, early);
  capture.enabled = true;
  const amended = await checkpointTaskKnowledge(app, { ...corrected, amend: true });
  assert.equal(amended.conversation.status, 'capture_disabled');
  const stored = app.taskContextRegistry.context(task.token, 'codex').checkpoint.amendments[0];
  assert.match(stored.work_log.summary, /^Capture was off for this task/);
  assert.equal(events.length, 0);
});
