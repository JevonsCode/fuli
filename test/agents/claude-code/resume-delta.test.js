// rec#40 / rec#47, rec#11 D-69: the second turn of a Claude Code session is a
// delta, also when every turn is a new `claude -p --resume <id>` process and
// when the part of the entry that always stayed was over the inline limit.
// Synthetic preferences, transcripts and sessions only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeLifecycleOutput } from '../../../src/agents/claude-code/lifecycle-hook.js';
import { syntheticPreference } from '../../../test-support/synthetic-context-session.js';
import { claudeEntrySession, syntheticLargeEntry, syntheticPreferences } from '../../../test-support/synthetic-large-entry.js';

const INLINE_CHARS = 9000;
const keys = items => (items ?? []).map(item => item.preference_key);

// Each `claude -p --resume <id>` process fires SessionStart(source=resume)
// before its UserPromptSubmit; the session ID and transcript stay the same,
// and Claude Code replays that transcript into the model's context. Returns
// the hook output and how often it looked up the session's current task.
async function resumeProcess(session) {
  let lookups = 0;
  const output = await claudeLifecycleOutput('SessionStart',
    { session_id: session.sessionId, transcript_path: session.host.path, source: 'resume' },
    async () => { throw new Error('no task read expected'); },
    { delivery: session.delivery, currentTask: async () => { lookups++; return null; } });
  return { output, lookups };
}

test('control: two turns in one Claude Code process, the second is a delta', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const first = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-1' }));
    const second = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-2' }));
    assert.equal(second.frame.preference_delivery?.status, 'delta');
    assert.equal(second.frame.preference_delivery.base_revision, first.frame.revision);
  }));

test('a SessionStart resume keeps the delta base: Claude Code replays the same transcript (cause A)', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const first = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-1' }));
    const resumed = await resumeProcess(session);
    const second = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-2' }));
    assert.equal(second.frame.preference_delivery?.status, 'delta', `${second.text.length} chars`);
    // No full restore either: the replayed frame is still in the model's context.
    assert.deepEqual(resumed, { output: {}, lookups: 0 });
    assert.equal(second.frame.preference_delivery.base_revision, first.frame.revision);
    assert.ok(second.text.length < 3000, `${second.text.length} chars`);
    // A compaction still starts a new generation.
    await claudeLifecycleOutput('PreCompact', { session_id: session.sessionId, transcript_path: session.host.path },
      async () => { throw new Error('no task read expected'); }, { delivery: session.delivery });
    const third = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-3' }));
    assert.equal(third.frame.preference_delivery, undefined, 'complete after a compaction');
  }));

// rec#47: 26 of 31 preferences were always inline and over the preview alone.
const hardRules = count => Array.from({ length: count }, (_, index) => syntheticPreference(`hard-${index + 1}`,
  `SYNTHETIC_HARD_${index + 1}: ${'Run the full suite before every commit. '.repeat(10)}`, { constraint: 'hard' },
  'judgment_preference'));

test('an always-inline set over the limit is trimmed, hard rules first, and the next turn is a delta (cause B)', () =>
  claudeEntrySession(async session => {
    const hard = hardRules(26);
    const items = [...syntheticPreferences(5, { hardEvery: 100, boundaryEvery: 100 }), ...hard];
    const first = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-1' }));
    assert.ok(first.text.length <= INLINE_CHARS, `${first.text.length} chars`);
    const sent = keys(first.frame.effective_preferences);
    assert.ok(sent.length > 0);
    assert.deepEqual(sent.filter(key => !keys(hard).includes(key)), [], 'hard rules first');
    assert.deepEqual([first.frame.preferences_omitted.count, first.frame.preferences_omitted.includes_always_inline],
      [31 - sent.length, true]);
    const second = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-2' }));
    assert.equal(second.frame.preference_delivery?.status, 'delta', `${second.text.length} chars`);
    assert.equal(second.frame.preference_delivery.base_revision, first.frame.revision);
    assert.equal(second.frame.preferences_omitted.includes_always_inline, true);
    assert.ok(second.text.length < 3000, `${second.text.length} chars`);
  }));

test('an unmarked judgment boundary is ranked, not always inline: it goes before general taste', () =>
  claudeEntrySession(async session => {
    const boundaries = Array.from({ length: 26 }, (_, index) => syntheticPreference(`boundary-${index + 1}`,
      `SYNTHETIC_BOUNDARY_${index + 1}: ${'Write the rollback plan into the review. '.repeat(10)}`, {}, 'judgment_preference'));
    const general = syntheticPreferences(5, { hardEvery: 100, boundaryEvery: 100, sceneEvery: 100 });
    const first = await session.turn(syntheticLargeEntry({ items: [...general, ...boundaries], sessionId: session.sessionId,
      token: 'task-1' }));
    assert.ok(first.text.length <= INLINE_CHARS, `${first.text.length} chars`);
    const sent = keys(first.frame.effective_preferences);
    assert.ok(sent.length > 0 && sent.length < boundaries.length);
    assert.deepEqual(sent.filter(key => !keys(boundaries).includes(key)), [], 'boundaries before general taste');
    assert.equal(first.frame.preferences_omitted.includes_always_inline, undefined);
    const second = await session.turn(syntheticLargeEntry({ items: [...general, ...boundaries], sessionId: session.sessionId,
      token: 'task-2' }));
    assert.equal(second.frame.preference_delivery?.status, 'delta');
  }));
