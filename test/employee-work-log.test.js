import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { TaskContextRegistry } from '../src/mcp/task-context-registry.js';
import { agentMemoryView } from '../src/graphiti/project-agent-memory.js';

function scenario() {
  const taskContextRegistry = new TaskContextRegistry();
  const task = taskContextRegistry.begin({ sessionId: 'synthetic-session',
    personalProjectId: 'synthetic-project', projectAgentId: 'synthetic-worker',
    sourceApplication: 'codex', workLogRequired: true });
  return { app: { taskContextRegistry }, task,
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
  await assert.rejects(checkpointTaskKnowledge(app, {
    ...input, workLog: { ...workLog, status: 'completed' }
  }), /different input/);
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
