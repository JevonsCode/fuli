import test from 'node:test';
import assert from 'node:assert/strict';
import { beginConversation, checkpointConversation, resumeConversation } from '../src/graphiti/agent-conversations.js';

const task = { token: 'fuli-task-example', sessionId: 'native-session', personalProjectId: 'sample', projectAgentId: 'engineer', sourceApplication: 'codex' };
function fixture() {
  const calls = [];
  const app = { config: { personal: { spaceId: 'personal' } }, getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: { context: async () => task },
    personal: { conversation: async (operation, input) => {
      calls.push({ operation, input });
      if (operation === 'append') return { status: 'saved', conversation_id: 'conversation-one', revision: 1 };
      if (input.mode === 'session') return { conversation_id: 'conversation-one', cursor: 0 };
      if (input.mode === 'context') return { context: { summary: 'Prior result', messages: [] } };
      return { status: 'resumed' };
    } } };
  return { app, calls };
}
test('entry restores before appending and writes exact task identity', async () => {
  const { app, calls } = fixture();
  const result = await beginConversation(app, task, 'continue');
  assert.equal(result.status, 'saved');
  assert.equal(calls[1].input.mode, 'context');
  assert.equal(calls.at(-1).input.task_context_token, task.token);
  assert.deepEqual(calls.at(-1).input.events, [], 'task entry must not duplicate the native transcript prompt');
});
test('disabled capture writes no conversation data', async () => {
  const { app, calls } = fixture(); app.getCapturePolicy = () => ({ enabled: false });
  assert.equal((await beginConversation(app, task, 'private')).status, 'capture_disabled');
  assert.equal(calls.length, 0);
});
test('a new chat recovers the same Agent’s latest conversation without merging its identity', async () => {
  const { app, calls } = fixture();
  const original = app.personal.conversation;
  app.personal.conversation = async (operation, input) => {
    if (input.mode === 'session') return { conversation_id: null };
    if (input.mode === 'list') return { conversations: [{ id: 'earlier-chat' }] };
    return original(operation, input);
  };
  const result = await beginConversation(app, task, 'new task');
  assert.equal(result.recovered_from, 'earlier-chat');
  assert.equal(result.conversation_id, 'conversation-one');
  assert.equal(result.recovery.summary, 'Prior result');
  assert.equal(calls[0].input.agent_id, task.projectAgentId);
  assert.equal(calls[0].input.personal_project_id, task.personalProjectId);
});
test('checkpoint receipt is not saved when provider fails', async () => {
  const { app } = fixture(); app.personal.conversation = async () => { throw new Error('offline'); };
  const result = await checkpointConversation(app, task, { summary: 'done', status: 'completed' });
  assert.equal(result.status, 'unsaved');
  assert.equal(result.conversation_id, undefined);
});
test('resume uses current task binding, not caller supplied project or session', async () => {
  const { app, calls } = fixture();
  await resumeConversation(app, { taskContextToken: task.token, conversationId: 'previous', sourceApplication: 'codex' });
  assert.equal(calls[0].input.session_id, task.sessionId);
  assert.equal(calls[0].input.agent_id, task.projectAgentId);
});

test('compact hook preserves full instructions but does not duplicate history', async () => {
  const { compactTaskContext } = await import('../src/conversations/task-context-view.js');
  const instruction = 'Important exact instruction '.repeat(200);
  const source = { effective_preferences: [{ instruction, confirmation_basis: { evidence: 'x'.repeat(10000) } }],
    project_agent_context: { memory: { revision: 4, current: { memory: { summary: 'memo'.repeat(1000), decisions: [], openThreads: [], nextActions: [] } }, history: [{ data:'x'.repeat(5000) }] } } };
  const view = compactTaskContext(source);
  assert.equal(view.effective_preferences[0].instruction, instruction);
  assert.equal(view.project_agent_context.memory.revision, 4);
  assert.equal(view.project_agent_context.memory.requiresFullReadBeforeWrite, true);
  assert.ok(JSON.stringify(view).length < JSON.stringify(source).length / 2);
});
