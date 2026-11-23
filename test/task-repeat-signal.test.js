import assert from 'node:assert/strict';
import test from 'node:test';
import { REPEAT_GUIDANCE, repeatComplaint } from '../src/graphiti/task-repeat-signal.js';
import { entryRules } from '../src/conversations/entry-rules.js';

// Jevons 11-24: "I already did X, why don't you Y" is a keep signal.
test('the person saying they already asked for it is a keep signal, in Chinese and English', () => {
  for (const prompt of [
    '我已经说过了，提交信息用英文。',
    '我早就讲了，别动 lockfile。',
    '我已经把端口改成 4611 了，为什么你还不用？',
    '上次就说过，这个项目用 pnpm。',
    '之前不是讲过了吗，表格不要加边框',
    '不是跟你说过了，测试只用虚构数据',
    '说了多少遍了，不要在主干上改',
    '我跟你说过这个接口要带分页',
    '我说过别用 any。',
    '怎么又忘了加测试？',
    '怎么又用 npm 了',
    'I already told you to keep the commit messages in English.',
    "I've said this before: never touch the lockfile.",
    'As I said earlier, the staging port is 4611.',
    "Didn't I tell you to use pnpm here?",
    'How many times do I have to ask for tests?',
    "I already renamed the file, why didn't you update the import?",
    'You keep forgetting the changelog.'
  ]) assert.equal(repeatComplaint(prompt), true, prompt);
});

test('ordinary questions, plain statements and system failures are not, so they pay nothing', () => {
  for (const prompt of [
    '为什么这里不用 Redis？',
    '为什么你不用 Promise.all？',
    '我已经提交了代码，你看一下。',
    '我已经装了 node，为什么还不能运行？',
    '我已经装了 node，为什么你的脚本还是报错？',
    '上次的构建失败了，再看看。',
    '怎么又报错了？',
    '我们之前讨论的方案是什么？',
    '我写了一个函数，帮我看看。',
    '我提了一个 PR。',
    '这事我说了算。',
    'Why not use Redis here?',
    "Why don't you split this into two functions?",
    'I already pushed the branch. Can you review it?',
    'Try again with the new token.',
    'As discussed, here is the spec.'
  ]) assert.equal(repeatComplaint(prompt), false, prompt);
});

test('only the person\'s own words count, not a quoted host reminder or a pasted report', () => {
  assert.equal(repeatComplaint('<system-reminder>我已经说过了</system-reminder>\n修一下样式。'), false);
});

test('the guidance says how to keep it, how to avoid a duplicate and how to ask by clicking', () => {
  for (const text of [REPEAT_GUIDANCE, entryRules().sections.task_guidance.repeat_signal]) {
    assert.match(text, /checkpoint_task_knowledge remember/);
    assert.match(text, /not delivered/);
    assert.match(text, /workLog/);
    assert.match(text, /clickable choices/);
  }
  // Sent only on a matching turn; it stays well under one ordinary preference line set.
  assert.ok(REPEAT_GUIDANCE.length < 700, String(REPEAT_GUIDANCE.length));
});

test('a repeat complaint is never auto-closed and carries the guidance; an ordinary turn carries nothing', async () => {
  const { beginTaskFromPreferences } = await import('../src/graphiti/agent-knowledge-workflows.js');
  const { taskRecord } = await import('../src/mcp/provider-task-context-registry.js');
  const application = { config: { personal: { spaceId: 'space' } }, taskContextRegistry: {
    begin: async () => taskRecord({ token: 'fuli-task-synthetic-repeat', session_id: 's', personal_project_id: null,
      routine_auto_close_eligible: true, entry_via: 'hook' }) } };
  const preferences = { context: { personal_project_id: null, project_agent_id: null }, effective_preferences: [] };
  const repeating = await beginTaskFromPreferences(application, preferences,
    { sessionId: 's', taskPrompt: '上次就说过，这个项目用 pnpm。' }, { entryVia: 'hook' });
  assert.equal(repeating.checkpoint_required, true);
  assert.equal(repeating.remember_guidance, REPEAT_GUIDANCE);
  const question = await beginTaskFromPreferences(application, preferences,
    { sessionId: 's', taskPrompt: '为什么这里不用 pnpm？' }, { entryVia: 'hook' });
  assert.equal(question.checkpoint_required, false);
  assert.equal('remember_guidance' in question, false);
});
