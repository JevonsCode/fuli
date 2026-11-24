import { withCheckpointSaveStatus } from '../src/graphiti/checkpoint-save-status.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { TaskContextRegistry } from './fixtures/in-memory-task-context-registry.js';
import { agentMemoryView } from '../src/graphiti/project-agent-memory.js';

function scenario() {
  const taskContextRegistry = new TaskContextRegistry();
  const task = taskContextRegistry.begin({ sessionId: 'synthetic-session',
    personalProjectId: 'synthetic-project', projectAgentId: 'synthetic-worker',
    sourceApplication: 'codex', workLogRequired: true });
  const app = { taskContextRegistry, config: { personal: { spaceId: 'synthetic-space' } },
    getCapturePolicy: () => ({ enabled: true }), listProjectAgents: async () => [] };
  return { app, task,
    input: { taskContextToken: task.token, sourceApplication: 'codex',
      disposition: 'retain_nothing', reason: 'No new confirmed knowledge.' } };
}

test('skipping knowledge capture cannot silently omit an employee work record', async () => {
  const { app, task, input } = scenario();
  await assert.rejects(checkpointTaskKnowledge(app, input), /workLog summary/);
  assert.equal(app.taskContextRegistry.context(task.token, 'codex').checkpoint, null);
});

test('work results survive checkpointing even without a new distilled memory revision', async () => {
  const { app, task, input } = scenario();
  const workLog = { status: 'incomplete', summary: 'Implemented the reader; recovery still needs testing.' };
  await checkpointTaskKnowledge(app, { ...input, workLog });
  const stored = app.taskContextRegistry.context(task.token, 'codex');
  assert.deepEqual(stored.checkpoint.workLog, workLog);
  assert.equal(stored.agentMemory, null);
  assert.equal((await checkpointTaskKnowledge(app, { ...input, workLog })).replayed, true);
  // Changed content on the closed task is refused before any write, as the
  // task_closed status an Agent can act on (checkpoint-save-status.js).
  const refused = await withCheckpointSaveStatus(checkpointTaskKnowledge(app, {
    ...input, workLog: { ...workLog, status: 'completed' }
  }));
  assert.deepEqual([refused.status, refused.reason], ['checkpoint_not_saved', 'task_closed']);
  assert.deepEqual(app.taskContextRegistry.context(task.token, 'codex').checkpoint.workLog, workLog);
});

test('cross-client memory projection includes work history when distilled memory is empty', () => {
  const view = agentMemoryView({ revision: 0, current: null, history: [], work_log: [{
    task_context_token: 'synthetic-task', source_application: 'claude_code', session_id: 'synthetic-cc',
    created_at: '2026-09-16T00:00:00Z', status: 'failed', summary: 'The build failed.', memory_updated: false
  }] });
  assert.equal(view.current, null);
  assert.deepEqual(view.workLog[0], { taskContextToken: 'synthetic-task', sourceApplication: 'claude_code',
    sessionId: 'synthetic-cc', createdAt: '2026-09-16T00:00:00Z', status: 'failed',
    summary: 'The build failed.', memoryUpdated: false });
});
