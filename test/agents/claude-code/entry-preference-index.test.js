// rec#137, rec#111: with more preferences than a host's inline limit can hold,
// a task entry used to name what it left out by count alone, so the only way to
// learn what existed was to page a whole revision. It now names every one of
// them, keeps the hard rules in full, and ranks a preference whose prose states
// a scope this task never mentions below the rest. Synthetic entries,
// transcripts and preferences only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeLifecycleOutput } from '../../../src/agents/claude-code/lifecycle-event.js';
import { OMITTED_INDEX_LABEL } from '../../../src/conversations/entry-inline-budget.js';
import { syntheticPreference } from '../../../test-support/synthetic-context-session.js';
import { claudeEntrySession, hookFrame, syntheticLargeEntry, syntheticPreferences } from '../../../test-support/synthetic-large-entry.js';

const INLINE_CHARS = 9000;
const SESSION = '0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b84';
const keys = items => (items ?? []).map(item => item.preference_key);
const entryFor = async (items, prompt, cwd = '/synthetic/project') => {
  const input = { session_id: SESSION, cwd, prompt };
  const text = (await claudeLifecycleOutput('UserPromptSubmit', input,
    async () => syntheticLargeEntry({ items, sessionId: SESSION }))).hookSpecificOutput.additionalContext;
  return { text, frame: hookFrame(text) };
};

test('an entry over the inline limit names every preference it leaves out', async () => {
  const items = syntheticPreferences(30);
  const { text, frame } = await entryFor(items, 'fix the export bug');
  assert.ok(text.length <= INLINE_CHARS, `${text.length} chars`);
  const listed = keys(frame.effective_preferences);
  assert.ok(listed.length > 0 && listed.length < items.length);
  const index = frame.preferences_omitted.index;
  assert.equal(index.length, frame.preferences_omitted.count);
  assert.equal(listed.length + index.length, items.length, 'every preference is listed or named');
  // One line each: the key, then what it says. Never the whole body.
  for (const line of index) assert.match(line, /^rule-\d+ — SYNTHETIC_/);
  assert.ok(index.every(line => line.length < 60), 'an index line is short');
  assert.ok(text.split('\n')[0].includes(OMITTED_INDEX_LABEL), 'the label says the index is there');
});

test('a set too large for a line each still names the keys, and a larger one still says how many', async () => {
  const seventy = await entryFor(syntheticPreferences(75), 'fix the export bug');
  assert.ok(seventy.text.length <= INLINE_CHARS, `${seventy.text.length} chars`);
  assert.equal(seventy.frame.preferences_omitted.index.length, seventy.frame.preferences_omitted.count);
  assert.ok(seventy.frame.preferences_omitted.index.every(line => /^rule-\d+$/.test(line)), 'the cheaper tier is keys alone');
  // Past that the omission is a count again, and the entry is still delivered.
  const huge = await entryFor(syntheticPreferences(120), 'fix the export bug');
  assert.ok(huge.text.length <= INLINE_CHARS, `${huge.text.length} chars`);
  assert.ok(huge.frame.preferences_omitted.count > 0);
  assert.equal(huge.frame.preferences_omitted.index, undefined);
});

test('the index never costs a hard rule its full body', async () => {
  const items = syntheticPreferences(30);
  const { frame } = await entryFor(items, 'fix the export bug');
  const hard = keys(items.filter(item => item.preference_qualifiers?.constraint === 'hard'));
  assert.ok(hard.length >= 2);
  assert.deepEqual(hard.filter(key => !keys(frame.effective_preferences).includes(key)), []);
});

test('a preference whose prose states a scope this session\'s project does not meet ranks below the rest and is named with it', async () => {
  const scoped = syntheticPreference('synthetic-locale',
    '仅适用于合成结算需求：地区只按 locale 判断，不要用时区推断。', {}, 'personality');
  const items = [scoped, ...syntheticPreferences(29)];
  const elsewhere = await entryFor(items, '帮我评审这份合成 PRD 的验收标准');
  assert.equal(keys(elsewhere.frame.effective_preferences).includes('synthetic-locale'), false,
    'another project does not spend its inline budget on it');
  // It is never lost: the index names it and says what it is limited to.
  assert.ok(elsewhere.frame.preferences_omitted.index.some(line => line.startsWith('synthetic-locale — ')
    && line.endsWith(' · 仅适用于 合成结算需求')));
  // A session in that project gets it back in the ordinary ranking.
  const there = await entryFor(items, '帮我评审这份合成 PRD 的验收标准', '/synthetic/合成结算');
  assert.ok(keys(there.frame.effective_preferences).includes('synthetic-locale'));
});

test('the prompt does not move the selection, so the next turn of a session can be a delta', async () => {
  const scoped = syntheticPreference('synthetic-locale',
    '仅适用于合成结算需求：地区只按 locale 判断，不要用时区推断。', {}, 'personality');
  const items = [scoped, ...syntheticPreferences(29)];
  const one = await entryFor(items, '合成结算需求的地区判断改一下');
  const two = await entryFor(items, '帮我评审这份合成 PRD 的验收标准');
  assert.deepEqual(keys(one.frame.effective_preferences), keys(two.frame.effective_preferences));
});

test('the index is part of the frame, so the next turn of the same session is still a delta', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(30);
    const entry = token => syntheticLargeEntry({ items, sessionId: session.sessionId, token });
    const first = await session.turn(entry('task-1'));
    assert.ok(first.frame.preferences_omitted.index.length > 0);
    const second = await session.turn(entry('task-2'));
    assert.equal(second.frame.preference_delivery.status, 'delta');
    assert.deepEqual([second.frame.preference_updates, second.frame.preference_delivery.removed], [[], []]);
    assert.equal(second.frame.preferences_omitted.count, first.frame.preferences_omitted.count);
    // The index the base already showed is not sent again (review of #1070).
    assert.equal(second.frame.preferences_omitted.index, undefined);
    assert.equal(second.frame.preferences_omitted.index_unchanged, true);
    assert.ok(second.text.length < first.text.length / 2, `${second.text.length} chars against ${first.text.length}`);
    // And the turn after names the same index through the delta it builds on.
    const third = await session.turn(entry('task-3'));
    assert.equal(third.frame.preference_delivery.status, 'delta');
    assert.equal(third.frame.preferences_omitted.index_unchanged, true);
  }));

test('a changed set sends the index again, so the model never holds a stale one', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(30);
    const first = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-1' }));
    const omittedKey = first.frame.preferences_omitted.index.at(-1).split(' ')[0];
    // The last omitted preference is edited: still omitted, so its line changes.
    const edited = items.map(item => item.preference_key === omittedKey
      ? { ...item, instruction: `SYNTHETIC_EDITED: ${item.instruction}` } : item);
    const second = await session.turn(syntheticLargeEntry({ items: edited, sessionId: session.sessionId, token: 'task-2' }));
    assert.equal(second.frame.preferences_omitted.index_unchanged, undefined);
    assert.ok(second.frame.preferences_omitted.index.some(line => line.startsWith(`${omittedKey} — SYNTHETIC_EDITED`)));
  }));
