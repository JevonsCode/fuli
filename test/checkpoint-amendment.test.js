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
  const app = { taskContextRegistry, config: { personal: { spaceId: 'synthetic-space' } },
    getCapturePolicy: () => ({ enabled: true }), listProjectAgents: async () => [] };
  const early = { taskContextToken: task.token, sourceApplication: 'codex', disposition: 'retain_nothing',
    reason: 'Nothing new.', workLog: { status: 'no_change', summary: 'No message needed a reply.' } };
  const corrected = { ...early, reason: 'A late message needed a reply.',
    workLog: { status: 'completed', summary: 'Answered the late synthetic deadline question.' } };
  return { app, task, early, corrected };
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
  assert.equal(result.amendments, 1);
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
  assert.equal(retry.amendments, 1);
  assert.equal((await checkpointTaskKnowledge(app, early)).replayed, true);
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
