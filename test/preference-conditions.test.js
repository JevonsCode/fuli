// Habits that apply only in a case they state are spelled out only where the
// task may be that case (preference-conditions.js). Every habit, prompt,
// project and session here is synthetic; the four habits have the shapes of
// the ones reported (a hand-over rule, a region rule for campaign work, a
// plugin rule, a timesheet rule with an appliesWhen), not their words.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeLifecycleOutput } from '../src/agents/claude-code/lifecycle-event.js';
import { CONDITIONAL_LABEL, conditionLine, judgeable, preferenceCondition, REFERENCES, unmetConditions }
  from '../src/conversations/preference-conditions.js';
import { preferenceAlwaysInline } from '../src/graphiti/preference-task-scope.js';
import { statedPreferenceScope } from '../src/conversations/preference-index.js';
import { copyPreferenceScope } from '../src/conversations/preference-snapshot.js';
import { withDeliveredHabits } from '../src/conversations/entry-habits-line.js';
import { syntheticPreference } from '../test-support/synthetic-context-session.js';
import { claudeEntrySession, codexEntrySession, hookFrame, REAL_SCALE_CASE_PROMPT, realScalePreferences, syntheticLargeEntry,
  syntheticPreferences, syntheticWorkingEntry } from '../test-support/synthetic-large-entry.js';

const SESSION = '0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b55';
const HABITS = Object.freeze({
  // No "仅": unconditional this time, whatever it is about.
  slides: syntheticPreference('slides-owner', '以后所有海报和宣传图统一交给长期助手「美工」来做，不再自己动手。',
    { constraint: 'hard' }, 'judgment_preference'),
  campaign: syntheticPreference('campaign-region', '仅适用于所有合成门店的促销排期需求：门店归属判断统一只看当前生效的 region 配置，不看域名。',
    { constraint: 'hard' }, 'judgment_preference'),
  plugin: syntheticPreference('helper-plugin-version', '后续为用户写的浏览器小插件，第一次运行时先报出自己的版本号。',
    { constraint: 'hard' }, 'judgment_preference'),
  timesheet: syntheticPreference('timesheet-fill', '仅在填写合成公司的 TIMESHEET 工时时适用：按自然日拆分，每天不超过八小时。',
    { appliesWhen: '合成公司 TIMESHEET 工时填写 / Pico 工作流' })
});
const ITEMS = Object.values(HABITS);
const TASKS = Object.freeze({
  unrelated: '为什么会弹出 MCP 配置窗口，是哪项设置引起的',
  related: '帮我把这周的 TIMESHEET 工时填一下，再看看门店促销排期的归属判断',
  short: '继续',
  mixed: '把 campaign 门店促销排期的 region 判断修一下, then run the tests'
});

const entry = (items = ITEMS, extra = {}) => {
  const value = syntheticLargeEntry({ items, sessionId: SESSION, conflicts: false });
  return copyPreferenceScope(value, { ...value, ...extra });
};
const frameFor = async (prompt, value = entry()) => {
  const input = { session_id: SESSION, cwd: '/synthetic/project', prompt };
  const text = (await claudeLifecycleOutput('UserPromptSubmit', input, async () => value)).hookSpecificOutput.additionalContext;
  return { text, frame: hookFrame(text) };
};
// What a frame does with one habit: its body, a line naming its case, or neither (ranked as before).
const treatment = (frame, item) => frame.effective_preferences.some(listed => listed.preference_key === item.preference_key) ? 'body'
  : (frame.preferences_omitted?.conditional ?? []).some(line => line.split(' — ')[0].split(' (')[0] === item.preference_key) ? 'line'
    : 'ranked';

test('a habit is conditional only where it says so: appliesWhen, or an opening that states the case', () => {
  assert.equal(preferenceCondition(HABITS.slides), null, 'no stated case: unconditional');
  assert.equal(preferenceCondition(HABITS.plugin), null);
  assert.equal(preferenceCondition(HABITS.campaign).text, '所有合成门店的促销排期需求');
  assert.equal(preferenceCondition(HABITS.timesheet).text, '合成公司 TIMESHEET 工时填写 / Pico 工作流', 'appliesWhen wins');
  assert.equal(statedPreferenceScope('仅在整理或填写合成工时时适用：按天拆分。'), '整理或填写合成工时');
  assert.equal(statedPreferenceScope('只有在处理合成发票的时候才适用：金额保留两位。'), '处理合成发票');
  assert.equal(preferenceCondition(syntheticPreference('invoices', 'Applies only when editing synthetic invoices: keep two decimals.'))
    .text, 'editing synthetic invoices');
  // When an action may happen is a rule for every task, not a case.
  assert.equal(statedPreferenceScope('只在用户确认后才推送到远端。'), null);
  assert.equal(statedPreferenceScope('仅在周五发布时适用：先冻结。'), null);
  assert.equal(statedPreferenceScope('Only when the person confirms, push to the remote.'), null);
  // An appliesWhen that is not text is not a case.
  assert.equal(preferenceCondition(syntheticPreference('odd', 'Synthetic rule.', { appliesWhen: { rule: 'x' } })), null);
});

test('four tasks by four habits: body, a line naming its case, or ranked as before', async () => {
  const expected = {
    unrelated: { slides: 'body', campaign: 'line', plugin: 'body', timesheet: 'line' },
    related: { slides: 'body', campaign: 'body', plugin: 'body', timesheet: 'body' },
    short: { slides: 'body', campaign: 'body', plugin: 'body', timesheet: 'body' },
    mixed: { slides: 'body', campaign: 'body', plugin: 'body', timesheet: 'line' }
  };
  for (const [task, prompt] of Object.entries(TASKS)) {
    const { text, frame } = await frameFor(prompt);
    const seen = Object.fromEntries(Object.entries(HABITS).map(([name, item]) => [name, treatment(frame, item)]));
    assert.deepEqual(seen, expected[task], task);
    const lines = frame.preferences_omitted?.conditional ?? [];
    assert.equal(text.includes(CONDITIONAL_LABEL), lines.length > 0, `${task}: the sentence comes with the lines`);
  }
});

test('a hard rule whose case the task is not is named with its case and marked a hard rule, and the sentence says how to read it', async () => {
  const { text, frame } = await frameFor(TASKS.unrelated);
  assert.deepEqual(frame.preferences_omitted.conditional, [
    'campaign-region — hard rule · 所有合成门店的促销排期需求 · 门店归属判断统一只看当前生效的 region 配置，不看域名',
    'timesheet-fill — 合成公司 TIMESHEET 工时填写 / Pico 工作流']);
  assert.equal(frame.preferences_omitted.count, 2);
  assert.equal(frame.preferences_omitted.includes_always_inline, undefined, 'a case not met is not a hard rule crowded out');
  assert.equal(frame.preferences_omitted.read.tool, 'read_task_preferences');
  assert.ok(text.slice(0, text.lastIndexOf('\n')).includes(CONDITIONAL_LABEL));
});

test('what cannot be judged counts as met: a short request, no request, a case without words, an entry without its reader', async () => {
  const value = entry();
  for (const request of [null, '', '继续', '好的', 'fix it', '按上面说的继续做']) {
    assert.deepEqual(unmetConditions(value, { request }), [], String(request));
  }
  const wordless = syntheticPreference('wordless', '仅适用于 X：合成规则。', { constraint: 'hard' }, 'judgment_preference');
  assert.deepEqual(unmetConditions(entry([wordless]), { request: TASKS.unrelated }), []);
  // No token or Agent: the read that would serve the line would be refused, so nothing is left out.
  const { taskContextToken: _token, ...unreadable } = value;
  assert.deepEqual(unmetConditions(unreadable, { request: TASKS.unrelated }), []);
  // The project, its brief, the scene and the person's recent messages count as the task's own words.
  const briefed = entry(ITEMS, { project_agent_context: { project_brief: { name: 'Synthetic campaign desk',
    summary: '门店促销排期的看板' } } });
  assert.deepEqual(unmetConditions(briefed, { request: TASKS.unrelated }).map(index => ITEMS[index].preference_key), ['timesheet-fill']);
  const said = entry(ITEMS, { conversation: { status: 'saved', recovery: { messages: [
    { sequence: 1, role: 'user', content: '今天要填 TIMESHEET 工时' }, { sequence: 2, role: 'assistant', content: '门店促销排期' }] } } });
  assert.deepEqual(unmetConditions(said, { request: TASKS.unrelated }).map(index => ITEMS[index].preference_key), ['campaign-region'],
    'only what the person said, not the assistant');
});

test('a restore after compaction and a host turn have no request: every hard rule is spelled out', async () => {
  const restored = await claudeLifecycleOutput('SessionStart', { session_id: SESSION, source: 'compact', cwd: '/synthetic/project' },
    async () => copyPreferenceScope(entry(), { ...entry(), preference_delivery: { status: 'complete' }, preferences_complete: true,
      same_task_recovery_available: true, truncated: false }),
    { currentTask: async sessionId => ({ token: 'task-large', sessionId, sourceApplication: 'claude_code', checkpoint: {} }) });
  const frame = hookFrame(restored.hookSpecificOutput.additionalContext);
  for (const item of ITEMS) assert.equal(treatment(frame, item), 'body', item.preference_key);
});

test('habits without a stated case: the frame is the same byte for byte whatever the request', async () => {
  const value = syntheticLargeEntry({ items: syntheticPreferences(70, { length: 130 }), sessionId: SESSION });
  const [one, other] = [await frameFor(TASKS.unrelated, value), await frameFor(TASKS.related, value)];
  assert.equal(one.text, other.text);
  assert.equal(one.frame.preferences_omitted.conditional, undefined);
});

test('the receipt counts a habit left out for its case as readable, never as carried', () => {
  const value = withDeliveredHabits({ effective_preferences: [{ preference_key: 'a' }],
    preferences_omitted: { count: 3, conditional: ['b — 合成场景', 'c — hard rule · 合成场景'] },
    agent_receipt: { lines: ['FULI 习惯：这个新对话为你准备了 4 条习惯 · [看看是哪几条](http://192.0.2.7:2727/habits/x)'] } });
  assert.equal(value.agent_receipt.lines[0],
    'FULI 习惯：这个新对话为你准备了 4 条习惯：直接带上 1 条，另外 3 条随时可读（2 条这次用不上） · [看看是哪几条](http://192.0.2.7:2727/habits/x)');
});

// The session's delivery record holds what was spelled out: a hard rule
// first named by its case is spelled out on the turn the task becomes that
// case, and a body once given is never taken back.
for (const [client, open] of [['Claude Code', claudeEntrySession], ['Codex', codexEntrySession]]) {
  test(`${client}: the turn a task becomes the case, its hard rule's body arrives as a delta and stays`, () => open(async session => {
    const build = token => syntheticLargeEntry({ items: ITEMS, sessionId: session.sessionId, token, conflicts: false,
      sourceApplication: client === 'Codex' ? 'codex' : 'claude_code' });
    const reply = () => session.host.say('assistant', 'SYNTHETIC reply.');
    const first = (await session.turn(build('task-1'), { prompt: TASKS.unrelated })).frame;
    assert.equal(treatment(first, HABITS.campaign), 'line');
    if (client !== 'Codex') await reply();
    const second = (await session.turn(build('task-2'), { prompt: TASKS.unrelated })).frame;
    assert.equal(second.preference_delivery.status, 'delta');
    assert.equal(second.preferences_omitted.conditional_unchanged, true, 'the lines the base gave are not resent');
    assert.equal(second.preferences_omitted.conditional, undefined);
    if (client !== 'Codex') await reply();
    const third = (await session.turn(build('task-3'), { prompt: TASKS.mixed })).frame;
    assert.equal(third.preference_delivery.status, 'delta');
    assert.deepEqual(third.preference_updates.map(item => item.preference_key), ['campaign-region'], 'its body, in that turn');
    assert.equal(third.preference_updates[0].instruction, HABITS.campaign.instruction);
    if (client !== 'Codex') await reply();
    const fourth = (await session.turn(build('task-4'), { prompt: TASKS.unrelated })).frame;
    assert.equal(fourth.preference_delivery.status, 'delta');
    assert.deepEqual(fourth.preference_delivery.removed, [], 'a body given is not taken back');
    assert.equal((fourth.preferences_omitted.conditional ?? []).some(line => line.startsWith('campaign-region')), false);
    // No frame carries an empty list of lines.
    for (const frame of [first, second, third, fourth]) {
      for (const value of Object.values(frame.preferences_omitted ?? {})) assert.notDeepEqual(value, [], JSON.stringify(frame.preferences_omitted));
    }
  }));
}

test('after a compaction the first frame names the hard rule by its case again', () => claudeEntrySession(async session => {
  const build = token => syntheticLargeEntry({ items: ITEMS, sessionId: session.sessionId, token, conflicts: false });
  await session.turn(build('task-1'), { prompt: TASKS.unrelated });
  await session.host.say('assistant', 'SYNTHETIC reply.');
  await session.host.compact();
  const frame = (await session.turn(build('task-2'), { prompt: TASKS.unrelated })).frame;
  assert.equal(frame.preference_delivery, undefined, 'a complete frame');
  assert.ok(frame.preferences_omitted.conditional.some(line => line.startsWith('campaign-region — hard rule · 所有合成门店的促销排期需求 · ')));
}));

// Review of #1104: each probe of its table, with what the model holds after
// the fix. Every habit and task is synthetic. "body": the hard rule in full;
// "line": one line naming its case and saying what it says (its first
// sentence), the net under a task whose words miss the case.
const STORE = syntheticPreference('store-promo', '仅适用于所有合成门店的促销排期需求：门店归属判断统一只看当前生效的 region 配置，不看域名。',
  { constraint: 'hard' }, 'judgment_preference');
const STORE_EN = syntheticPreference('store-promo-en',
  'Applies only to synthetic store promotion scheduling: store ownership follows the active region setting, never the domain.',
  { constraint: 'hard' }, 'judgment_preference');
const STORE_GIST = '门店归属判断统一只看当前生效的 region 配置，不看域名';
const hardCase = (key, appliesWhen) => syntheticPreference(key, '合成规则：交付前把变更清单发给合成评审人。',
  { constraint: 'hard', appliesWhen }, 'judgment_preference');
const LONG_UNRELATED = `${'演示看板的导出按钮在窄屏下会换行，表头的排序箭头和筛选图标挤在一起，'.repeat(6)}帮我把导出按钮的布局修好，并补上截图对比。`;
const PROBES = [
  // Worded otherwise: the case's words miss, so the line carries what the rule says.
  { name: 'reworded: 活动页的地区判断', items: [STORE], prompt: '帮我改一下下周活动页的地区判断', expect: 'line', gist: STORE_GIST },
  { name: 'reworded: region bug', items: [STORE], prompt: 'region 的判断逻辑有个 bug', expect: 'line', gist: STORE_GIST },
  // Six Chinese characters and one Latin word say too little to judge by.
  { name: 'reworded: 把 site 判断换掉', items: [STORE], prompt: '把 site 判断换掉', expect: 'body' },
  { name: 'across languages: Chinese case, English task', items: [STORE],
    prompt: 'fix the store promo scheduling bug on the synthetic campaign page', expect: 'line', gist: STORE_GIST },
  { name: 'across languages: English case, Chinese task', items: [STORE_EN], prompt: '门店促销的排期总是错一天，帮我查一下原因',
    expect: 'line', gist: 'store ownership follows the active region setting, never the domain' },
  // A two-character case against a short task: the task cannot be judged.
  { name: 'a short case: 发版', items: [hardCase('release-case', '发版')], prompt: '准备发布 0.29.0 版本', expect: 'body' },
  { name: 'a short case met', items: [hardCase('release-case', '发版')], prompt: '今天下午要发版，先把合成变更清单整理出来', expect: 'body' },
  // Every task, written as a case: no case.
  ...['所有任务', '所有的任务', '总是', '始终', '默认', 'always', 'by default', 'all tasks', 'every task', '任何时候'].map(words =>
    ({ name: `no case: ${words}`, items: [hardCase('every-case', words)], prompt: TASKS.unrelated, expect: 'body', unconditional: true })),
  // A case with no word left once filler is out: cannot be judged.
  { name: 'nothing left: 相关工作', items: [hardCase('vague-case', '相关工作')], prompt: TASKS.unrelated, expect: 'body' },
  // 仅限… limits what is done; for a hard rule only "applies" states a case.
  { name: '仅限内部使用', items: [syntheticPreference('internal-only', '仅限内部使用，不要外发任何截图。', { constraint: 'hard' },
    'judgment_preference')], prompt: '把这张截图发给客户看看效果', expect: 'body', unconditional: true },
  { name: 'a long unrelated task', items: [STORE], prompt: LONG_UNRELATED, expect: 'line', gist: STORE_GIST },
  // Pointing back at earlier words: what they point to is not in the request.
  { name: 'pointing back: 按上面说的继续做', items: [STORE], prompt: '按上面说的继续做', expect: 'body' },
  { name: 'pointing back: a longer one', items: [STORE], prompt: '按上面说的继续把那个页面的地区判断改掉，然后跑一下测试', expect: 'body' },
  { name: 'pointing back: as above', items: [STORE], prompt: 'do the same as above for the synthetic export dialog', expect: 'body' },
  { name: '继续', items: [STORE], prompt: '继续', expect: 'body' }
];

for (const probe of PROBES) {
  test(`probe: ${probe.name} -> ${probe.expect}`, async () => {
    const [item] = probe.items;
    if (probe.unconditional) assert.equal(preferenceCondition(item), null, 'no case at all');
    const { frame } = await frameFor(probe.prompt, entry(probe.items));
    assert.equal(treatment(frame, item), probe.expect);
    if (probe.expect !== 'line') return;
    const line = frame.preferences_omitted.conditional.find(text => text.startsWith(`${item.preference_key} — `));
    assert.ok(line.includes(' — hard rule · '), line);
    assert.ok(line.endsWith(` · ${probe.gist}`), line);
  });
}

test('a hard rule\'s case is its whole opening up to a colon, and its line adds the first sentence, cut at a word end', () => {
  const two = syntheticPreference('two-cases', '仅适用于合成门店促销排期，以及合成会员积分兑换：兑换比例只看当前生效的配置。',
    { constraint: 'hard' }, 'judgment_preference');
  assert.equal(preferenceCondition(two).text, '合成门店促销排期，以及合成会员积分兑换');
  assert.deepEqual(unmetConditions(entry([two]), { request: '会员积分兑换页面的比例显示不对，帮我看看' }), [], 'the later case counts');
  const long = 'x'.repeat(130);
  assert.equal([...preferenceCondition(syntheticPreference('long', 'Synthetic.', { appliesWhen: long })).text].length, 120);
  const wordy = syntheticPreference('wordy', 'Applies only when editing synthetic invoices: keep two decimals on every line '
    + 'item and never round half to even, because the synthetic ledger rejects it.', { constraint: 'hard' }, 'judgment_preference');
  assert.equal(conditionLine(wordy), 'wordy — hard rule · editing synthetic invoices · keep two decimals on every line item and '
    + 'never round half to even, because the…');
  // Not a hard rule: the case alone.
  const soft = syntheticPreference('soft-case', '仅适用于合成报表：保留两位小数。');
  assert.equal(conditionLine(soft), 'soft-case — 合成报表');
});

test('仅限… / Only for…: a hard rule always carries its body; a habit keeps it as a case unless it restricts who uses it', () => {
  for (const instruction of ['仅限内部使用，不要外发任何截图。', '仅限本人查看：不要把日志贴到群里。', 'Only for internal use: never paste tokens into chat.']) {
    for (const qualifiers of [{ constraint: 'hard' }, {}]) {
      assert.equal(preferenceCondition(syntheticPreference('restricted', instruction, qualifiers)), null, instruction);
    }
  }
  const project = '仅限合成支付项目：提交前跑全量测试。';
  assert.equal(preferenceCondition(syntheticPreference('hard-project', project, { constraint: 'hard' })), null);
  assert.equal(preferenceCondition(syntheticPreference('soft-project', project)).text, '合成支付项目');
  // A hard rule states a case only by saying it applies there.
  assert.equal(preferenceCondition(syntheticPreference('hard-applies', '仅在填写合成工时时适用：按天拆分。', { constraint: 'hard' })).text,
    '填写合成工时');
});

test('a request is judgeable by its own length without filler, and never where it points back', () => {
  for (const request of ['按上面说的继续做', '照旧', '和刚才一样处理', 'keep going', 'same as the previous one', '这个也改一下',
    '修一下', 'fix the bug', '准备发布 0.29.0 版本']) assert.equal(judgeable(request), false, request);
  for (const request of ['帮我改一下下周活动页的地区判断', 'fix the export bug', 'region 的判断逻辑有个 bug',
    'why does the config dialog appear']) assert.equal(judgeable(request), true, request);
  assert.ok(REFERENCES.includes('继续') && REFERENCES.includes('as above'));
});

const emptyLists = (value, path = '') => Array.isArray(value)
  ? (value.length ? value.flatMap((item, index) => emptyLists(item, `${path}[${index}]`)) : [path])
  : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => emptyLists(item, `${path}.${key}`)) : [];

// The net under a reworded task: on every client a hard rule whose case the
// task is not stays in the frame as its line (agents/*/entry-inline-budget
// tests and mcp-task-entry-budget hold the same for each entry).
for (const [client, open, sourceApplication] of [['Claude Code', claudeEntrySession, 'claude_code'],
  ['Codex', codexEntrySession, 'codex']]) {
  test(`${client}, 70 habits: the turn the task becomes the case, every hard rule of that case arrives in full`, () => open(async session => {
    const items = realScalePreferences();
    const cased = items.filter(item => item.preference_qualifiers.appliesWhen && preferenceAlwaysInline(item));
    assert.equal(cased.length, 3);
    const build = async token => syntheticWorkingEntry({ items, sessionId: session.sessionId, token, sourceApplication });
    const reply = () => client === 'Codex' ? null : session.host.say('assistant', 'SYNTHETIC reply.');
    const first = (await session.turn(await build('task-1'), { prompt: 'fix the export bug' })).frame;
    for (const item of cased) assert.equal(treatment(first, item), 'line', item.preference_key);
    await reply();
    const second = (await session.turn(await build('task-2'), { prompt: REAL_SCALE_CASE_PROMPT })).frame;
    const given = new Map((second.preference_updates ?? second.effective_preferences).map(item => [item.preference_key, item]));
    for (const item of cased) assert.equal(given.get(item.preference_key)?.instruction, item.instruction, item.preference_key);
    assert.equal(second.preferences_omitted?.includes_always_inline, undefined, 'no hard rule left owing');
    await reply();
    const third = (await session.turn(await build('task-3'), { prompt: 'fix the export bug' })).frame;
    assert.deepEqual(third.preference_delivery.removed, [], 'a body given is not taken back');
    // No frame carries an empty list (review of #1104 saw `conditional: []` on such a turn).
    for (const frame of [first, second, third]) assert.deepEqual(emptyLists(frame.preferences_omitted), []);
  }));
}

test('a delta whose task is the case of every line it held says nothing of them, never an empty list', () => claudeEntrySession(async session => {
  const build = token => syntheticLargeEntry({ items: ITEMS, sessionId: session.sessionId, token, conflicts: false });
  await session.turn(build('task-1'), { prompt: TASKS.unrelated });
  await session.host.say('assistant', 'SYNTHETIC reply.');
  const frame = (await session.turn(build('task-2'), { prompt: TASKS.related })).frame;
  assert.equal(frame.preference_delivery.status, 'delta');
  assert.equal(Object.hasOwn(frame.preferences_omitted ?? {}, 'conditional'), false, JSON.stringify(frame.preferences_omitted));
  for (const [, value] of Object.entries(frame.preferences_omitted ?? {})) assert.notDeepEqual(value, []);
}));
