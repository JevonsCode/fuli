// rec#47 F1b, rec#11 D-54: the Claude Code task entry fits the host's inline
// limit and stays a frame the session can confirm. Synthetic entries,
// transcripts and preferences only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeLifecycleOutput } from '../../../src/agents/claude-code/lifecycle-event.js';
import { codexLifecycleOutput } from '../../../src/agents/codex/lifecycle-event.js';
import { PASS_TASK_TOKEN, TASK_RULES_ON_DEMAND, taskClosingInstruction } from '../../../src/agents/lifecycle-message.js';
import { compactTaskContext } from '../../../src/conversations/task-context-view.js';
import { copyPreferenceScope } from '../../../src/conversations/preference-snapshot.js';
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
// What an omission names as the way to read the rest: the tool, its own
// arguments, and the one call a chat-profile client can copy (rec#137).
const omittedRead = token => ({ tool: 'read_task_preferences', arguments: { taskContextToken: token },
  call: 'fuli_call(toolName=tool, input=arguments)' });
// The omission without its index, so a shape assertion stays about the shape.
const omittedShape = ({ index: _index, ...rest }) => rest;

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
  assert.deepEqual(omittedShape(frame.preferences_omitted), { count: 60 - sent.length, read: omittedRead('task-large') });
  // Every one of them is named, so nothing it left out is a mystery (rec#137).
  assert.equal(frame.preferences_omitted.index.length, frame.preferences_omitted.count);
  assert.deepEqual(frame.preferences_omitted.index.filter(line => sent.some(key => line.startsWith(`${key} `))), []);
  assert.ok(text.split('\n')[0].includes(OMITTED_PREFERENCES_LABEL));
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

  // With many preferences they keep their floor, half the limit (design T3):
  // the index is kept beside it, and only bodies past the floor give way to it.
  const many = syntheticPreferences(60);
  const withIndex = hookFrame(await claudeEntry(syntheticLargeEntry({ items: many, sessionId: SESSION, recall: syntheticIndexRecall(5) })));
  const without = hookFrame(await claudeEntry(syntheticLargeEntry({ items: many, sessionId: SESSION })));
  assert.equal(withIndex.task_knowledge_recall.knowledge_index.items.length, 5);
  const hard = many.filter(item => kind(item.instruction) === 'HARD').map(item => item.preference_key);
  assert.deepEqual(hard.filter(key => !keys(withIndex.effective_preferences).includes(key)), []);
  assert.ok(withIndex.effective_preferences.length > hard.length, 'more than the hard rules are listed in full');
  assert.deepEqual(keys(withIndex.effective_preferences).filter(key => !keys(without.effective_preferences).includes(key)), [],
    'the index costs only bodies past the floor');
  assert.ok(withIndex.effective_preferences.length < without.effective_preferences.length);
});

// rec#75: a delivered preference names its item for revise_personal_knowledge;
// past the inline limit the IDs go before any preference does.
test('preference IDs are dropped before any preference is left out', async () => {
  const fitting = hookFrame(await claudeEntry(syntheticLargeEntry({ items: syntheticPreferences(4), sessionId: SESSION })));
  assert.deepEqual(fitting.effective_preferences.map(item => item.id), syntheticPreferences(4).map(item => item.id));
  assert.equal(fitting.effective_preferences.some(item => 'item_kind' in item), false, 'entity is the default kind');
  let found = null;
  for (let count = 8; count <= 24 && !found; count++) {
    for (let length = 300; length <= 440 && !found; length += 5) {
      const items = syntheticPreferences(count, { length });
      const frame = hookFrame(await claudeEntry(syntheticLargeEntry({ items, sessionId: SESSION })));
      if (frame.preferences_omitted === undefined && !frame.effective_preferences[0].id) found = { items, frame };
    }
  }
  assert.ok(found, 'some synthetic entry fits only without its preference IDs');
  assert.deepEqual(keys(found.frame.effective_preferences), keys(found.items), 'every preference stays');
  assert.equal(found.frame.effective_preferences.some(item => item.id), false);
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
    // The first frame already lists what one complete frame holds, so the
    // delta's room spells out no more (design T3: the generation's cap).
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
    // One listed preference is deleted, so this frame is complete, and three
    // new hard rules take the room of ranked ones the first frame sent.
    const [deleted] = keys(first.frame.effective_preferences).filter(key => !key.endsWith('12') && !key.endsWith('24'));
    const hard = [1, 2, 3].map(index => syntheticPreference(`new-hard-${index}`,
      `SYNTHETIC_HARD_NEW_${index}: ${'Never push a shared branch without review. '.repeat(20)}`, { constraint: 'hard' }, 'judgment_preference'));
    const rest = items.filter(item => item.preference_key !== deleted);
    const second = await session.turn(syntheticLargeEntry({ items: [...rest, ...hard], sessionId: session.sessionId, token: 'task-2' }));
    const demoted = keys(first.frame.effective_preferences)
      .filter(key => key !== deleted && !keys(second.frame.effective_preferences).includes(key));
    assert.ok(demoted.length > 0);
    assert.equal(second.frame.preference_delivery, undefined, 'a complete frame, not a delta that removes them');
    // It replaces the earlier set: what is gone is named, what it only leaves out is not.
    assert.deepEqual(second.frame.preferences_removed, [deleted]);
    assert.deepEqual(keys(hard).filter(key => !keys(second.frame.effective_preferences).includes(key)), []);
    assert.equal(second.frame.preferences_omitted.count, 32 - second.frame.effective_preferences.length);
    assert.notEqual(second.frame.revision, first.frame.revision);
  }));

// Design T3: a later frame never lists fewer than its base, so new hard rules
// arrive as a delta and push nothing out.
test('new preferences are added to the held set as a delta, never by leaving a held one out', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(30);
    const first = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-1' }));
    const hard = [1, 2, 3].map(index => syntheticPreference(`new-hard-${index}`,
      `SYNTHETIC_HARD_NEW_${index}: ${'Never push a shared branch without review. '.repeat(10)}`, { constraint: 'hard' }, 'judgment_preference'));
    const second = await session.turn(syntheticLargeEntry({ items: [...items, ...hard], sessionId: session.sessionId, token: 'task-2' }));
    assert.ok(second.text.length <= INLINE_CHARS);
    assert.equal(second.frame.preference_delivery.status, 'delta');
    assert.deepEqual(keys(hard).filter(key => !keys(second.frame.preference_updates).includes(key)), []);
    assert.deepEqual(second.frame.preference_delivery.removed, []);
    assert.equal(second.frame.preference_delivery.unchanged, first.frame.effective_preferences.length);
  }));

// Design T3: holding the set means never fewer, not never more. A first frame
// beside a rich recall spells out about the preferences' floor; a later turn
// with a light recall catches up, as deltas, to what one complete frame holds
// beside the leanest context, and no further: a rich recall again takes none
// back, a light one adds none past it.
test('a later frame never lists fewer than its base and catches up to one complete frame\'s worth as deltas', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const entry = (token, recall) => syntheticLargeEntry({ items, sessionId: session.sessionId, token,
      recall: syntheticRecall(recall, { length: 700 }), conversation: syntheticRecovery(recall ? 4 : 0, { length: 600 }) });
    const first = await session.turn(entry('task-1', 6));
    const alone = hookFrame(await claudeEntry(syntheticLargeEntry({ items, sessionId: SESSION })));
    assert.ok(first.frame.effective_preferences.length < alone.effective_preferences.length, 'the rich recall took room');
    let listed = new Set(keys(first.frame.effective_preferences));
    for (const [token, recall, adds] of [['task-2', 1, true], ['task-3', 1, false], ['task-4', 6, false]]) {
      const { text, frame } = await session.turn(entry(token, recall));
      assert.ok(text.length <= INLINE_CHARS, `${token}: ${text.length} chars`);
      assert.equal(frame.preference_delivery.status, 'delta', `${token}: never resent whole`);
      assert.deepEqual(frame.preference_delivery.removed, [], token);
      assert.equal(frame.preference_delivery.unchanged, listed.size, `${token}: none taken back`);
      const added = keys(frame.preference_updates);
      assert.deepEqual(added.filter(key => listed.has(key)), [], `${token}: only bodies not yet spelled out`);
      assert.equal(added.length > 0, adds, `${token}: ${added.length} added`);
      listed = new Set([...listed, ...added]);
      assert.equal(frame.preferences_omitted?.count ?? 0, 60 - listed.size, token);
    }
    assert.ok(listed.size <= alone.effective_preferences.length, 'never past what one complete frame holds');
  }));

// A frame that spells out more names itself as the next base. While it is
// still on its way (no answer since, not recorded), the next frame adds none
// and builds on what is recorded, so a lost one leaves no base unfound.
test('while a frame that spelled out more is on its way, the next one adds none and builds on the recorded base', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const entry = (token, recall = 1) => syntheticLargeEntry({ items, sessionId: session.sessionId, token,
      recall: syntheticRecall(recall, { length: 700 }), conversation: syntheticRecovery(recall > 1 ? 4 : 0, { length: 600 }) });
    const first = await session.turn(entry('task-1', 6));
    const lost = await session.turn(entry('task-2'), { record: false });
    assert.ok(lost.frame.preference_updates.length > 0);
    const next = await session.turn(entry('task-3'));
    assert.equal(next.frame.preference_delivery.base_revision, first.frame.revision);
    assert.deepEqual([next.frame.preference_updates, next.frame.preference_delivery.removed], [[], []]);
    await session.host.say('assistant', 'SYNTHETIC reply.');
    const after = await session.turn(entry('task-4'));
    assert.ok(after.frame.preference_updates.length > 0, 'once answered, it spells out more again');
  }));

// A preference the person just added that ranks within the cap does not use
// it up: main would give it a body on the next turn, so a session already at
// its cap does too, as a delta, and keeps every body it held.
test('a preference added at the cap that ranks within it arrives in full as a delta', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const first = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-1' }));
    const added = syntheticPreference('synthetic-added-scene', 'SYNTHETIC added: name each exported field by its unit.',
      { tasteDomain: 'code' }, 'taste');
    const { text, frame } = await session.turn(syntheticLargeEntry({ items: [added, ...items], sessionId: session.sessionId,
      token: 'task-2' }));
    assert.ok(text.length <= INLINE_CHARS, `${text.length} chars`);
    assert.equal(frame.preference_delivery.status, 'delta', 'never resent whole');
    assert.deepEqual(keys(frame.preference_updates), ['synthetic-added-scene']);
    assert.deepEqual(frame.preference_delivery.removed, []);
    assert.equal(frame.preference_delivery.unchanged, first.frame.effective_preferences.length);
  }));

test('a preference added or changed since the base frame is delivered as a delta where it fits', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const entry = (token, list) => syntheticLargeEntry({ items: list, sessionId: session.sessionId, token,
      recall: syntheticRecall(6, { length: 300 }) });
    const first = await session.turn(entry('task-1', items));
    const [changedKey] = keys(first.frame.effective_preferences).slice(-1);
    // A boundary ranks first, so it is among the bodies the generation's cap
    // holds; a new one ranked low would compete for that room like any other.
    const added = syntheticPreference('synthetic-added', 'SYNTHETIC added: ask before deleting shared data.', {}, 'judgment_preference');
    const next = [...items.map(item => item.preference_key === changedKey
      ? { ...item, instruction: `${item.instruction} (changed)` } : item), added];
    const { frame } = await session.turn(entry('task-2', next));
    assert.equal(frame.preference_delivery.status, 'delta');
    const updates = keys(frame.preference_updates);
    assert.deepEqual([changedKey, 'synthetic-added'].filter(key => !updates.includes(key)), []);
    assert.deepEqual(frame.preference_delivery.removed, []);
    assert.equal(frame.preference_delivery.unchanged, first.frame.effective_preferences.length - 1);
  }));

// Only where the held set no longer fits does a frame list fewer: here one is
// deleted, so the frame must be complete, and another grew. The changed one
// keeps its new body, so the model is not left with its old one and a line;
// lower-ranked ones give way, and the hard rules stay.
test('a held set that no longer fits gives way in a complete frame that keeps the changed preference', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const first = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-1' }));
    const listed = keys(first.frame.effective_preferences);
    const number = key => Number(key.split('-')[1]);
    const byKey = new Map(items.map(item => [item.preference_key, item]));
    const hard = items.filter(item => kind(item.instruction) === 'HARD').map(item => item.preference_key);
    // The lowest-ranked one listed: the scene items rank by the Provider's order.
    const [grown] = listed.filter(key => kind(byKey.get(key).instruction) === 'SCENE').sort((a, b) => number(b) - number(a));
    const [deleted] = listed.filter(key => kind(byKey.get(key).instruction) === 'SCENE' && key !== grown);
    const next = items.filter(item => item.preference_key !== deleted).map(item => item.preference_key === grown
      ? { ...item, instruction: `${item.instruction} ${'SYNTHETIC grown clause. '.repeat(80)}` } : item);
    const { text, frame } = await session.turn(syntheticLargeEntry({ items: next, sessionId: session.sessionId, token: 'task-2' }));
    assert.ok(text.length <= INLINE_CHARS, `${text.length} chars`);
    assert.equal(frame.preference_delivery, undefined, 'a complete frame');
    const sent = keys(frame.effective_preferences);
    assert.ok(sent.includes(grown), 'the changed one keeps its new body');
    assert.deepEqual(hard.filter(key => !sent.includes(key)), []);
    assert.ok(listed.some(key => key !== deleted && !sent.includes(key)), 'others gave way to it');
    assert.deepEqual(frame.preferences_removed, [deleted]);
  }));

// Another work kind in the same generation is another scope: the frame is
// complete anyway, so it chooses afresh for the new scope, and the old scope's
// own preferences are not taken as spelled out.
test('a frame in another scope chooses afresh and names what the old scope had that no longer applies', () =>
  claudeEntrySession(async session => {
    const shared = syntheticPreferences(40);
    const scoped = workKind => Array.from({ length: 6 }, (_, index) => syntheticPreference(`${workKind}-${index + 1}`,
      `SYNTHETIC ${workKind} rule ${index + 1}: ${'Keep the scope of this rule narrow and say so. '.repeat(6)}`, { workKind }, 'taste'));
    const turn = (token, workKind) => session.turn(syntheticLargeEntry({ items: [...scoped(workKind), ...shared],
      sessionId: session.sessionId, token, workKind, recall: syntheticRecall(6, { length: 300 }) }));
    const first = await turn('task-1', 'implementation');
    const old = keys(first.frame.effective_preferences).filter(key => key.startsWith('implementation-'));
    assert.ok(old.length > 0);
    const second = await turn('task-2', 'architecture');
    assert.ok(second.text.length <= INLINE_CHARS, `${second.text.length} chars`);
    assert.equal(second.frame.preference_delivery, undefined, 'a complete frame');
    const sent = keys(second.frame.effective_preferences);
    assert.deepEqual(sent.filter(key => key.startsWith('implementation-')), []);
    assert.ok(sent.filter(key => key.startsWith('architecture-')).length >= old.length, 'the new scope ranks its own first');
    assert.equal(second.frame.preferences_removed, undefined, 'none was deleted');
    assert.deepEqual(second.frame.preferences_out_of_scene, scoped('implementation').map(item => item.preference_key)
      .filter(key => old.includes(key)).sort());
    // Fresh, as a new session's first frame in that scope would be.
    const fresh = hookFrame(await claudeEntry(syntheticLargeEntry({ items: [...scoped('architecture'), ...shared], sessionId: SESSION,
      workKind: 'architecture', recall: syntheticRecall(6, { length: 300 }) })));
    assert.deepEqual(sent, keys(fresh.effective_preferences));
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
  assert.deepEqual(omittedShape(frame.preferences_omitted), { count: 35 - sent.length, includes_always_inline: true,
    read: omittedRead('task-large') });
  assert.ok(text.split('\n')[0].includes(ALWAYS_INLINE_OMITTED_LABEL));
  // Trimmed hard rules are still named one by one, so none of them is a surprise.
  assert.equal(frame.preferences_omitted.index.length, frame.preferences_omitted.count);
  assert.equal(frame.taskContextToken, 'task-large');
  assert.equal(frame.checkpoint_required, true);
});

// Review of #1070: where the hard rules do not all fit, their prefix was
// searched with the index already in, so the index's bytes came out of hard
// rule bodies (35 hard rules: 11 listed on main, 9 with the index). The index
// only takes the room the hard-rule prefix leaves. These counts are what the
// same synthetic entries list with no index at all.
test('the index never costs a hard rule its full body, however many hard rules there are', async () => {
  const hardRule = index => syntheticPreference(`hard-${index + 1}`,
    `SYNTHETIC_HARD_${index + 1}: ${'Run the full suite before every commit. '.repeat(10)}`, { constraint: 'hard' }, 'judgment_preference');
  const cases = [
    ['35 hard rules only', Array.from({ length: 35 }, (_, index) => hardRule(index)), 11],
    ['60 preferences, 30 of them hard', syntheticPreferences(60, { hardEvery: 2 }), 11],
    ['80 preferences, 26 of them hard', syntheticPreferences(80, { hardEvery: 3 }), 11]
  ];
  for (const [name, items, expected] of cases) {
    const frame = hookFrame(await claudeEntry(syntheticLargeEntry({ items, sessionId: SESSION })));
    const hard = keys(items.filter(item => item.preference_qualifiers?.constraint === 'hard'));
    const listed = keys(frame.effective_preferences).filter(key => hard.includes(key));
    assert.equal(listed.length, expected, `${name}: hard rules listed in full`);
    assert.equal(keys(frame.effective_preferences).length, listed.length, `${name}: nothing before a hard rule`);
  }
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

// #1087 x #1063: in a project divided into workstreams, a turn that carries on
// a line is a delta on the turn that opened it: the line's short standing_owner
// rides along, the team block names the lines, and no habit is sent again.
test('a turn that carries on a workstream is a delta with its short standing_owner and no habit sent again', async () => {
  const { workstreamEntry } = await import('../../../src/graphiti/task-entry-workstream.js');
  const line = continuing => workstreamEntry({ standingWorkstream: { assignmentId: 'assignment-synthetic-line',
    workstream: 'Synthetic landing page', leadAgentId: 'synthetic-member', matchedTerms: ['landing page'],
    matchedOn: ['words'], termsOn: { words: ['landing page'] }, continuing } },
  { standingAgentApplied: true, standingOwnerName: 'Synthetic Member', agent: null }).field;
  assert.ok(line(false).notice, 'the line is named once');
  assert.deepEqual(line(true), { status: 'workstream', assignment_id: 'assignment-synthetic-line', workstream: 'Synthetic landing page' });
  const team = { roster: [{ agent_id: 'synthetic-lead', name: 'Synthetic Lead', role: 'lead' },
    { agent_id: 'synthetic-member', name: 'Synthetic Member', role: 'member' }],
  workstreams: [{ workstream: 'Synthetic landing page', owner_agent_id: 'synthetic-member', owner_name: 'Synthetic Member' }] };
  await claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const entry = (token, continuing) => {
      const value = syntheticLargeEntry({ items, sessionId: session.sessionId, token });
      return copyPreferenceScope(value, { ...value, standing_owner: line(continuing), project_agent_context: { team } });
    };
    const first = await session.turn(entry('task-1', false));
    assert.equal(first.frame.standing_owner.notice, line(false).notice);
    assert.deepEqual(first.frame.project_agent_context.team.workstreams, [{ name: 'Synthetic landing page', owner: 'Synthetic Member' }]);
    await session.host.say('assistant', 'SYNTHETIC reply.');
    const next = await session.turn(entry('task-2', true));
    assert.ok(next.text.length <= INLINE_CHARS);
    assert.equal(next.frame.preference_delivery.status, 'delta');
    assert.equal(next.frame.preference_delivery.base_revision, first.frame.revision);
    assert.deepEqual([next.frame.preference_updates, next.frame.preference_delivery.removed], [[], []]);
    assert.equal(next.frame.preference_delivery.unchanged, first.frame.effective_preferences.length);
    assert.deepEqual(next.frame.standing_owner, line(true));
    assert.equal(/SYNTHETIC_[A-Z]+_\d+: /.test(next.text), false, 'no habit body is sent again');
  });
});
