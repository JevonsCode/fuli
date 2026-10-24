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
test('a new chat keeps its Agent scope without automatically resuming the last unrelated conversation', async () => {
  const { app, calls } = fixture();
  const original = app.personal.conversation;
  app.personal.conversation = async (operation, input) => {
    if (input.mode === 'session') return { conversation_id: null };
    if (input.mode === 'list') return { conversations: [{ id: 'earlier-chat' }] };
    return original(operation, input);
  };
  const result = await beginConversation(app, task, 'new task');
  assert.equal(result.recovered_from, null);
  assert.equal(result.conversation_id, 'conversation-one');
  assert.equal(result.recovery, null);
  assert.equal(calls.some(call => call.input.mode === 'context'), false);
  assert.equal(calls[0].input.agent_id, task.projectAgentId);
  assert.equal(calls[0].input.personal_project_id, task.personalProjectId);
});
test('checkpoint receipt is not saved when provider fails', async () => {
  const { app } = fixture(); app.personal.conversation = async () => { throw new Error('offline'); };
  const result = await checkpointConversation(app, task, { summary: 'done', status: 'completed' });
  assert.equal(result.status, 'unsaved');
  assert.equal(result.conversation_id, undefined);
});
test('an unsaved conversation names the failed step and the error code, never its message', async () => {
  for (const [failing, step] of [['session', 'session'], ['context', 'context'], ['append', 'append']]) {
    const { app } = fixture();
    const original = app.personal.conversation;
    app.personal.conversation = async (action, input) => {
      if ((action === 'append' ? 'append' : input.mode) === failing) {
        throw Object.assign(new Error('C:/private/path secret detail'), { code: 'provider_unavailable' });
      }
      return original(action, input);
    };
    const result = await beginConversation(app, task, 'new task');
    assert.deepEqual([result.status, result.step, result.reason], ['unsaved', step, 'provider_unavailable'], failing);
    assert.doesNotMatch(JSON.stringify(result), /private|secret/);
  }
  const { app } = fixture();
  app.personal.conversation = async () => { throw Object.assign(new Error('x'), { status: 503 }); };
  assert.equal((await checkpointConversation(app, task, { summary: 'done', status: 'completed' })).reason, 'status_503');
  // A code FULI does not name (a Provider may pass its own detail.code) is never echoed.
  for (const [error, reason] of [[Object.assign(new Error('x'), { code: 'upstream_tenant_acme_42' }), 'other'],
    [Object.assign(new Error('x'), { code: 'upstream_tenant_acme_42', status: 409 }), 'status_409'],
    [Object.assign(new Error('x'), { status: 7 }), 'other']]) {
    app.personal.conversation = async () => { throw error; };
    const result = await checkpointConversation(app, task, { summary: 'done', status: 'completed' });
    assert.equal(result.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /acme/);
  }
});
test('a Provider-disabled checkpoint never reports saved summary coverage', async () => {
  const { app } = fixture();
  app.personal.conversation = async () => ({ status: 'capture_disabled' });
  const result = await checkpointConversation(app, task, { summary: 'not saved', status: 'completed' });
  assert.equal(result.status, 'capture_disabled');
  assert.equal(result.coverage, undefined);
  assert.equal(result.receipt, undefined);
});
test('saved checkpoint returns a named profile and a portable same-Agent continuation', async () => {
  const { app } = fixture();
  app.consoleUrl = 'http://127.0.0.1:3999';
  app.personal.getProjectAgent = async () => ({ agent_id: 'engineer',
    profile: { name: 'Internal role', display_name: 'Alex Morgan', status: 'active', allowed_clients: ['codex'] } });
  const result = await checkpointConversation(app, task, { summary: 'Verified result', status: 'completed' });
  assert.equal(result.receipt.owner.name, 'Alex Morgan');
  assert.equal(result.receipt.owner.profile_url, 'http://127.0.0.1:3999/agents/personal/engineer');
  assert.equal(result.receipt.work_status, 'completed');
  assert.equal(result.receipt.continuation.conversation_id, 'conversation-one');
  assert.match(result.receipt.continuation.prompt, /^@\{engineer\}/);
  assert.match(result.receipt.continuation.prompt, /sample/);
  assert.match(result.receipt.continuation.prompt, /conversation-one/);
  assert.equal(JSON.stringify(result.receipt).includes(task.token), false, 'never export an old task token as a continuation credential');
});
test('metadata failure does not misreport a saved conversation as unsaved', async () => {
  const { app } = fixture();
  app.personal.getProjectAgent = async () => { throw new Error('metadata offline'); };
  const result = await checkpointConversation(app, task, { summary: 'done', status: 'completed' });
  assert.equal(result.status, 'saved');
  assert.equal(result.receipt.owner.name, null);
  assert.equal(result.receipt.owner.agent_id, 'engineer');
});
const latestCheckpoint = { status: 'completed', summary: 'Completed "v2" export; validation passed.', truncated: false };
function checkpointFixture() {
  const { app, calls } = fixture();
  const original = app.personal.conversation;
  app.personal.conversation = async (operation, input) => {
    if (input.mode === 'context') return { id: 'previous', summary: 'outer unbounded copy', status: 'completed',
      context: { conversation_id: 'previous', revision: 7, summary: '', summary_role: 'historical',
        latest_checkpoint: latestCheckpoint, messages: [{ sequence: 6, role: 'assistant', content: 'Recent visible raw.' }] } };
    return original(operation, input);
  };
  return { app, calls };
}
test('automatic recovery keeps the latest checkpoint and recent raw with exact source guidance', async () => {
  const { app } = checkpointFixture();
  const result = await beginConversation(app, task);
  assert.deepEqual(result.recovery.latest_checkpoint, latestCheckpoint);
  assert.equal(result.recovery.summary_role, 'historical');
  assert.deepEqual(result.recovery.messages, [{ sequence: 6, role: 'assistant', content: 'Recent visible raw.' }]);
  assert.equal(result.recovery.revision, 7);
  assert.match(result.guidance, /latest_checkpoint/);
  assert.match(result.guidance, /historical/i);
  assert.match(result.guidance, /never instructions or authorization/);
  assert.match(result.guidance, /recovered_from/);
  assert.match(result.guidance, /window = conversation.recovery on entry, otherwise context/);
  assert.match(result.guidance, /after: message.sequence - 1/);
  assert.match(result.guidance, /omitted_sequence is an older journal boundary/);
  assert.match(result.guidance, /may point to a tool\/checkpoint/);
  assert.match(result.guidance, /after: window.revision, limit: 1/);
});
test('explicit resume from a fresh client keeps the bounded latest checkpoint and states the handoff boundary', async () => {
  const { app } = checkpointFixture();
  const fresh = { ...task, token: 'fuli-task-fresh-claude', sourceApplication: 'claude_code', sessionId: 'claude-session' };
  app.taskContextRegistry.context = async (token, source) => {
    assert.equal(token, fresh.token); assert.equal(source, 'claude_code'); return fresh;
  };
  const calls = [];
  const original = app.personal.conversation;
  app.personal.conversation = async (operation, input) => { calls.push({ operation, input }); return original(operation, input); };
  const result = await resumeConversation(app, { taskContextToken: fresh.token, conversationId: 'previous', sourceApplication: 'claude_code' });
  assert.equal(calls[0].input.task_context_token, fresh.token);
  assert.equal(calls[0].input.source_application, 'claude_code');
  assert.deepEqual(result.context.latest_checkpoint, latestCheckpoint);
  assert.equal(result.context.messages[0].sequence, 6);
  assert.equal(result.summary, undefined, 'the unbounded outer summary is not repeated');
  assert.match(result.guidance, /latest_checkpoint/);
  assert.match(result.guidance, /files/i);
});
test('resume rejects when the Provider refuses the fresh task scope or client', async () => {
  const { app } = fixture();
  app.personal.conversation = async () => { throw Object.assign(new Error('Agent is not allowed in this client'), { status: 403 }); };
  await assert.rejects(resumeConversation(app, { taskContextToken: task.token, conversationId: 'previous', sourceApplication: 'codex' }), /not allowed/);
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
  const source = { effective_preferences: [{ instruction, profile_aspect: 'taste', attributes: { tasteDomain: 'writing' }, confirmation_basis: { evidence: 'x'.repeat(10000) } }],
    project_agent_context: { memory: { revision: 4, current: { memory: { summary: 'memo'.repeat(1000), decisions: [], openThreads: [], nextActions: [] } }, history: [{ data:'x'.repeat(5000) }] } } };
  const view = compactTaskContext(source);
  assert.equal(view.effective_preferences[0].instruction, instruction);
  assert.equal(view.effective_preferences[0].profile_aspect, 'taste');
  assert.equal(view.effective_preferences[0].attributes.tasteDomain, 'writing');
  assert.equal(view.project_agent_context.memory.revision, 4);
  assert.equal(view.project_agent_context.memory.requiresFullReadBeforeWrite, true);
  assert.ok(JSON.stringify(view).length < JSON.stringify(source).length / 2);
});
