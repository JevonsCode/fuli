import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTO_CLOSE_SUMMARY, stopHookOutcome } from '../src/conversations/stop-auto-close.js';

const source = { sourceApplication: 'codex', sourceSessionId: 'session-1' };

test('nothing pending means nothing to do', async () => {
  const calls = [];
  assert.deepEqual(await stopHookOutcome({ status: 'checkpointed' }, async name => calls.push(name), source), {});
  assert.deepEqual(calls, []);
});

test('a fallback task the Provider does not mark closable keeps the reminder and is never closed by the hook', async () => {
  const calls = [];
  for (const eligible of [undefined, false, 'true']) {
    const result = await stopHookOutcome({ decision: 'block', reason: 'Checkpoint pending', task_context_token: 't', entry_via: 'tool',
      routine_auto_close_eligible: eligible }, async name => calls.push(name), source);
    assert.deepEqual(result, { systemMessage: 'Checkpoint pending' });
  }
  assert.deepEqual(calls, []);
});

test('a routine fallback the Provider marks closable is closed at Stop, so a one-shot session is not left open', async () => {
  let sent;
  const result = await stopHookOutcome({ decision: 'block', reason: 'x', task_context_token: 't', entry_via: 'tool',
    routine_auto_close_eligible: true }, async (name, input) => { sent = { name, input }; }, source);
  assert.deepEqual(result, {});
  assert.equal(sent.name, 'checkpoint_task_knowledge');
  assert.deepEqual(sent.input, { taskContextToken: 't', disposition: 'retain_nothing', reason: AUTO_CLOSE_SUMMARY,
    workLog: { status: 'reported', summary: AUTO_CLOSE_SUMMARY }, ...source });
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

test('hook and eligible routine fallback entries allow a finish without a model checkpoint', async () => {
  const { beginTaskFromPreferences } = await import('../src/graphiti/agent-knowledge-workflows.js');
  const { taskRecord } = await import('../src/mcp/provider-task-context-registry.js');
  const sent = [];
  const application = { config: { personal: { spaceId: 'space' } }, taskContextRegistry: {
    begin: async input => { sent.push(input.entryVia); return taskRecord({ token: 'fuli-task-synthetic-1', session_id: 's',
      personal_project_id: null, routine_auto_close_eligible: true,
      entry_via: input.entryVia === 'hook' ? 'hook' : 'tool' }); } } };
  const preferences = { context: { personal_project_id: null, project_agent_id: null }, effective_preferences: [] };
  const viaHook = await beginTaskFromPreferences(application, preferences, { sessionId: 's' }, { entryVia: 'hook' });
  assert.equal(viaHook.checkpoint_required, false);
  assert.match(viaHook.checkpoint_guidance, /Stop hook closes the task/);
  const viaTool = await beginTaskFromPreferences(application, preferences, { sessionId: 's' });
  assert.equal(viaTool.checkpoint_required, false);
  assert.match(viaTool.checkpoint_guidance, /next entry.*same native session/);
  assert.match(viaTool.checkpoint_guidance, /capture|workLog/);
  assert.deepEqual(sent, ['hook', 'tool']);
});

test('a request to remember something is never auto-closed and says to record it in FULI', async () => {
  const { beginTaskFromPreferences } = await import('../src/graphiti/agent-knowledge-workflows.js');
  const { taskRecord } = await import('../src/mcp/provider-task-context-registry.js');
  const application = { config: { personal: { spaceId: 'space' } }, taskContextRegistry: {
    begin: async () => taskRecord({ token: 'fuli-task-synthetic-2', session_id: 's', personal_project_id: null,
      routine_auto_close_eligible: true, entry_via: 'hook' }) } };
  const preferences = { context: { personal_project_id: null, project_agent_id: null }, effective_preferences: [] };
  const remembering = await beginTaskFromPreferences(application, preferences,
    { sessionId: 's', taskPrompt: '记住这个项目的 Cobalt 发布设定：region west-7。' }, { entryVia: 'hook' });
  assert.equal(remembering.checkpoint_required, true);
  assert.equal('checkpoint_guidance' in remembering, false);
  assert.match(remembering.remember_guidance, /checkpoint_task_knowledge remember/);
  const ordinary = await beginTaskFromPreferences(application, preferences,
    { sessionId: 's', taskPrompt: '修一下登录页的样式。' }, { entryVia: 'hook' });
  assert.equal(ordinary.checkpoint_required, false);
  assert.equal('remember_guidance' in ordinary, false);
});
