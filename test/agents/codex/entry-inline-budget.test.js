// Codex keeps about 10,000 UTF-8 bytes of a hook context and records a longer
// one as a cut preview that the model reads only in part and that confirms no
// frame. Its task entry is bounded like Claude Code's, in bytes. Synthetic
// entries, transcripts and preferences only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX_ENTRY_INLINE_BYTES, codexLifecycleOutput } from '../../../src/agents/codex/lifecycle-event.js';
import { ALWAYS_INLINE_OMITTED_LABEL, OMITTED_PREFERENCES_LABEL } from '../../../src/conversations/entry-inline-budget.js';
import { copyPreferenceScope } from '../../../src/conversations/preference-snapshot.js';
import { syntheticPreference } from '../../../test-support/synthetic-context-session.js';
import { codexEntrySession, hookFrame, realScalePreferences, syntheticLargeEntry, syntheticWorkingEntry }
  from '../../../test-support/synthetic-large-entry.js';

const SESSION = '019fd0f0-65da-7611-a464-6c16668621a5';
const input = { session_id: SESSION, turn_id: 'synthetic-turn', cwd: '/synthetic/project', prompt: 'fix the export bug' };
const bytes = text => Buffer.byteLength(text);
const keys = items => (items ?? []).map(item => item.preference_key);
const hardKeys = items => keys(items.filter(item => item.preference_qualifiers?.constraint === 'hard'));
const label = text => text.slice(0, text.lastIndexOf('\n'));
const omittedRead = token => ({ tool: 'read_task_preferences', arguments: { taskContextToken: token },
  call: 'fuli_call(toolName=tool, input=arguments)' });
const codexEntry = async entry => (await codexLifecycleOutput('UserPromptSubmit', input, async () => entry))
  .hookSpecificOutput.additionalContext;

test('the Codex limit leaves room for the notices appended after the entry within the 10,000 bytes Codex keeps', () => {
  assert.equal(CODEX_ENTRY_INLINE_BYTES, 9000);
});

for (const [name, build] of [['working', syntheticWorkingEntry], ['large', async options => syntheticLargeEntry(options)]]) {
  test(`a real-scale ${name} entry fits in bytes, lists or flags every hard rule, counts the rest and names their read`, () =>
    codexEntrySession(async session => {
      const items = realScalePreferences();
      const entry = token => build({ items, sessionId: session.sessionId, token, sourceApplication: 'codex' });
      const first = await session.turn(await entry('task-1'));
      assert.ok(bytes(first.text) <= CODEX_ENTRY_INLINE_BYTES, `${bytes(first.text)} bytes`);
      const frame = first.frame;
      const listed = keys(frame.effective_preferences);
      assert.equal(listed.length + frame.preferences_omitted.count, 70, 'every preference is listed or counted');
      assert.deepEqual(frame.preferences_omitted.read, omittedRead('task-1'), 'one read returns every one');
      assert.ok(label(first.text).includes(OMITTED_PREFERENCES_LABEL));
      const missing = hardKeys(items).filter(key => !listed.includes(key));
      // A hard rule left out is never silent: the frame and its label say so.
      assert.equal(frame.preferences_omitted.includes_always_inline, missing.length ? true : undefined);
      assert.equal(label(first.text).includes(ALWAYS_INLINE_OMITTED_LABEL), missing.length > 0);
      assert.ok(listed.length > 0, 'the hard rules that fit are spelled out');
      if (name === 'large') assert.deepEqual(missing, [], 'beside a lean entry every hard rule fits');

      // Recorded whole, the frame is confirmed: the next turns are deltas on it, inside the limit.
      const second = await session.turn(await entry('task-2'));
      assert.equal(second.frame.preference_delivery?.status, 'delta');
      assert.ok(bytes(second.text) <= CODEX_ENTRY_INLINE_BYTES, `${bytes(second.text)} bytes`);
      const third = await session.turn(await entry('task-3'));
      assert.equal(third.frame.preference_delivery?.status, 'delta');
      assert.ok(bytes(third.text) <= bytes(first.text), `${bytes(third.text)} bytes`);
      assert.equal(third.frame.preferences_omitted.read.arguments.taskContextToken, 'task-3');
    }));
}

test('the limit counts UTF-8 bytes: an entry under 9,000 characters of Chinese text is still bounded', async () => {
  const items = Array.from({ length: 20 }, (_, index) => syntheticPreference(`rule-${index + 1}`,
    `合成习惯 ${index + 1}：${'提交前先跑相关测试，结果照实写进汇报。'.repeat(4)}`));
  const entry = syntheticLargeEntry({ items, sessionId: SESSION, conflicts: false, sourceApplication: 'codex' });
  const text = await codexEntry(entry);
  assert.ok(bytes(text) <= CODEX_ENTRY_INLINE_BYTES, `${bytes(text)} bytes`);
  // Whole, it is under the limit in characters: only the bytes bound it.
  const whole = JSON.stringify(entry);
  assert.ok(whole.length < CODEX_ENTRY_INLINE_BYTES && bytes(whole) > CODEX_ENTRY_INLINE_BYTES, `${whole.length} chars`);
  const frame = hookFrame(text);
  assert.ok(frame.preferences_omitted.count > 0, 'some are left out to stay under the byte limit');
  assert.equal(frame.effective_preferences.length + frame.preferences_omitted.count, 20);
});

test('an entry that fits is unchanged', async () => {
  const items = realScalePreferences().slice(0, 3);
  const entry = syntheticLargeEntry({ items, sessionId: SESSION, conflicts: false, sourceApplication: 'codex' });
  const frame = hookFrame(await codexEntry(entry));
  assert.deepEqual(keys(frame.effective_preferences), keys(items));
  assert.equal(frame.preferences_omitted, undefined);
});

// The other Codex paths that deliver a task context are bounded the same way,
// from what read_task_preferences returns.
const currentTask = async sessionId => ({ token: 'task-current', sessionId, sourceApplication: 'codex', checkpoint: {} });
const recovered = async (_name, parameters) => {
  const entry = await syntheticWorkingEntry({ items: realScalePreferences(), sessionId: SESSION,
    token: parameters.taskContextToken, sourceApplication: 'codex' });
  return copyPreferenceScope(entry, { ...entry, checkpoint_required: true, checkpoint_guidance: undefined,
    preference_delivery: { status: 'complete' }, preferences_complete: true, same_task_recovery_available: true, truncated: false });
};

for (const [path, run] of [
  ['compaction restore', () => codexLifecycleOutput('SessionStart', { session_id: SESSION, source: 'compact' }, recovered,
    { currentTask })],
  ['host turn refresh', () => codexLifecycleOutput('UserPromptSubmit', { ...input, isMeta: true }, recovered, { currentTask })]
]) {
  test(`a ${path} is bounded in bytes and names the task's own read`, async () => {
    const text = (await run()).hookSpecificOutput.additionalContext;
    assert.ok(bytes(text) <= CODEX_ENTRY_INLINE_BYTES, `${bytes(text)} bytes`);
    const frame = hookFrame(text);
    assert.equal(frame.effective_preferences.length + frame.preferences_omitted.count, 70);
    assert.deepEqual(frame.preferences_omitted.read, omittedRead('task-current'));
    assert.equal(Object.hasOwn(frame, 'preferences_complete'), false, 'a bounded frame claims no complete set');
  });
}
