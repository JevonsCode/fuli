import assert from 'node:assert/strict';
import test from 'node:test';

import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { TaskContextRegistry } from './fixtures/in-memory-task-context-registry.js';

function scenario(recordKnowledgeUsage) {
  const taskContextRegistry = new TaskContextRegistry();
  const task = taskContextRegistry.begin({ sessionId: 'synthetic-session', personalProjectId: 'synthetic-project',
    projectAgentId: null, sourceApplication: 'codex' });
  const app = { taskContextRegistry, config: { personal: { spaceId: 'synthetic-space' } },
    listProjectAgents: async () => [], recordKnowledgeUsage };
  return { app, task, input: { taskContextToken: task.token, sourceApplication: 'codex',
    disposition: 'retain_nothing', reason: 'No new confirmed knowledge.' } };
}
const usage = [{ itemId: 'item-1', itemKind: 'entity', useKind: 'applied' }];

test('a checkpoint records knowledge usage for its own task without a separate call', async () => {
  const calls = [];
  const { app, task, input } = scenario(async (request) => { calls.push(request); return { recorded: 1 }; });
  const result = await checkpointTaskKnowledge(app, { ...input, knowledgeUsage: usage });
  assert.deepEqual(calls, [{ personalSpaceId: 'synthetic-space', taskId: task.token, sessionId: 'synthetic-session',
    toolName: 'checkpoint_task_knowledge', items: usage }]);
  assert.deepEqual(result.knowledge_usage, { status: 'recorded', result: { recorded: 1 } });

  // A replay records the same idempotent events again; different usage is a different checkpoint.
  const replay = await checkpointTaskKnowledge(app, { ...input, knowledgeUsage: usage });
  assert.equal(replay.replayed, true);
  await assert.rejects(checkpointTaskKnowledge(app, { ...input,
    knowledgeUsage: [{ ...usage[0], useKind: 'cited' }] }), /different input/);
});

test('a usage failure is reported and never undoes the checkpoint', async () => {
  const { app, task, input } = scenario(async () => { throw Object.assign(new Error('down'), { code: 'provider_unavailable' }); });
  const result = await checkpointTaskKnowledge(app, { ...input, knowledgeUsage: usage });
  assert.equal(result.status, 'checkpointed');
  assert.deepEqual(result.knowledge_usage, { status: 'failed', items: 1, error: 'provider_unavailable' });
  assert.equal(app.taskContextRegistry.context(task.token, 'codex').checkpoint.phase, 'complete');

  const plain = scenario(async () => { throw new Error('unused'); });
  const none = await checkpointTaskKnowledge(plain.app, plain.input);
  assert.equal(none.knowledge_usage, undefined);
});
