// Habits that apply only in a case they state are spelled out only where the
// task may be that case (preference-conditions.js). Every habit, prompt,
// project and session here is synthetic; the four habits have the shapes of
// the ones reported (a hand-over rule, a region rule for campaign work, a
// plugin rule, a timesheet rule with an appliesWhen), not their words.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeLifecycleOutput } from '../src/agents/claude-code/lifecycle-event.js';
import { CONDITIONAL_LABEL, preferenceCondition, unmetConditions } from '../src/conversations/preference-conditions.js';
import { statedPreferenceScope } from '../src/conversations/preference-index.js';
import { copyPreferenceScope } from '../src/conversations/preference-snapshot.js';
import { withDeliveredHabits } from '../src/conversations/entry-habits-line.js';
import { syntheticPreference } from '../test-support/synthetic-context-session.js';
import { claudeEntrySession, codexEntrySession, hookFrame, syntheticLargeEntry, syntheticPreferences }
  from '../test-support/synthetic-large-entry.js';

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
  unrelated: '为什么会弹出这个 MCP 配置窗口，是哪个设置引起的',
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
  : (frame.preferences_omitted?.conditional ?? []).some(line => line.startsWith(`${item.preference_key} — `)) ? 'line' : 'ranked';

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
    'campaign-region — hard rule · 所有合成门店的促销排期需求',
    'timesheet-fill — 合成公司 TIMESHEET 工时填写 / Pico 工作流']);
  assert.equal(frame.preferences_omitted.count, 2);
  assert.equal(frame.preferences_omitted.includes_always_inline, undefined, 'a case not met is not a hard rule crowded out');
  assert.equal(frame.preferences_omitted.read.tool, 'read_task_preferences');
  assert.ok(text.slice(0, text.lastIndexOf('\n')).includes(CONDITIONAL_LABEL));
});

test('what cannot be judged counts as met: a short request, no request, a case without words, an entry without its reader', async () => {
  const value = entry();
  for (const request of [null, '', '继续', '好的', 'fix it']) {
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
  }));
}

test('after a compaction the first frame names the hard rule by its case again', () => claudeEntrySession(async session => {
  const build = token => syntheticLargeEntry({ items: ITEMS, sessionId: session.sessionId, token, conflicts: false });
  await session.turn(build('task-1'), { prompt: TASKS.unrelated });
  await session.host.say('assistant', 'SYNTHETIC reply.');
  await session.host.compact();
  const frame = (await session.turn(build('task-2'), { prompt: TASKS.unrelated })).frame;
  assert.equal(frame.preference_delivery, undefined, 'a complete frame');
  assert.ok(frame.preferences_omitted.conditional.includes('campaign-region — hard rule · 所有合成门店的促销排期需求'));
}));
