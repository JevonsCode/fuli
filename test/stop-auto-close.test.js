import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTO_CLOSE_SUMMARY, stopHookOutcome } from '../src/conversations/stop-auto-close.js';

const source = { sourceApplication: 'codex', sourceSessionId: 'session-1' };

test('nothing pending means nothing to do', async () => {
  const calls = [];
  assert.deepEqual(await stopHookOutcome({ status: 'checkpointed' }, async name => calls.push(name), source), {});
  assert.deepEqual(calls, []);
});

test('a task opened by the MCP fallback keeps the reminder and is never closed by the hook', async () => {
  const calls = [];
  const result = await stopHookOutcome({ decision: 'block', reason: 'Checkpoint pending', task_context_token: 't', entry_via: 'tool' },
    async name => calls.push(name), source);
  assert.deepEqual(result, { systemMessage: 'Checkpoint pending' });
  assert.deepEqual(calls, []);
});

test('a hook-delivered task is closed as retain_nothing with an honest reported log', async () => {
  let sent;
  const result = await stopHookOutcome({ decision: 'block', reason: 'x', task_context_token: 't', entry_via: 'hook' },
    async (name, input) => { sent = { name, input }; }, source);
  assert.deepEqual(result, {});
  assert.equal(sent.name, 'checkpoint_task_knowledge');
  assert.deepEqual(sent.input, { taskContextToken: 't', disposition: 'retain_nothing', reason: AUTO_CLOSE_SUMMARY,
    workLog: { status: 'reported', summary: AUTO_CLOSE_SUMMARY }, ...source });
});

test('a failed auto-close falls back to the reminder', async () => {
  const result = await stopHookOutcome({ decision: 'block', reason: 'Checkpoint pending', task_context_token: 't', entry_via: 'hook' },
    async () => { throw new Error('provider down'); }, source);
  assert.deepEqual(result, { systemMessage: 'Checkpoint pending' });
});

test('only a hook-delivered task relaxes the checkpoint requirement and names the rule', async () => {
  const { beginTaskFromPreferences } = await import('../src/graphiti/agent-knowledge-workflows.js');
  const { taskRecord } = await import('../src/mcp/provider-task-context-registry.js');
  const sent = [];
  const application = { config: { personal: { spaceId: 'space' } }, taskContextRegistry: {
    begin: async input => { sent.push(input.entryVia); return taskRecord({ token: 'fuli-task-synthetic-1', session_id: 's',
      personal_project_id: null, entry_via: input.entryVia === 'hook' ? 'hook' : 'tool' }); } } };
  const preferences = { context: { personal_project_id: null, project_agent_id: null }, effective_preferences: [] };
  const viaHook = await beginTaskFromPreferences(application, preferences, { sessionId: 's' }, { entryVia: 'hook' });
  assert.equal(viaHook.checkpoint_required, false);
  assert.match(viaHook.checkpoint_guidance, /Stop hook closes the task as retain_nothing/);
  const viaTool = await beginTaskFromPreferences(application, preferences, { sessionId: 's' });
  assert.equal(viaTool.checkpoint_required, true);
  assert.equal('checkpoint_guidance' in viaTool, false);
  assert.deepEqual(sent, ['hook', 'tool']);
});
