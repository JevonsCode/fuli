// rec#47 F1b, rec#11 D-54: the Claude Code task entry fits the host's inline
// limit and stays a frame the session can confirm. Synthetic entries,
// transcripts and preferences only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeLifecycleOutput } from '../../../src/agents/claude-code/lifecycle-hook.js';
import { codexLifecycleOutput } from '../../../src/agents/codex/lifecycle-hook.js';
import { PASS_TASK_TOKEN, TASK_RULES_ON_DEMAND, taskClosingInstruction } from '../../../src/agents/lifecycle-message.js';
import { compactTaskContext } from '../../../src/conversations/task-context-view.js';
import { preferenceHookOutput } from '../../../src/conversations/preference-lifecycle.js';
import { ALWAYS_INLINE_OMITTED_LABEL, OMITTED_PREFERENCES_LABEL } from '../../../src/conversations/entry-inline-budget.js';
import { syntheticPreference } from '../../../test-support/synthetic-context-session.js';
import { claudeEntrySession, hookFrame, syntheticIndexRecall, syntheticLargeEntry, syntheticPreferences, syntheticRecall,
  syntheticRecovery } from '../../../test-support/synthetic-large-entry.js';

const INLINE_CHARS = 9000;
const SESSION = '0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b84';
const input = { session_id: SESSION, cwd: '/synthetic/project', prompt: 'fix the export bug' };
const claudeEntry = async entry => (await claudeLifecycleOutput('UserPromptSubmit', input, async () => entry))
  .hookSpecificOutput.additionalContext;
const keys = items => (items ?? []).map(item => item.preference_key);
const kind = instruction => /SYNTHETIC_(\w+?)_\d+/.exec(instruction)?.[1];

test('a large entry fits inline: every hard rule, closing field and conflict stays, boundaries rank first, the rest is counted', async () => {
  const items = syntheticPreferences(60);
  const text = await claudeEntry(syntheticLargeEntry({ items, sessionId: SESSION }));
  assert.ok(text.length <= INLINE_CHARS, `${text.length} chars`);
  const frame = hookFrame(text);
  const byKey = new Map(items.map(item => [item.preference_key, item]));
  const sent = keys(frame.effective_preferences);
  const ofKind = (...kinds) => items.filter(item => kinds.includes(kind(item.instruction))).map(item => item.preference_key);
  // Hard rules always stay; boundaries (judgment rules without a scene key)
  // are ranked first (D-69), so these few fit too.
  const first = ofKind('HARD', 'BOUNDARY');
  assert.ok(ofKind('HARD').length >= 5 && ofKind('BOUNDARY').length >= 2);
  assert.deepEqual(first.filter(key => !sent.includes(key)), []);
  // Then the task scene's own items (tasteDomain code for this implementation
  // task) come before general taste.
  const ranked = sent.filter(key => !first.includes(key));
  assert.ok(ranked.length > 0);
  assert.deepEqual(ranked.filter(key => kind(byKey.get(key).instruction) !== 'SCENE'), []);
  assert.equal(frame.taskContextToken, 'task-large');
  assert.equal(frame.checkpoint_required, true);
  assert.equal(frame.agent_receipt.required, true);
  assert.equal(frame.active_conflicts.length, 1);
  assert.deepEqual(keys(frame.active_conflicts[0].alternatives), ['conflict-a', 'conflict-b']);
  assert.deepEqual(frame.preferences_omitted, { count: 60 - sent.length,
    read: { tool: 'read_task_preferences', arguments: { taskContextToken: 'task-large' } } });
  assert.ok(text.split('\n')[0].endsWith(OMITTED_PREFERENCES_LABEL));
  assert.ok(text.indexOf('task-large') < 1000, 'the closing instruction still leads');
});

test('recall and the conversation window shrink before any preference is left out', async () => {
  const items = syntheticPreferences(8);
  const entry = syntheticLargeEntry({ items, sessionId: SESSION, recall: syntheticRecall(3), conversation: syntheticRecovery(10) });
  const frame = hookFrame(await claudeEntry(entry));
  assert.deepEqual(keys(frame.effective_preferences), keys(items));
  assert.equal(frame.preferences_omitted, undefined);
  assert.deepEqual(frame.task_knowledge_recall.facts, undefined);
  assert.equal(frame.task_knowledge_recall.items_omitted, 3);
  assert.equal(frame.task_knowledge_recall.read.tool, 'search_current_project_knowledge');
  const recovery = frame.conversation.recovery;
  assert.ok(recovery.messages.length > 0 && recovery.messages.length < 10);
  assert.equal(recovery.truncated, true);
  assert.equal(recovery.omitted_sequence, recovery.messages[0].sequence - 1, 'the newest messages stay');
});

test('a coding task\'s knowledge index is reduced to a pointer before any preference is left out (rec#51 D-59)', async () => {
  // The smallest synthetic entry that is over the limit with its index and
  // fits once the index is a pointer.
  let found = null;
  for (let count = 8; count <= 24 && !found; count++) {
    for (let length = 300; length <= 440 && !found; length += 5) {
      const items = syntheticPreferences(count, { length });
      const whole = await claudeEntry(syntheticLargeEntry({ items, sessionId: SESSION, recall: syntheticIndexRecall(5) }));
      const frame = hookFrame(whole);
      if (frame.task_knowledge_recall.knowledge_index === undefined && frame.preferences_omitted === undefined) found = { items, frame, whole };
    }
  }
  assert.ok(found, 'some synthetic entry is over the limit only with its index');
  const { items, frame, whole } = found;
  assert.ok(whole.length <= INLINE_CHARS);
  assert.deepEqual(keys(frame.effective_preferences), keys(items), 'every preference stays');
  assert.equal(frame.task_knowledge_recall.status, 'indexed');
  assert.equal(frame.task_knowledge_recall.items_omitted, 5);
  assert.equal(frame.task_knowledge_recall.read.tool, 'search_current_project_knowledge');
  assert.equal(JSON.stringify(frame).includes('SYNTHETIC indexed rule'), false);

  // With many preferences the bounded selection is the same with or without an index.
  const many = syntheticPreferences(60);
  const withIndex = hookFrame(await claudeEntry(syntheticLargeEntry({ items: many, sessionId: SESSION, recall: syntheticIndexRecall(5) })));
  const without = hookFrame(await claudeEntry(syntheticLargeEntry({ items: many, sessionId: SESSION })));
  assert.deepEqual(keys(withIndex.effective_preferences), keys(without.effective_preferences));
  assert.equal(withIndex.task_knowledge_recall.knowledge_index, undefined);
});

test('an entry that fits is the same as without an inline budget, and other Agents are unchanged', async () => {
  const fitting = compactTaskContext(syntheticLargeEntry({ items: syntheticPreferences(10), sessionId: SESSION }));
  const label = 'Fuli task context. Apply effective_preferences. ' + taskClosingInstruction(fitting) + PASS_TASK_TOKEN + TASK_RULES_ON_DEMAND;
  const whole = await preferenceHookOutput(fitting, 'UserPromptSubmit', input, undefined, 'claude_code', label);
  assert.deepEqual(await claudeLifecycleOutput('UserPromptSubmit', input,
    async () => syntheticLargeEntry({ items: syntheticPreferences(10), sessionId: SESSION })), whole);
  const codex = await codexLifecycleOutput('UserPromptSubmit', { ...input, turn_id: 'turn-1' },
    async () => syntheticLargeEntry({ items: syntheticPreferences(60), sessionId: SESSION }));
  const text = codex.hookSpecificOutput.additionalContext;
  assert.ok(text.length > 30000);
  assert.equal(hookFrame(text).effective_preferences.length, 60);
  assert.equal(hookFrame(text).preferences_omitted, undefined);
  assert.doesNotMatch(text, /preferences_omitted/);
});

test('a bounded frame is confirmed from its Claude transcript record and the next turn is a small delta', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const first = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-1' }));
    assert.ok(first.text.length <= INLINE_CHARS);
    assert.match(first.frame.revision, /^[0-9a-f]{12}$/);
    const second = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-2' }));
    const delivery = second.frame.preference_delivery;
    assert.equal(delivery.status, 'delta');
    assert.equal(delivery.base_revision, first.frame.revision);
    assert.deepEqual([second.frame.preference_updates, delivery.removed], [[], []]);
    assert.equal(delivery.unchanged, first.frame.effective_preferences.length);
    assert.equal(second.frame.preferences_omitted.count, first.frame.preferences_omitted.count);
    assert.equal(second.frame.preferences_omitted.read.arguments.taskContextToken, 'task-2');
    assert.ok(second.text.length < 3000, `${second.text.length} chars`);
  }));

test('an omitted preference is never delivered: a later whole frame lists every one of them as an update', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(30);
    const first = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-1' }));
    const omitted = keys(items).filter(key => !keys(first.frame.effective_preferences).includes(key));
    assert.equal(omitted.length, first.frame.preferences_omitted.count);
    // The same session through the same cache without an inline budget, as a
    // host that shows everything would get it: only the delivered set is a base.
    const entry = compactTaskContext(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-2' }));
    const input = { session_id: session.sessionId, transcript_path: session.host.path, cwd: '/synthetic', prompt: 'fix it' };
    const whole = hookFrame((await preferenceHookOutput(entry, 'UserPromptSubmit', input, session.delivery, 'claude_code', 'label'))
      .hookSpecificOutput.additionalContext);
    assert.equal(whole.preference_delivery.status, 'delta');
    assert.equal(whole.preference_delivery.base_revision, first.frame.revision);
    assert.deepEqual(keys(whole.preference_updates).sort(), [...omitted].sort());
    assert.deepEqual(whole.preference_delivery.removed, []);
  }));

test('a bounded frame never names a removal of a preference that is still in force', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(30);
    const first = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-1' }));
    // Three new hard rules take the room of ranked ones the first frame sent.
    const hard = [1, 2, 3].map(index => syntheticPreference(`new-hard-${index}`,
      `SYNTHETIC_HARD_NEW_${index}: ${'Never push a shared branch without review. '.repeat(10)}`, { constraint: 'hard' }, 'judgment_preference'));
    const second = await session.turn(syntheticLargeEntry({ items: [...items, ...hard], sessionId: session.sessionId, token: 'task-2' }));
    const demoted = keys(first.frame.effective_preferences).filter(key => !keys(second.frame.effective_preferences).includes(key));
    assert.ok(demoted.length > 0);
    assert.equal(second.frame.preference_delivery, undefined, 'a complete frame, not a delta that removes them');
    assert.deepEqual(keys(hard).filter(key => !keys(second.frame.effective_preferences).includes(key)), []);
    assert.equal(second.frame.preferences_omitted.count, 33 - second.frame.effective_preferences.length);
    assert.notEqual(second.frame.revision, first.frame.revision);
  }));

// D-69 (revises D-54): past Claude Code's preview a hard rule is not seen
// either, so hard rules alone over the limit are bounded too, and the omission
// says hard rules are among what is left out.
test('hard rules alone over the inline limit are trimmed too: hard rules first, the omission names them', async () => {
  const hard = Array.from({ length: 30 }, (_, index) => syntheticPreference(`hard-${index + 1}`,
    `SYNTHETIC_HARD_${index + 1}: ${'Run the full suite before every commit. '.repeat(10)}`, { constraint: 'hard' }, 'judgment_preference'));
  const general = syntheticPreferences(5, { hardEvery: 100, boundaryEvery: 100 });
  const text = await claudeEntry(syntheticLargeEntry({ items: [...general, ...hard], sessionId: SESSION }));
  assert.ok(text.length <= INLINE_CHARS, `${text.length} chars`);
  const frame = hookFrame(text);
  const sent = keys(frame.effective_preferences);
  assert.ok(sent.length > 0 && sent.length < hard.length);
  assert.deepEqual(sent.filter(key => !keys(hard).includes(key)), [], 'no general item before every hard rule');
  assert.deepEqual(frame.preferences_omitted, { count: 35 - sent.length, includes_always_inline: true,
    read: { tool: 'read_task_preferences', arguments: { taskContextToken: 'task-large' } } });
  assert.ok(text.split('\n')[0].endsWith(`${OMITTED_PREFERENCES_LABEL} ${ALWAYS_INLINE_OMITTED_LABEL}`));
  assert.equal(frame.taskContextToken, 'task-large');
  assert.equal(frame.checkpoint_required, true);
});

// A delta repeats the label every turn, so it asks for one read of what this
// conversation does not hold yet, never a reread per turn.
test('the omitted-hard-rules label asks for one read, only when the conversation lacks them', () => {
  assert.equal(ALWAYS_INLINE_OMITTED_LABEL, 'Hard rules are among them (preferences_omitted.includes_always_inline): '
    + 'if they are not already in this conversation, read the omitted ones once with read_task_preferences before acting; '
    + 'they stay in force.');
});

// D-69: a more specific rule overrides a broader one, so hard rules that must
// be trimmed keep Agent, then project, then global ones.
test('hard rules that must be trimmed keep the most specific scope first', async () => {
  const scoped = scope => Array.from({ length: 6 }, (_, index) => ({ ...syntheticPreference(`${scope}-hard-${index + 1}`,
    `SYNTHETIC_HARD_${scope}_${index + 1}: ${'Run the full suite before every commit. '.repeat(10)}`, { constraint: 'hard' },
    'judgment_preference'), preference_scope: scope,
  ...(scope === 'global' ? {} : { preference_project_id: 'project' }), ...(scope === 'agent' ? { preference_agent_id: 'lead' } : {}) }));
  const [global, project, agent] = ['global', 'project', 'agent'].map(scoped);
  const frame = hookFrame(await claudeEntry(syntheticLargeEntry({ items: [...global, ...project, ...agent], sessionId: SESSION })));
  const sent = keys(frame.effective_preferences);
  assert.equal(frame.preferences_omitted.count + sent.length, 18, 'every scope reaches the entry');
  assert.ok(sent.length > agent.length && sent.length < agent.length + project.length, `${sent.length} sent`);
  assert.deepEqual(keys(agent).filter(key => !sent.includes(key)), [], 'every Agent rule');
  assert.deepEqual(sent.filter(key => keys(global).includes(key)), [], 'no global rule before every project one');
});

// dot on #356: an entry past the renderer's own 128 KiB result budget renders
// as a short blocked frame. That frame delivers nothing, so it never "fits".
const CJK = '导出接口需要保留分页游标，字段单位要写清楚，回滚方案写在评审说明里，测试数据全部是合成的。';
const cjkRule = (key, length, qualifiers, aspect) => syntheticPreference(key,
  `SYNTHETIC_${key}: ${CJK.repeat(Math.ceil(length / CJK.length))}`.slice(0, length), qualifiers, aspect);

test('an entry past the 128 KiB result budget is bounded and delivered, not blocked, with every hard rule', async () => {
  const hard = Array.from({ length: 5 }, (_, index) => cjkRule(`hard-${index + 1}`, 300, { constraint: 'hard' }, 'judgment_preference'));
  const soft = Array.from({ length: 100 }, (_, index) => cjkRule(`soft-${index + 1}`, 500, {}, 'taste'));
  const entry = () => syntheticLargeEntry({ items: [...hard, ...soft], sessionId: SESSION });
  const whole = (await codexLifecycleOutput('UserPromptSubmit', { ...input, turn_id: 'turn-1' }, async () => entry()))
    .hookSpecificOutput.additionalContext;
  // Unchanged for Codex: the whole entry is over the budget and blocks.
  assert.equal(hookFrame(whole).preference_delivery.reason, 'delivery_budget');
  assert.ok(Buffer.byteLength(JSON.stringify(entry().effective_preferences)) > 128 * 1024);
  const text = await claudeEntry(entry());
  assert.ok(text.length <= INLINE_CHARS, `${text.length} chars`);
  const frame = hookFrame(text);
  assert.equal(frame.preference_delivery, undefined);
  assert.notEqual(frame.preferences_complete, false);
  assert.deepEqual(keys(hard).filter(key => !keys(frame.effective_preferences).includes(key)), []);
  assert.equal(frame.preferences_omitted.count, 105 - frame.effective_preferences.length);
  assert.ok(frame.effective_preferences.length > hard.length);
});

test('an integrity refusal stays blocked under the inline budget', async () => {
  const entry = syntheticLargeEntry({ items: syntheticPreferences(60), sessionId: SESSION });
  entry.context = { ...entry.context, source_truncated: true };
  const frame = hookFrame(await claudeEntry(entry));
  assert.deepEqual([frame.preference_delivery.status, frame.preference_delivery.reason], ['blocked', 'source_window']);
  assert.equal(frame.preferences_complete, false);
  assert.equal(frame.effective_preferences, undefined);
  assert.equal(frame.preferences_omitted, undefined);
});
