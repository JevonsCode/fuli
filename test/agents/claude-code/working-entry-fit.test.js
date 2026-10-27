// rec#47 (0.21.0-beta.2 on macOS), rec#11 D-72: a working project lead's
// Claude Code entry left every preference out and was still over the preview,
// so no frame was confirmed and no turn was a delta. Synthetic entries,
// transcripts and preferences only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticPreference } from '../../../test-support/synthetic-context-session.js';
import { claudeEntrySession, syntheticPreferences, syntheticWorkingEntry } from '../../../test-support/synthetic-large-entry.js';

// Claude Code keeps about 10,000 characters inline; the whole context stays
// clear of that, room for an outdated-MCP notice included.
const CONTEXT_CHARS = 9500;
const keys = items => (items ?? []).map(item => item.preference_key);
const hardRules = items => keys(items.filter(item => item.preference_qualifiers?.constraint === 'hard'));

test('a working lead\'s entry with 31 preferences fits, keeps its hard rules, and the next turn is a delta', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(31);
    const entry = token => syntheticWorkingEntry({ items, sessionId: session.sessionId, token });
    const first = await session.turn(await entry('task-1'));
    assert.ok(first.text.length <= CONTEXT_CHARS, `${first.text.length} chars`);
    const frame = first.frame;
    assert.deepEqual(hardRules(items).filter(key => !keys(frame.effective_preferences).includes(key)), [], 'every hard rule');
    assert.equal(frame.preferences_omitted.count, 31 - frame.effective_preferences.length);
    assert.equal(frame.preferences_omitted.includes_always_inline, undefined);
    assert.match(frame.revision, /^[0-9a-f]{12}$/);
    // The closing fields, identity and the layers' revisions stay.
    assert.equal(frame.taskContextToken, 'task-1');
    assert.equal(frame.task_context_token, undefined, 'the hook sends the token once');
    assert.equal(frame.checkpoint_required, false);
    assert.equal(frame.agent_receipt.required, true);
    assert.equal(frame.project_agent_context.memory.revision, 7);
    assert.equal(frame.project_agent_context.global_memory.revision, 5);
    // Fixed rule text is referenced by version, not repeated each turn.
    assert.equal(frame.project_management_context.managers[0].guidance.rules, 'fuli://rules/task-entry#manager_guidance');
    assert.equal(frame.judgment_context.guidance.rules, 'fuli://rules/task-entry#judgment_guidance');
    assert.match(frame.project_management_context.managers[0].board.guidance, /read_board/);

    const second = await session.turn(await entry('task-2'));
    assert.equal(second.frame.preference_delivery?.status, 'delta', `${second.text.length} chars`);
    assert.equal(second.frame.preference_delivery.base_revision, frame.revision);
    assert.deepEqual(second.frame.preference_updates, []);
    assert.equal(second.frame.preference_delivery.unchanged, frame.effective_preferences.length);
    assert.equal(second.frame.preferences_omitted.count, frame.preferences_omitted.count);
    // The room the delta saves brings context back, still within the preview.
    assert.ok(second.text.length <= CONTEXT_CHARS, `${second.text.length} chars`);
  }));

test('working-memory previews give way to hard rules, global layer first, and keep their revision', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(31);
    const { frame, text } = await session.turn(await syntheticWorkingEntry({ items, sessionId: session.sessionId }));
    assert.ok(text.length <= CONTEXT_CHARS, `${text.length} chars`);
    const { memory, global_memory: global } = frame.project_agent_context;
    assert.equal(global.view, 'omitted');
    assert.equal(global.current, undefined);
    assert.deepEqual(global.read, { tool: 'get_project_agent_memory' });
    assert.equal(global.requiresFullReadBeforeWrite, true);
    assert.equal(global.guidance.rules, 'fuli://rules/task-entry#global_memory_guidance');
    assert.equal(memory.view, 'omitted', 'the hard rules need the project layer\'s room too');
    assert.equal(memory.revision, 7);
    // Without hard rules the project layer stays, ahead of any other preference.
    const soft = syntheticPreferences(4, { hardEvery: 100 });
    const few = await session.turn(await syntheticWorkingEntry({ items: soft, sessionId: session.sessionId }));
    assert.ok(few.text.length <= CONTEXT_CHARS, `${few.text.length} chars`);
    assert.equal(few.frame.project_agent_context.global_memory.view, 'omitted');
    const project = few.frame.project_agent_context.memory;
    assert.equal(project.view, 'preview');
    assert.ok(project.current.memory.summary.length > 0);
    assert.equal(project.current.revision, undefined, 'the layer names its revision once');
    assert.ok(few.frame.preferences_omitted.count > 0);
  }));

// A frame whose hard rules alone do not fit lists no preference; it still
// names its revision, how many it left out, and their reader.
test('a frame that leaves every preference out still carries its revision, count and reader', () =>
  claudeEntrySession(async session => {
    const hard = [1, 2].map(index => syntheticPreference(`hard-${index}`,
      `SYNTHETIC_HARD_${index}: ${'Run the full suite before every commit. '.repeat(250)}`, { constraint: 'hard' }, 'judgment_preference'));
    const items = [...hard, ...syntheticPreferences(5, { hardEvery: 100 })];
    const entry = token => syntheticWorkingEntry({ items, sessionId: session.sessionId, token });
    const first = await session.turn(await entry('task-1'));
    assert.ok(first.text.length <= CONTEXT_CHARS, `${first.text.length} chars`);
    assert.deepEqual(first.frame.effective_preferences, []);
    assert.deepEqual(first.frame.preferences_omitted, { count: 7, includes_always_inline: true,
      read: { tool: 'read_task_preferences', arguments: { taskContextToken: 'task-1' } } });
    assert.match(first.frame.revision, /^[0-9a-f]{12}$/);
    const second = await session.turn(await entry('task-2'));
    assert.equal(second.frame.revision, first.frame.revision, 'the same set names the same revision');
    assert.equal(second.frame.preferences_omitted.read.arguments.taskContextToken, 'task-2');
  }));
