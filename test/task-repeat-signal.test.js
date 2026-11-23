import assert from 'node:assert/strict';
import test from 'node:test';
import { REPEAT_GUIDANCE, repeatComplaint } from '../src/graphiti/task-repeat-signal.js';
import { entryRules } from '../src/conversations/entry-rules.js';

// Jevons 11-24: "I already did X, why don't you Y" is a keep signal. A match is
// a candidate the Agent judges (REPEAT_GUIDANCE), so recall comes first: the
// shape of the sentence decides, whatever verb follows 不/没/还/又.
const HITS = [
  // Earlier rounds
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
  '早就跟你讲过，别动 lockfile',
  '我都说了三遍了',
  '咋又用 npm 了',
  '上次不是说好了',
  // Jevons's own words, both word orders (the second round)
  '我已经把端口改了，为什么你不用新端口',
  '我已经装好依赖了，为什么你不直接跑',
  '我已经给了你文档链接了，你为什么不看',
  '我已经在 CLAUDE.md 里写了用 pnpm，你为什么还用 npm',
  // The third review's own list: all fifteen, the seven it missed first
  '我明明把接口文档发给你了，你怎么不看呢',
  '我已经把端口改成 8080 了，为什么不用新端口？',
  '我已经把 README 更新了呀，为什么你还按旧的来',
  '我已经把方案定了，为什么你不执行？',
  '我已经说了 commit 前要 rebase 了，为啥你不 rebase',
  '我已经告诉过你密钥放在 .env 了，你为什么还硬编码',
  '我都讲了要先读 AGENTS.md，你咋还是不读',
  '我已经说了用 pnpm，你为什么还在用 npm',
  '我都告诉你了别改配置文件，你怎么还改',
  '我刚说了不要加注释，你又加了',
  'I already told you to use pnpm, why are you still using npm?',
  '我已经提醒过你了，为什么你还是不跑测试',
  '我已经让你先跑测试再提交了，你为什么不做',
  '我已经告诉你要用中文回复了，你为什么不用中文啊',
  '我已经说过不要用 any 了吗？你怎么还用',
  // ... and its other probes: asked of the Agent, or answered by the next sentence
  '我已经说过不要用 any 了吗？怎么还在用',
  '我说过别用 any 吗？怎么又用了',
  '我已经跟你说过别用 any 了吗？你还用',
  '我已经说了，你为什么不按我说的做',
  '我已经交代了，为什么你还是这样',
  '我已经说了，你怎么还不改',
  'I already said use pnpm. Why are you using npm?',
  'I already told you to use pnpm, why do you keep using npm?',
  // Unseen before this round: spoken, mixed with English, without a subject
  '我不是早就跟你说了要先跑 lint 吗，怎么又直接提交了',
  '都跟你讲过了 PR 描述要写英文，你还写中文',
  '刚才让你别动 package.json，你咋又动了',
  '我上次就把部署步骤写进 README 了，为啥你还要问我',
  '明明跟你说过只改前端，你为什么把后端也改了',
  '我都 review 过三次了，你还是没把那个 typo 改掉',
  '我已经 approve 了，为什么你还不 merge',
  '之前给你看过截图了，你怎么还是按旧设计做',
  '跟你说了八百遍了，commit message 用英文',
  'I already told you the API key goes in .env, why is it hardcoded again?',
  'I said tabs, not spaces. Why are you still using spaces?',
  'I asked you to run the tests first, yet you pushed without them.',
  '我昨天已经把需求文档发群里了，你为什么不看呢',
  '我已经强调过不要 force push，为什么你又 force push 了',
  '已经告诉你端口是 4611 了，怎么还连 3000',
  '我早就把 eslint 配好了，你为什么不跑一下',
  '我这都第三遍说了，测试要用虚构数据，你还用真名',
  '不是说好每次改完都更新 changelog 吗？你又忘了',
  '我刚刚已经把 token 换成新的了，你为啥还在用旧的',
  '上次跟你说的命名规范，你怎么一个都没遵守',
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

// The third review's verb probe: whatever the skipped work is called.
const VERBS = ['做', '执行', '处理', '换', '检查', '回复', '回答', '部署', '推', '重启', '确认', '动', '试', '管', '理',
  '遵守', '照做', '测试', '提交', 'rebase', 'merge'];

// Never a candidate: someone else's words or subject, quotes, logs, code, a
// condition or a request about the words, and turns with only one half.
const MISSES = [
  '为什么这里不用 Redis？',
  '为什么你不用 Promise.all？',
  '我已经提交了代码，你看一下。',
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
  '我之前说过要用 Redis，但现在想换成 Postgres，你觉得呢？',
  '上次跟你说过的那个方案，我们再评估一下利弊。',
  '之前讲了两种部署方式，第二种的步骤是什么？',
  '前面提了一个问题，现在补充一下上下文',
  '你看之前说了半天的那个 bug 现在复现了吗',
  '我刚才说了，你继续',
  '如果我已经说了要回滚，那流程应该是什么？',
  '我明明说了要改成 3000，结果还是 8080，是不是配置缓存了？',
  '你怎么还没回复',
  '你又不是人，别客气',
  '老板又来了，还是那个需求，帮我拆一下',
  '我说过别用 any 吗？记不清了',
  '我提了两次 PR，都被拒了',
  '我已经把端口改了，为什么你的页面还是打不开？',
  '早就想跟你说一件事',
  '之前不是说好的价格吗，商家怎么涨了',
  '咋还在加载',
  '我讲了两遍课',
  '你怎么还没睡',
  '你又没错，别道歉',
  'I already said in the PR description why this is needed, can you review?',
  'You keep using the word "simply" in the docs, please grep for it.',
  '怎么还没跑完？',
  '怎么还不行',
  // Someone else's words or subject
  'PM 说"我说过这个需求要下周上"，你排一下期。',
  '面试官问我：怎么又用 var 了？这题怎么答？',
  'The customer wrote: didn\'t I tell you to cancel my order?',
  'PM 说：我已经说过了，为什么你们还不改',
  'PM说：我已经说过了，为什么你们还不改',
  'Lisa 说：我都说了别用弹窗',
  '老板已经说过三遍了，可是需求还是没定',
  '他已经说了好几次了，你看着办',
  '同事又把测试删了，烦死了',
  'The customer wrote: I already told you to stop emailing me.',
  // Requests about the words, conditions
  'Write a test where the user says "how many times do I have to repeat this".',
  '帮我写个 regex 匹配 "I already told you"',
  '如果我已经说过了，你为什么不照做？',
  // Pasted logs, tickets, reports and code
  '用户反馈：我已经说过了，客服还是没回。帮我分析这条工单。',
  '用户反馈：我都说了别用弹窗',
  '日志：\nERROR user said: I already told you the password is wrong\n帮我看看这个报错',
  '报告里写着「说了很多次的问题：内存泄漏」，总结一下',
  '[ERROR] 2026-11-24 handler: 我已经说过了 why not',
  '```\n// 我已经说过别用 any，你怎么还用\n```',
  // The rest of the third review's list
  '我已经重启了服务，为什么你的脚本还是报错',
  '我已经把代码推上去了，为什么 CI 还没跑完',
  '部署进度怎么样了？',
  '今天天气不错，你吃饭了吗',
  '我已经说过要用 Redis 了吗？我记不清了',
  '请帮我用 pnpm 安装依赖',
  '以后都用中文回复我',
  '我已经改好了配置，你直接跑一下测试吧',
  '测试为什么没跑过？',
  'Why is the build still failing after I restarted it?',
  '我已经升级到 0.29 了，为什么你的工具列表里还是旧的',
  // Unseen before this round
  '产品经理已经说过三次了，为什么这个需求还没排期',
  '如果用户说"我已经告诉过你了"，客服应该怎么回？',
  '帮我写一句提醒：我已经说过不要用 any，你为什么还用',
  '他已经跟你说过两遍了，你为什么还不改',
  '日志：[WARN] user: I already told you, why don\'t you retry? 帮我看看',
  '老板：我都说了好几遍了，你们怎么还没上线？帮我想想怎么回',
  '我已经提醒过他了，他为什么还不改？',
  'Our PM said: I already told you, why don\'t you ship it?',
  '```\n我已经说过了，你为什么还用 npm\n```\n这段注释要删吗',
  '> 我已经说过了，为什么你又改坏了\n上面是用户的投诉，帮我写个回复'
];

// The same shape as a complaint, another meaning: these are candidates on
// purpose, and REPEAT_GUIDANCE tells the Agent to ignore them (docs/fla-self-growth.md).
const CANDIDATES_THE_AGENT_IGNORES = [
  '我已经看过你的方案了，你为什么不用 Redis？',
  '我已经写了一半了，你为什么不先看看再改？',
  '我已经吃过了，为什么你不吃',
  "I already pushed the branch, why don't you open the PR now?",
  '我已经装了 node，为什么还不能运行？',
  '我已经发了，你为什么没收到？',
  '你怎么又不说话了，卡住了吗',
  '怎么又没网了',
  '咋又没网了',
  '怎么又报错了？'
];

test('the person saying they already asked for it is a candidate, in Chinese and English', () => {
  assert.deepEqual(HITS.filter(prompt => !repeatComplaint(prompt)), []);
});

test('whatever verb follows 不/没/还/又, Chinese or English, with or without 你', () => {
  const misses = VERBS.flatMap(verb => [`我已经说了，为什么你不${verb}`, `我已经把文档发你了，你为什么不${verb}`,
    `我已经说了，为什么不${verb}`]).filter(prompt => !repeatComplaint(prompt));
  assert.deepEqual(misses, []);
});

test('someone else\'s words, quotes, logs, code, conditions and one half alone are never candidates', () => {
  assert.deepEqual(MISSES.filter(prompt => repeatComplaint(prompt)), []);
});

test('the same shape with another meaning is a candidate the Agent is told to ignore', () => {
  assert.deepEqual(CANDIDATES_THE_AGENT_IGNORES.filter(prompt => !repeatComplaint(prompt)), []);
  assert.match(REPEAT_GUIDANCE, /^Maybe they told you this before and you did not follow it\. Judge that first; if not, ignore this, do nothing\./);
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
    // What is kept is pending until the person confirms it, and an unclear scope does not interrupt them.
    assert.match(text, /(?:waiting for|awaits) their confirmation/);
    assert.match(text, /never (?:say )?that it is remembered|never say it is remembered/);
    assert.match(text, /scope unsure/);
  }
  // A candidate the Agent rejects costs nothing more than this paragraph: no keep, no question.
  assert.match(REPEAT_GUIDANCE, /ignore this, do nothing/);
  assert.match(entryRules().sections.task_guidance.repeat_signal, /you judge it\. .*keep nothing, ask nothing/);
  // Sent only on a matching turn, as the actions alone; the reasons live in the rule it names.
  assert.match(REPEAT_GUIDANCE, /rule: task_guidance\.repeat_signal/);
  // Never longer than the 513 characters of the round before.
  assert.ok(REPEAT_GUIDANCE.length <= 512, String(REPEAT_GUIDANCE.length));
});

test('a candidate the Agent does nothing about closes as usual: the guidance rides along, the turn is not held open', async () => {
  const { beginTaskFromPreferences } = await import('../src/graphiti/agent-knowledge-workflows.js');
  const { taskRecord } = await import('../src/mcp/provider-task-context-registry.js');
  const { stopHookOutcome } = await import('../src/conversations/stop-auto-close.js');
  const { STOP_HOOK_CHECKPOINT_GUIDANCE } = await import('../src/graphiti/task-knowledge-guidance.js');
  const application = { config: { personal: { spaceId: 'space' } }, taskContextRegistry: {
    begin: async () => taskRecord({ token: 'fuli-task-synthetic-repeat', session_id: 's', personal_project_id: null,
      routine_auto_close_eligible: true, entry_via: 'hook' }) } };
  const preferences = { context: { personal_project_id: null, project_agent_id: null }, effective_preferences: [] };
  const repeating = await beginTaskFromPreferences(application, preferences,
    { sessionId: 's', taskPrompt: '我已经看过你的方案了，你为什么不用 Redis？' }, { entryVia: 'hook' });
  assert.equal(repeating.remember_guidance, REPEAT_GUIDANCE);
  assert.equal(repeating.checkpoint_required, false);
  assert.equal(repeating.checkpoint_guidance, STOP_HOOK_CHECKPOINT_GUIDANCE);
  assert.equal(repeating.checkpoint_reason, 'the Stop hook closes this task');
  // The Agent judged it not a repeat and called nothing: the Stop hook closes the turn itself.
  const calls = [];
  const outcome = await stopHookOutcome({ decision: 'block', entry_via: 'hook', task_context_token: repeating.taskContextToken },
    async (name, input) => { calls.push([name, input.disposition]); return {}; }, {});
  assert.deepEqual(outcome, {});
  assert.deepEqual(calls, [['checkpoint_task_knowledge', 'retain_nothing']]);
  const question = await beginTaskFromPreferences(application, preferences,
    { sessionId: 's', taskPrompt: '为什么这里不用 pnpm？' }, { entryVia: 'hook' });
  assert.equal(question.checkpoint_required, false);
  assert.equal('remember_guidance' in question, false);
});
