import assert from 'node:assert/strict';
import test from 'node:test';
import { handleKnowledgeItemRequest } from '../src/http/knowledge-item-api-router.js';

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

const LINK = 'http://127.0.0.1:2828/knowledge/project/space-1/directory';

test('rec#88: what the reply cites through a FULI source link is recorded as use, at no cost to the model', async () => {
  let sent;
  const reply = `**[🌠 FULI · 知识增强](${LINK}/entity/item-a)**\n\nDone. - [Title](${LINK}/relationship/item%2Fb) and again [x](${LINK}/entity/item-a).`;
  await stopHookOutcome({ decision: 'block', reason: 'x', task_context_token: 't', entry_via: 'hook' },
    async (name, input) => { sent = input; }, source, { reply });
  assert.deepEqual(sent.knowledgeUsage, [{ itemId: 'item-a', itemKind: 'entity', useKind: 'cited' },
    { itemId: 'item/b', itemKind: 'relationship', useKind: 'cited' }]);
});

test('rec#88: a reply with no source link, or one from elsewhere, reports nothing', async () => {
  for (const reply of [undefined, null, 'Done.', '[x](https://example.test/knowledge/project/s/directory/entity/item-a)']) {
    let sent;
    await stopHookOutcome({ decision: 'block', reason: 'x', task_context_token: 't', entry_via: 'hook' },
      async (name, input) => { sent = input; }, source, { reply });
    assert.equal(Object.hasOwn(sent, 'knowledgeUsage'), false, String(reply));
  }
});

test('rec#88: a cited link the store refuses still closes the task', async () => {
  const sent = [];
  const result = await stopHookOutcome({ decision: 'block', reason: 'x', task_context_token: 't', entry_via: 'hook' }, async (name, input) => {
    sent.push(input);
    if (input.knowledgeUsage) throw new Error('knowledge item not found');
  }, source, { reply: `[x](${LINK}/entity/gone)` });
  assert.deepEqual(result, {});
  assert.equal(sent.length, 2);
  assert.equal(Object.hasOwn(sent[1], 'knowledgeUsage'), false);
});

test('rec#88: the console reads how often shown knowledge was used, counts only', async () => {
  const asked = [];
  const answer = { tasks: 4, shown: 9, used: 2, byRank: [] };
  let body = '';
  const response = { setHeader() {}, writeHead() {}, end(text) { body = text; } };
  const app = { recallImpressions: { summary: (input) => { asked.push(input); return answer; } } };
  const url = new URL('http://127.0.0.1/api/knowledge/recall-usage?personalSpaceId=space-1');
  assert.equal(await handleKnowledgeItemRequest({ request: { method: 'GET' }, response, url, app }), true);
  assert.deepEqual(asked, [{ personalSpaceId: 'space-1', personalProjectId: null }]);
  assert.deepEqual(JSON.parse(body), answer);

  await handleKnowledgeItemRequest({ request: { method: 'GET' }, response, url, app: {} });
  assert.deepEqual(JSON.parse(body), { tasks: 0, shown: 0, used: 0, byRank: [] });
});
