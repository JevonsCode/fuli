// rec#47 F1b, rec#11 D-54: the Claude Code task entry fits the host's inline
// limit and stays a frame the session can confirm. Synthetic entries,
// transcripts and preferences only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeLifecycleOutput } from '../../../src/agents/claude-code/lifecycle-event.js';
import { codexLifecycleOutput } from '../../../src/agents/codex/lifecycle-event.js';
import { PASS_TASK_TOKEN, TASK_RULES_ON_DEMAND, taskClosingInstruction } from '../../../src/agents/lifecycle-message.js';
import { compactTaskContext } from '../../../src/conversations/task-context-view.js';
import { copyPreferenceScope } from '../../../src/conversations/preference-snapshot.js';
import { preferenceHookOutput } from '../../../src/conversations/preference-lifecycle.js';
import { ALWAYS_INLINE_OMITTED_LABEL, inlineSearchFit, OMITTED_PREFERENCES_LABEL } from '../../../src/conversations/entry-inline-budget.js';
import { syntheticPreference } from '../../../test-support/synthetic-context-session.js';
import { claudeEntrySession, hookFrame, realScalePreferences, syntheticIndexRecall, syntheticLargeEntry, syntheticPreferences, syntheticRecall,
  syntheticRecovery } from '../../../test-support/synthetic-large-entry.js';

const INLINE_CHARS = 9000;
const SESSION = '0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b84';
const input = { session_id: SESSION, cwd: '/synthetic/project', prompt: 'fix the export bug' };
const claudeEntry = async entry => (await claudeLifecycleOutput('UserPromptSubmit', input, async () => entry))
  .hookSpecificOutput.additionalContext;
// The first frame main's search alone gives a new session (inlineSearchFit
// through the same session delivery): what a session's first frame never
// spells out fewer bodies than. `build(sessionId)` is the entry.
const mainFirstFrame = build => claudeEntrySession(async ({ sessionId, delivery, input: hook }) => {
  const fit = inlineSearchFit(INLINE_CHARS, result => JSON.parse(result.content[0].text).hookSpecificOutput.additionalContext.length,
    { projectPath: hook.cwd });
  const output = await claudeLifecycleOutput('UserPromptSubmit', hook, async () => build(sessionId),
    { delivery: { deliver: (value, origin, format) => delivery.deliver(value, origin, format, fit) } });
  return hookFrame(output.hookSpecificOutput.additionalContext);
});
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

  // With many preferences the bodies are counted beside the leanest context
  // first, as on main, so they are the same with or without an index, and the
  // index gives way to them.
  const many = syntheticPreferences(60);
  const withIndex = hookFrame(await claudeEntry(syntheticLargeEntry({ items: many, sessionId: SESSION, recall: syntheticIndexRecall(5) })));
  const without = hookFrame(await claudeEntry(syntheticLargeEntry({ items: many, sessionId: SESSION })));
  assert.deepEqual(keys(withIndex.effective_preferences), keys(without.effective_preferences));
  assert.equal(withIndex.task_knowledge_recall.knowledge_index, undefined);
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
// beside a rich recall spells out what one complete frame holds beside the
// leanest context, as main does (the recall gives way to it); a later turn
// with a light recall adds none past it, and a rich recall again takes none
// back.
test('a first frame beside a rich recall lists what main would, and later frames neither take back nor add past it', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const entry = (token, recall, sessionId = session.sessionId) => syntheticLargeEntry({ items, sessionId, token,
      recall: syntheticRecall(recall, { length: 700 }), conversation: syntheticRecovery(recall ? 4 : 0, { length: 600 }) });
    const first = await session.turn(entry('task-1', 6));
    const main = await mainFirstFrame(sessionId => entry('task-1', 6, sessionId));
    assert.ok(first.frame.effective_preferences.length >= main.effective_preferences.length,
      `${first.frame.effective_preferences.length} in full, main ${main.effective_preferences.length}`);
    const alone = hookFrame(await claudeEntry(syntheticLargeEntry({ items, sessionId: SESSION })));
    let listed = new Set(keys(first.frame.effective_preferences));
    for (const token of ['task-2', 'task-3', 'task-4']) {
      const { text, frame } = await session.turn(entry(token, token === 'task-4' ? 6 : 1));
      assert.ok(text.length <= INLINE_CHARS, `${token}: ${text.length} chars`);
      assert.equal(frame.preference_delivery.status, 'delta', `${token}: never resent whole`);
      assert.deepEqual(frame.preference_delivery.removed, [], token);
      assert.equal(frame.preference_delivery.unchanged, listed.size, `${token}: none taken back`);
      assert.deepEqual(keys(frame.preference_updates), [], `${token}: none added`);
      assert.equal(frame.preferences_omitted?.count ?? 0, 60 - listed.size, token);
      listed = new Set([...listed, ...keys(frame.preference_updates)]);
      await session.host.say('assistant', 'SYNTHETIC reply.');
    }
    assert.ok(listed.size <= alone.effective_preferences.length, 'never past what one complete frame holds');
  }));

// A frame that spells out more names itself as the next base. While it is
// still on its way (no answer since, not recorded), the next frame adds none
// and builds on what is recorded, so a lost one leaves no base unfound.
test('while a frame that spelled out more is on its way, the next one adds none and builds on the recorded base', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const added = addedBoundaries(1);
    const entry = (token, list, recall = 1) => syntheticLargeEntry({ items: list, sessionId: session.sessionId, token,
      recall: syntheticRecall(recall, { length: 700 }), conversation: syntheticRecovery(recall > 1 ? 4 : 0, { length: 600 }) });
    const first = await session.turn(entry('task-1', items, 6));
    await session.host.say('assistant', 'SYNTHETIC reply.');
    const lost = await session.turn(entry('task-2', [...added, ...items]), { record: false });
    assert.ok(lost.frame.preference_updates.length > 0);
    const next = await session.turn(entry('task-3', [...added, ...items]));
    assert.equal(next.frame.preference_delivery.base_revision, first.frame.revision);
    assert.deepEqual([next.frame.preference_updates, next.frame.preference_delivery.removed], [[], []]);
    await session.host.say('assistant', 'SYNTHETIC reply.');
    const after = await session.turn(entry('task-4', [...added, ...items]));
    assert.ok(keys(after.frame.preference_updates).includes(keys(added)[0]), 'once answered, the added one arrives');
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

// Boundaries rank first, so a new one ranks within any cap.
const addedBoundaries = count => Array.from({ length: count }, (_, index) => syntheticPreference(`synthetic-new-${index + 1}`,
  `SYNTHETIC_BOUNDARY_NEW_${index + 1}: ${'Ask before touching shared data and say which data. '.repeat(8)}`, {}, 'judgment_preference'));

// A rich recall gives way to what the person just added: the recall level is
// chosen so the held set and every new body fit, and one that does not fit
// even so is still owed, so a later turn spells it out. None waits forever
// behind the line the first frame left it in the index.
test('at the cap with a rich recall, five preferences added at once all arrive in full as deltas, none taken back', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const entry = (token, list, recall) => syntheticLargeEntry({ items: list, sessionId: session.sessionId, token,
      recall: recall ? syntheticRecall(6, { length: 700 }) : null, conversation: recall ? syntheticRecovery(4, { length: 600 }) : null });
    const first = await session.turn(entry('task-1', items, false));
    const added = addedBoundaries(5);
    let listed = new Set(keys(first.frame.effective_preferences));
    const arrived = new Set();
    for (const token of ['task-2', 'task-3']) {
      const { text, frame } = await session.turn(entry(token, [...added, ...items], true));
      assert.ok(text.length <= INLINE_CHARS, `${token}: ${text.length} chars`);
      assert.equal(frame.preference_delivery.status, 'delta', `${token}: never resent whole`);
      assert.deepEqual(frame.preference_delivery.removed, [], token);
      assert.equal(frame.preference_delivery.unchanged, listed.size, `${token}: none taken back`);
      for (const key of keys(frame.preference_updates)) arrived.add(key);
      listed = new Set([...listed, ...keys(frame.preference_updates)]);
      await session.host.say('assistant', 'SYNTHETIC reply.');
    }
    assert.deepEqual(keys(added).filter(key => !arrived.has(key)), []);
  }));

// "Added on top of the cap" is for the few the person just set, not for an
// import: a generation spells out at most a quota of bodies that way (the
// cap, at least 3), the best-ranked first; the rest rank like any other and
// stay lines, also where they rank into the preferences' floor. The first
// frame has no recall, so it lists the cap. 30 older
// preferences, so the index of all of them still leaves the floor its room
// (with many more there is no floor and each frame chooses afresh, as main).
const quotaSession = batches => claudeEntrySession(async session => {
  const items = syntheticPreferences(30);
  // Another recall each turn, so each frame shows it (or its pointer).
  const entry = (token, list, recall = true) => syntheticLargeEntry({ items: list, sessionId: session.sessionId, token,
    recall: recall ? syntheticRecall(6, { length: 690 + Number(token.split('-')[1]) }) : null });
  const first = await session.turn(entry('task-1', items, false));
  const hard = first.frame.effective_preferences.filter(item => /HARD/.test(item.instruction)).length;
  const quota = Math.max(first.frame.effective_preferences.length - hard, 3);
  let listed = new Set(keys(first.frame.effective_preferences));
  let current = items;
  const frames = [];
  let turn = 1;
  for (const batch of batches) {
    current = [...batch, ...current];
    for (let again = 0; again < 3; again++) {
      const { text, frame } = await session.turn(entry(`task-${++turn}`, current));
      assert.ok(text.length <= INLINE_CHARS, `${turn}: ${text.length} chars`);
      assert.equal(frame.preference_delivery?.status, 'delta', `${turn}: never resent whole`);
      listed = new Set([...listed, ...keys(frame.preference_updates)]);
      frames.push(frame);
      await session.host.say('assistant', 'SYNTHETIC reply.');
    }
  }
  return { most: first.frame.effective_preferences.length + quota, listed, frames, total: current.length };
});

test('fifty preferences added at once spell out no more than the quota on top of the cap; the rest stay lines', async () => {
  const added = addedBoundaries(50);
  const { most, listed, frames, total } = await quotaSession([added]);
  assert.ok(listed.size <= most, `${listed.size} bodies, at most ${most}`);
  assert.ok(keys(added).filter(key => listed.has(key)).length > 1, 'the quota is used, best-ranked first');
  assert.equal(frames.at(-1).preferences_omitted.count, total - listed.size);
  assert.ok(frames.at(-1).task_knowledge_recall.facts.length > 0, 'once the quota is spent, the recall is not kept at its leanest');
});

// Each turn the person says something new, the first 3 of it get a body
// whatever is left of the quota (ADDED_QUOTA_MIN); past that the quota bounds
// the batch.
const SAID_MIN = 3;
test('ten added in each of five turns use the same quota for the generation, plus three a turn', async () => {
  const batches = Array.from({ length: 5 }, (_, batch) => addedBoundaries(10).map(item => ({ ...item,
    preference_key: `${item.preference_key}-batch-${batch + 1}` })));
  const { most, listed } = await quotaSession(batches);
  const bound = most + SAID_MIN * batches.length;
  assert.ok(listed.size <= bound, `${listed.size} bodies, at most ${bound}`);
});

// The quota bounds an import, not a person talking: once it is spent, a
// habit they say (one to three at a time) still gets its body, as on main.
const renamed = (items, tag) => items.map(item => ({ ...item, preference_key: `${item.preference_key}-${tag}` }));
test('after an import spent the quota, a habit said one at a time still arrives in full, as deltas', async () => {
  const singles = [1, 2, 3, 4].map(turn => renamed(addedBoundaries(1), `said-${turn}`));
  const { listed } = await quotaSession([addedBoundaries(50), ...singles]);
  assert.deepEqual(singles.flat().map(item => item.preference_key).filter(key => !listed.has(key)), []);
});

// A habit said after an import spent the quota, whose frame was lost, stays
// owed: it is never taken as in view, so it does not wait for a complete frame.
test('a habit said after the quota is spent, in a frame that was lost, arrives in full once a frame is delivered', () =>
  claudeEntrySession(async session => {
    let items = syntheticPreferences(30);
    let turn = 0;
    const next = async ({ record = true } = {}) => {
      const token = `task-${++turn}`;
      const { frame } = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token,
        recall: syntheticRecall(6, { length: 690 + turn }) }), { record });
      if (record) await session.host.say('assistant', 'SYNTHETIC reply.');
      return frame;
    };
    await next();
    const imported = renamed(addedBoundaries(50), 'import');
    items = [...imported, ...items];
    for (let again = 0; again < 3; again++) await next();
    const [said] = renamed(addedBoundaries(1), 'said-lost');
    items = [said, ...items];
    const lost = await next({ record: false });
    assert.ok(keys(lost.preference_updates).includes(said.preference_key), 'the lost frame spelled it out');
    let arrived = false;
    for (let again = 0; again < 2 && !arrived; again++) {
      const frame = await next();
      arrived = keys(frame.preference_updates).includes(said.preference_key);
    }
    assert.ok(arrived, 'it arrives on a delivered frame, not only on a complete one');
  }));

test('four added in each of several turns are bounded by the quota plus three a turn, and three of each arrive', async () => {
  const batches = [1, 2, 3, 4].map(turn => renamed(addedBoundaries(4), `batch-${turn}`));
  const { most, listed } = await quotaSession(batches);
  const bound = most + SAID_MIN * batches.length;
  assert.ok(listed.size <= bound, `${listed.size} bodies, at most ${bound}`);
  for (const batch of batches) assert.ok(keys(batch).filter(key => listed.has(key)).length >= SAID_MIN, keys(batch)[0]);
});

test('two preferences added at once both arrive in full', async () => {
  const added = addedBoundaries(2);
  const { listed } = await quotaSession([added]);
  assert.deepEqual(keys(added).filter(key => !listed.has(key)), []);
});

// One whose body does not fit even beside the leanest context is left to the
// index and is not owed: no turn tries it again, and the recall is not kept
// at its leanest for it.
test('an added preference too long to fit is only named, and the recall is not held down for it', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const entry = (token, list) => syntheticLargeEntry({ items: list, sessionId: session.sessionId, token,
      recall: syntheticRecall(6, { length: 690 + Number(token.split('-')[1]) }) });
    await session.turn(entry('task-1', items));
    // A scene item of this task's work kind, past the floor, and longer than
    // the room the leanest delta leaves.
    const huge = syntheticPreference('synthetic-huge', `SYNTHETIC_SCENE_HUGE: ${'Spell out every step of the release. '.repeat(220)}`,
      { tasteDomain: 'code' }, 'taste');
    for (const token of ['task-2', 'task-3']) {
      const { frame } = await session.turn(entry(token, [huge, ...items]));
      assert.equal(frame.preference_delivery.status, 'delta', token);
      assert.equal(keys(frame.preference_updates).includes('synthetic-huge'), false, token);
      assert.ok(frame.task_knowledge_recall.facts.length > 0, `${token}: the recall stays`);
      // Not owed, so no later turn tries it again.
      const [file] = (await readdir(session.cache)).filter(name => name.endsWith('.json'));
      const record = JSON.parse(await readFile(join(session.cache, file), 'utf8'));
      assert.equal(record.pending.at(-1).owed, undefined, token);
      await session.host.say('assistant', 'SYNTHETIC reply.');
    }
  }));

// A working set shaped like a real person's (realScalePreferences: 70, 9
// hard rules, Chinese bodies of about 170 characters, long keys). Its keys
// alone past the hard rules exceed half the limit, so the floor counts the
// rest rather than naming them (as the real entry frames did), and the set
// is held. One session: a prompt, five host events, three prompts (the
// second with a rich recall, the third with one habit added). Measured: a
// complete 8,823-character frame, 17 in full (main's search: 17); five
// 171-character lines; deltas of 5,300 (17 in full), 3,341 (18, the added
// one) and 3,115 characters (18), none with a keys-only index.
test('a real-scale working set keeps its floor: host events are one line, later prompts are deltas', async t => {
  const rows = [];
  let mainFirst = 0;
  await claudeEntrySession(async session => {
    let items = realScalePreferences();
    const entry = (token, recall, sessionId = session.sessionId) => syntheticLargeEntry({ items, sessionId, token,
      recall: syntheticRecall(recall, { length: 300 + Number(token.split('-')[1]) }), conversation: syntheticRecovery(2, { length: 300 }) });
    const task = { token: 'task-1', sessionId: session.sessionId, sourceApplication: 'claude_code', checkpoint: null };
    const read = async (_name, { taskContextToken }) => {
      const { task_knowledge_recall: _recall, conversation: _conversation, ...rest } = entry(taskContextToken, 0);
      return copyPreferenceScope(entry(taskContextToken, 0), { ...rest, preference_delivery: { status: 'complete' },
        preferences_complete: true, same_task_recovery_available: true, truncated: false });
    };
    let held = 0;
    const row = (turn, text) => {
      const frame = text.startsWith('{') || text.includes('\n{') ? hookFrame(text) : null;
      const kind = !frame?.taskContextToken ? 'line' : frame.preference_delivery?.status ?? 'complete';
      if (kind === 'complete') held = frame.effective_preferences.length;
      if (kind === 'delta') held = frame.preference_delivery.unchanged + frame.preference_updates.length;
      rows.push({ turn, kind, chars: text.length, inline: kind === 'line' ? '-' : held, frame });
    };
    mainFirst = (await mainFirstFrame(sessionId => entry('task-1', 2, sessionId))).effective_preferences.length;
    row('prompt 1', (await session.turn(entry('task-1', 2))).text);
    await session.host.say('assistant', 'SYNTHETIC reply.');
    for (let event = 1; event <= 5; event++) {
      row(`host event ${event}`, await session.notify(task, read));
      await session.host.say('assistant', 'SYNTHETIC reply.');
    }
    row('prompt 2 (rich recall)', (await session.turn(entry('task-2', 8))).text);
    await session.host.say('assistant', 'SYNTHETIC reply.');
    items = [{ ...syntheticPreference('remember-0123456789abcdef01234567', '合成习惯：发布前先在测试环境跑一遍完整流程，结果写进汇报。',
      {}, 'judgment_preference') }, ...items];
    row('prompt 3 (one habit added)', (await session.turn(entry('task-3', 2))).text);
    await session.host.say('assistant', 'SYNTHETIC reply.');
    row('prompt 4', (await session.turn(entry('task-4', 2))).text);
  });
  t.diagnostic(rows.map(({ turn, kind, chars, inline }) => `${turn}: ${kind}, ${chars} chars, ${inline} in full`).join('; ')
    + `; main's first frame: ${mainFirst} in full`);
  assert.deepEqual(rows.map(row => row.kind), ['complete', 'line', 'line', 'line', 'line', 'line', 'delta', 'delta', 'delta']);
  for (const { turn, chars, frame } of rows) {
    assert.ok(chars <= INLINE_CHARS, `${turn}: ${chars} chars`);
    assert.equal(frame?.preferences_not_held, undefined, `${turn}: the set is held`);
  }
  assert.equal(rows[0].frame.preferences_omitted.index, undefined, 'the rest are counted, as real entry frames show');
  assert.ok(rows[0].inline >= mainFirst, `the first frame spells out ${rows[0].inline}, main ${mainFirst}`);
  // A later frame has room because the bodies the model holds are not
  // repeated; keys alone sent for that room tell the model nothing to judge by.
  for (const { turn, frame } of rows.slice(1)) {
    assert.equal((frame?.preferences_omitted?.index ?? []).some(entry => !entry.includes(' — ')), false, `${turn}: no keys-only index`);
  }
  assert.ok(rows.slice(6).every(row => row.frame.preference_delivery.removed.length === 0), 'none taken back');
  assert.ok(keys(rows[7].frame.preference_updates).includes('remember-0123456789abcdef01234567'), 'the added habit arrives');
});

// The quota bounds an import, not a person talking, also where a frame only
// counts what it leaves out (`known` tells new from in view): once an import
// spent it, one habit said gets its body, and so do at least three of four
// said at once, rather than all of them being only counted from then on.
test('a real-scale session that only counts the rest: after an import spent the quota, a habit said arrives, and three of four', () =>
  claudeEntrySession(async session => {
    let items = realScalePreferences();
    let turn = 0;
    const next = async () => {
      const token = `task-${++turn}`;
      const { text, frame } = await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token,
        recall: syntheticRecall(2, { length: 300 + turn }), conversation: syntheticRecovery(2, { length: 300 }) }));
      assert.ok(text.length <= INLINE_CHARS, `${token}: ${text.length} chars`);
      await session.host.say('assistant', 'SYNTHETIC reply.');
      return frame;
    };
    const first = await next();
    assert.equal(first.preferences_omitted.index, undefined, 'the rest are counted');
    let listed = new Set(keys(first.effective_preferences));
    const say = async batch => {
      items = [...batch, ...items];
      for (let again = 0; again < 3; again++) {
        const frame = await next();
        assert.equal(frame.preference_delivery?.status, 'delta', `task-${turn}: never resent whole`);
        listed = new Set([...listed, ...keys(frame.preference_updates)]);
      }
    };
    const imported = renamed(addedBoundaries(50), 'import');
    await say(imported);
    assert.ok(keys(imported).some(key => !listed.has(key)), 'the import spent the quota');
    const one = renamed(addedBoundaries(1), 'said-one');
    await say(one);
    assert.deepEqual(keys(one).filter(key => !listed.has(key)), []);
    const four = renamed(addedBoundaries(4), 'said-four');
    await say(four);
    assert.ok(keys(four).filter(key => listed.has(key)).length >= 3, 'at least three of four said at once');
  }));

// What a scope had in view is kept up to 1,024 preferences: a first frame past
// that keeps that many, and a later frame that would pass it adds none, rather
// than the record forgetting all of them.
test('past 1,024 preferences the record keeps what the scope\'s first frame had in view, and adds none', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(1100, { length: 40, hardEvery: 2000 });
    const known = async () => {
      const [file] = (await readdir(session.cache)).filter(name => name.endsWith('.json'));
      return JSON.parse(await readFile(join(session.cache, file), 'utf8')).known;
    };
    await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-1' }));
    await session.host.say('assistant', 'SYNTHETIC reply.');
    const first = await known();
    assert.equal(first.ids.length, 1024);
    const added = syntheticPreferences(3, { length: 40 }).map(item => ({ ...item, preference_key: `${item.preference_key}-added` }));
    const { frame } = await session.turn(syntheticLargeEntry({ items: [...added, ...items], sessionId: session.sessionId, token: 'task-2' }));
    assert.equal(frame.preference_delivery?.status, 'delta');
    assert.deepEqual(await known(), first);
  }));

// Where the hard rules alone fill half the limit there is no floor: each frame
// is chosen afresh, as on main, and says so.
test('without a floor a bounded frame says the set is not held', async () => {
  const items = Array.from({ length: 20 }, (_, index) => syntheticPreference(`hard-${index + 1}`,
    `SYNTHETIC_HARD_${index + 1}: ${'Never push a shared branch without review. '.repeat(6)}`, { constraint: 'hard' }, 'judgment_preference'));
  const frame = hookFrame(await claudeEntry(syntheticLargeEntry({ items: [...items, ...syntheticPreferences(20)], sessionId: SESSION })));
  assert.equal(frame.preferences_not_held, 'hard rules fill half the inline limit');
});

// While the frame before is on its way, a turn adds no body (it would name a
// base the model may never see), not even a new one. The new one is owed, and
// the next turn spells it out.
test('a preference added while the frame before is on its way arrives in full on the next turn', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const entry = (token, list) => syntheticLargeEntry({ items: list, sessionId: session.sessionId, token });
    const first = await session.turn(entry('task-1', items));
    await session.turn(entry('task-2', items), { record: false });
    // A scene item of this task's work kind: past the preferences' floor,
    // which is spelled out every turn, and within the cap.
    const added = syntheticPreference('synthetic-new-scene', `SYNTHETIC_SCENE_NEW: ${'Name each exported field by its unit. '.repeat(11)}`,
      { tasteDomain: 'code' }, 'taste');
    const deferred = await session.turn(entry('task-3', [added, ...items]));
    assert.equal(deferred.frame.preference_delivery.base_revision, first.frame.revision);
    assert.deepEqual(deferred.frame.preference_updates, [], 'nothing added while the frame before is on its way');
    await session.host.say('assistant', 'SYNTHETIC reply.');
    const next = await session.turn(entry('task-4', [added, ...items]));
    assert.equal(next.frame.preference_delivery.status, 'delta');
    assert.deepEqual(keys(next.frame.preference_updates), [added.preference_key]);
    assert.deepEqual(next.frame.preference_delivery.removed, []);
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

// A workstream may hand a turn of the session to another FLA (#1063). That
// frame is complete and chooses afresh, and it names the previous FLA's own
// preferences whose bodies are still in the conversation, so the model stops
// applying them; back and forth, each hand-over names the one before.
test('a turn handed to another FLA is complete and names the previous FLA\'s own preferences, both ways', () =>
  claudeEntrySession(async session => {
    const shared = syntheticPreferences(6);
    const own = agent => [1, 2].map(index => ({ ...syntheticPreference(`${agent}-own-${index}`,
      `SYNTHETIC ${agent} rule ${index}: report what was verified.`), preference_scope: 'agent', preference_agent_id: agent }));
    const turn = async (token, agent) => {
      const result = await session.turn(syntheticLargeEntry({ items: [...shared, ...own(agent)], sessionId: session.sessionId,
        token, agent }));
      await session.host.say('assistant', 'SYNTHETIC reply.');
      return result.frame;
    };
    const names = agent => own(agent).map(item => `${item.preference_key} (agent)`);
    const first = await turn('task-1', 'lead');
    assert.equal(first.preferences_of_previous_agent, undefined);
    const handed = await turn('task-2', 'reviewer');
    assert.equal(handed.preference_delivery, undefined, 'a complete frame');
    assert.deepEqual(keys(handed.effective_preferences).sort(), keys([...shared, ...own('reviewer')]).sort());
    assert.deepEqual(handed.preferences_of_previous_agent, names('lead'));
    assert.equal(handed.preferences_removed, undefined, 'none was deleted');
    const again = await turn('task-3', 'reviewer');
    assert.equal(again.preference_delivery.status, 'delta');
    assert.equal(again.preferences_of_previous_agent, undefined);
    const back = await turn('task-4', 'lead');
    assert.equal(back.preference_delivery, undefined, 'back to the first FLA is complete too');
    assert.deepEqual(back.preferences_of_previous_agent, names('reviewer'));
    const settled = await turn('task-5', 'lead');
    assert.equal(settled.preference_delivery.status, 'delta');
    assert.equal(settled.preferences_of_previous_agent, undefined);
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
