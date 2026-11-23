import assert from 'node:assert/strict';
import test from 'node:test';
import { REPEAT_GUIDANCE, repeatComplaint } from '../src/graphiti/task-repeat-signal.js';
import { entryRules } from '../src/conversations/entry-rules.js';

// Jevons 11-24: "I already did X, why don't you Y" is a keep signal.
// Every sentence of the #1071 review is here, as a hit or as a miss.
const HITS = [
  // Earlier list
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
  '你怎么又用 npm 了',
  // The review's misses
  '都说了别用 any',
  '之前不是让你用 pnpm 吗',
  '我前面已经把端口改了你怎么还在用 3000',
  '跟你讲了多少回了',
  '我之前让你别动配置',
  '你又把测试删了',
  '又来了，还是 npm',
  '说好的不要加注释呢',
  '上次你就是这么改坏的',
  '老是忘记加 changelog',
  '第三次了，别再用 npm',
  '不是跟你说了吗',
  '讲了好几次了',
  '我前面已经说清楚了，你怎么还这样',
  // English
  'I already told you to keep the commit messages in English.',
  "I've said this before: never touch the lockfile.",
  'As I said earlier, the staging port is 4611.',
  "Didn't I tell you to use pnpm here?",
  'How many times do I have to ask for tests?',
  "I already renamed the file, why didn't you update the import?",
  'You keep forgetting the changelog.',
  'I told you to use pnpm.',
  'I said no semicolons.',
  "I've told you twice now",
  'As I mentioned, use tabs.',
  'Like I said, no mocks.',
  'I asked you before to keep it short.',
  'You forgot the tests again.',
  'Stop using npm, I mentioned it already.',
  'We talked about this, use pnpm.',
  'Again, please use pnpm.',
  'how many times have you been told'
];

const MISSES = [
  // Plain questions and progress notes
  '为什么这里不用 Redis？',
  '为什么你不用 Promise.all？',
  '我已经提交了代码，你看一下。',
  '我已经装了 node，为什么还不能运行？',
  '我已经装了 node，为什么你的脚本还是报错？',
  '上次的构建失败了，再看看。',
  '我们之前讨论的方案是什么？',
  '我写了一个函数，帮我看看。',
  '我提了一个 PR。',
  '这事我说了算。',
  'Why not use Redis here?',
  "Why don't you split this into two functions?",
  'I already pushed the branch. Can you review it?',
  'Try again with the new token.',
  'As discussed, here is the spec.',
  // The review's false hits
  '我之前说过要用 Redis，但现在想换成 Postgres，你觉得呢？',
  '上次跟你说过的那个方案，我们再评估一下利弊。',
  '之前讲了两种部署方式，第二种的步骤是什么？',
  '前面提了一个问题，现在补充一下上下文',
  '你看之前说了半天的那个 bug 现在复现了吗',
  '我刚才说了，你继续',
  '如果我已经说了要回滚，那流程应该是什么？',
  '我明明说了要改成 3000，结果还是 8080，是不是配置缓存了？',
  'I already said in the PR description why this is needed, can you review?',
  'You keep using the word "simply" in the docs, please grep for it.',
  // System failures, not the Agent
  '怎么又没网了',
  '怎么还没跑完？',
  '怎么还不行',
  '怎么又报错了？',
  // Someone else's words
  'PM 说"我说过这个需求要下周上"，你排一下期。',
  '面试官问我：怎么又用 var 了？这题怎么答？',
  'The customer wrote: didn\'t I tell you to cancel my order?',
  'Write a test where the user says "how many times do I have to repeat this".',
  '帮我写个 regex 匹配 "I already told you"',
  // Pasted logs, tickets and reports
  '用户反馈：我已经说过了，客服还是没回。帮我分析这条工单。',
  '日志：\nERROR user said: I already told you the password is wrong\n帮我看看这个报错',
  '报告里写着「说了很多次的问题：内存泄漏」，总结一下'
];

test('the person saying they already asked for it is a keep signal, in Chinese and English', () => {
  assert.deepEqual(HITS.filter(prompt => !repeatComplaint(prompt)), []);
});

test('questions, progress notes, system failures, quotes, logs and requests about the words are not', () => {
  assert.deepEqual(MISSES.filter(prompt => repeatComplaint(prompt)), []);
});

test('only the person\'s own words count, not a quoted host reminder or a pasted report', () => {
  assert.equal(repeatComplaint('<system-reminder>我已经说过了</system-reminder>\n修一下样式。'), false);
  assert.equal(repeatComplaint('```\nI already told you\n```\nWhat does this test print?'), false);
});

test('the guidance says how to keep it, how to avoid a duplicate and how to ask by clicking', () => {
  for (const text of [REPEAT_GUIDANCE, entryRules().sections.task_guidance.repeat_signal]) {
    assert.match(text, /checkpoint_task_knowledge remember/);
    assert.match(text, /not delivered/);
    assert.match(text, /workLog/);
    assert.match(text, /clickable choices/);
    // A false hit costs nothing more than this paragraph: no keep, no question.
    assert.match(text, /keep nothing, ask nothing/);
    // What is kept is pending until the person confirms it, and an unclear scope does not interrupt them.
    assert.match(text, /waiting for their confirmation/);
    assert.match(text, /never (?:say )?that it is remembered|never say it is remembered/);
    assert.match(text, /scope unsure/);
  }
  // Sent only on a matching turn.
  assert.ok(REPEAT_GUIDANCE.length < 800, String(REPEAT_GUIDANCE.length));
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
