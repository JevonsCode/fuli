// rec#47 (0.21.0-beta.2 on macOS), rec#11 D-72: a working project lead's
// Claude Code entry left every preference out and was still over the preview,
// so no frame was confirmed and no turn was a delta. Synthetic entries,
// transcripts and preferences only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeLifecycleOutput } from '../../../src/agents/claude-code/lifecycle-hook.js';
import { BLOCKED_PREFERENCE_LABEL } from '../../../src/mcp/preference-delivery.js';
import { OMITTED_CONFLICTS_LABEL, OMITTED_PREFERENCES_LABEL } from '../../../src/conversations/entry-inline-budget.js';
import { copyPreferenceScope } from '../../../src/conversations/preference-snapshot.js';
import { syntheticPreference } from '../../../test-support/synthetic-context-session.js';
import { claudeEntrySession, hookFrame, syntheticPreferences, syntheticWorkingEntry }
  from '../../../test-support/synthetic-large-entry.js';

// Claude Code keeps about 10,000 characters inline. The entry is bounded to
// CLAUDE_ENTRY_INLINE_CHARS, which leaves room for an outdated-MCP notice.
const INLINE_CHARS = 9000;
const SESSION = '0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b84';
const input = { session_id: SESSION, cwd: '/synthetic/project', prompt: 'fix the export bug' };
const claudeEntry = async entry => (await claudeLifecycleOutput('UserPromptSubmit', input, async () => entry))
  .hookSpecificOutput.additionalContext;
const keys = items => (items ?? []).map(item => item.preference_key);
const hardRules = items => keys(items.filter(item => item.preference_qualifiers?.constraint === 'hard'));
const continuity = (entry, changes) => copyPreferenceScope(entry, { ...entry,
  project_agent_context: { ...entry.project_agent_context, ...changes } });

test('a working lead\'s entry with 31 preferences fits, keeps its hard rules, and the next turn is a delta', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(31);
    const entry = token => syntheticWorkingEntry({ items, sessionId: session.sessionId, token });
    const first = await session.turn(await entry('task-1'));
    assert.ok(first.text.length <= INLINE_CHARS, `${first.text.length} chars`);
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

    const second = await session.turn(await entry('task-2'));
    assert.equal(second.frame.preference_delivery?.status, 'delta', `${second.text.length} chars`);
    assert.equal(second.frame.preference_delivery.base_revision, frame.revision);
    assert.deepEqual(second.frame.preference_updates, []);
    assert.equal(second.frame.preference_delivery.unchanged, frame.effective_preferences.length);
    assert.equal(second.frame.preferences_omitted.count, frame.preferences_omitted.count);
    // The room the delta saves brings context back, still within the preview.
    assert.ok(second.text.length <= INLINE_CHARS, `${second.text.length} chars`);
  }));

test('working-memory previews give way to hard rules, global layer first, and keep their revision', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(31);
    const { frame, text } = await session.turn(await syntheticWorkingEntry({ items, sessionId: session.sessionId }));
    assert.ok(text.length <= INLINE_CHARS, `${text.length} chars`);
    const { memory, global_memory: global } = frame.project_agent_context;
    assert.equal(global.view, 'omitted');
    assert.equal(global.current, undefined);
    assert.deepEqual(global.read, { tool: 'get_project_agent_memory',
      arguments: { personalSpaceId: 'synthetic-space', personalProjectId: null, agentId: 'lead' } });
    assert.equal(global.requiresFullReadBeforeWrite, true);
    assert.equal(global.guidance.rules, 'fuli://rules/task-entry/global_memory_guidance');
    assert.equal(memory.view, 'omitted', 'the hard rules need the project layer\'s room too');
    assert.deepEqual(memory.read, { tool: 'get_project_agent_memory',
      arguments: { personalSpaceId: 'synthetic-space', personalProjectId: 'project', agentId: 'lead' } });
    assert.equal(memory.revision, 7);
    // Without hard rules the project layer stays, ahead of any other preference.
    const soft = syntheticPreferences(4, { hardEvery: 100 });
    const few = await session.turn(await syntheticWorkingEntry({ items: soft, sessionId: session.sessionId }));
    assert.ok(few.text.length <= INLINE_CHARS, `${few.text.length} chars`);
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
    assert.ok(first.text.length <= INLINE_CHARS, `${first.text.length} chars`);
    assert.deepEqual(first.frame.effective_preferences, []);
    assert.deepEqual(first.frame.preferences_omitted, { count: 7, includes_always_inline: true,
      read: { tool: 'read_task_preferences', arguments: { taskContextToken: 'task-1' } } });
    assert.match(first.frame.revision, /^[0-9a-f]{12}$/);
    const second = await session.turn(await entry('task-2'));
    assert.equal(second.frame.revision, first.frame.revision, 'the same set names the same revision');
    assert.equal(second.frame.preferences_omitted.read.arguments.taskContextToken, 'task-2');
  }));

// dot on #407: details never trimmed before could keep an entry over the limit.
const CONFLICTS = Array.from({ length: 25 }, (_, index) => ({ preference_key: `conflict-${index + 1}`, preference_scope: 'global',
  preference_project_id: null, preference_agent_id: null, required_action: 'Do not apply any alternative until the conflict is resolved.',
  alternatives: ['a', 'b'].map(side => syntheticPreference(`conflict-${index + 1}-${side}`,
    `SYNTHETIC_CONFLICT_${index + 1}_${side}: ${'Use one indentation style for the whole file. '.repeat(4)}`)) }));
const withConflicts = entry => copyPreferenceScope(entry, { ...entry, active_conflicts: CONFLICTS });
const label = text => text.slice(0, text.lastIndexOf('\n'));
const MEMORY_SCOPE = { personalSpaceId: 'synthetic-space', agentId: 'lead' };

test('25 active conflicts give way to the hard rules as a count, said in the label, with their reader', async () => {
  const items = syntheticPreferences(31);
  const entry = await syntheticWorkingEntry({ items, sessionId: SESSION });
  const text = await claudeEntry(withConflicts(entry));
  assert.ok(text.length <= INLINE_CHARS, `${text.length} chars`);
  assert.ok(label(text).includes(OMITTED_CONFLICTS_LABEL));
  const frame = hookFrame(text);
  assert.equal(frame.active_conflicts, undefined);
  assert.deepEqual(frame.active_conflicts_omitted, { count: 25,
    read: { tool: 'read_task_preferences', arguments: { taskContextToken: entry.taskContextToken } } });
  assert.deepEqual(hardRules(items).filter(key => !keys(frame.effective_preferences).includes(key)), [], 'every hard rule');
  // Each reduced detail names its reader with the arguments it needs.
  const { team, directorySnapshot, memory, global_memory: global } = frame.project_agent_context;
  assert.deepEqual(global.read, { tool: 'get_project_agent_memory', arguments: { ...MEMORY_SCOPE, personalProjectId: null } });
  if (memory.view === 'omitted') {
    assert.deepEqual(memory.read, { tool: 'get_project_agent_memory', arguments: { ...MEMORY_SCOPE, personalProjectId: 'project' } });
  }
  if (team.read) {
    assert.deepEqual(team, { roster_total: 4, read: { tool: 'get_project_team',
      arguments: { personalSpaceId: 'synthetic-space', personalProjectId: 'project' } } });
  }
  if (directorySnapshot.files_omitted) {
    assert.deepEqual(directorySnapshot.read, { tool: 'get_project_agent_memory', arguments: { ...MEMORY_SCOPE, personalProjectId: 'project' } });
  }
  const [manager] = frame.project_management_context.managers;
  assert.equal(manager.title_mode, 'suggest');
  assert.match(manager.guidance.summary, /read_board/);
});

test('a reduced detail comes back on its own: the conflicts stay counted while the delta keeps the memory previews', () =>
  claudeEntrySession(async session => {
    const items = syntheticPreferences(31);
    const entry = async token => withConflicts(await syntheticWorkingEntry({ items, sessionId: session.sessionId, token }));
    const first = await session.turn(await entry('task-1'));
    assert.ok(first.text.length <= INLINE_CHARS, `${first.text.length} chars`);
    const second = await session.turn(await entry('task-2'));
    assert.ok(second.text.length <= INLINE_CHARS, `${second.text.length} chars`);
    assert.equal(second.frame.preference_delivery?.status, 'delta');
    assert.equal(second.frame.active_conflicts_omitted.count, 25, 'the conflicts still do not fit');
    assert.equal(second.frame.project_agent_context.memory.view, 'preview');
    assert.ok(second.frame.project_agent_context.memory.current.memory.summary.length > 0);
  }));

test('a role too long to fit is never cut: the entry is the blocked frame, which keeps the receipt sentence', async () => {
  const entry = await syntheticWorkingEntry({ items: syntheticPreferences(31), sessionId: SESSION });
  const role = { ...entry.project_agent_context.role, responsibility: `SYNTHETIC_ROLE: ${'Own the export service. '.repeat(400)}` };
  const text = await claudeEntry(continuity(entry, { role }));
  assert.ok(text.length <= INLINE_CHARS, `${text.length} chars`);
  assert.ok(text.startsWith(BLOCKED_PREFERENCE_LABEL));
  assert.ok(label(text).includes('End your final reply with agent_receipt.markdown, unchanged and once'));
  assert.doesNotMatch(text, /Own the export service/);
  const frame = hookFrame(text);
  assert.deepEqual([frame.preference_delivery.status, frame.preference_delivery.reason], ['blocked', 'inline_budget']);
  assert.match(frame.preference_delivery.guidance, /read_task_preferences/);
  assert.equal(frame.preferences_complete, false);
  assert.equal(frame.taskContextToken, entry.taskContextToken);
  assert.equal(frame.checkpoint_required, false);
  assert.equal(frame.agent_receipt.markdown, entry.agent_receipt.markdown);
  assert.equal(frame.context.project_agent_id, 'lead');
  assert.equal(frame.effective_preferences, undefined);
});

test('a context over the limit even as the blocked frame is the unavailable output', async () => {
  const entry = await syntheticWorkingEntry({ items: syntheticPreferences(31), sessionId: SESSION });
  const output = await claudeLifecycleOutput('UserPromptSubmit', input,
    async () => continuity(entry, { selection_reason: `SYNTHETIC ${'x'.repeat(12_000)}` }));
  const text = output.hookSpecificOutput.additionalContext;
  assert.ok(text.length <= INLINE_CHARS, `${text.length} chars`);
  assert.match(output.systemMessage, /does not fit Claude Code's inline limit/);
  assert.match(text, /get_collaboration_preferences/);
  assert.doesNotMatch(text, /SYNTHETIC x/);
});

// The other prompt paths that deliver a task context to Claude Code are
// bounded too, from what read_task_preferences actually returns: its result
// declares itself complete, which a bounded frame must not repeat.
const currentTask = async sessionId => ({ token: 'task-current', sessionId, sourceApplication: 'claude_code', checkpoint: {} });
const recovered = async (name, parameters) => {
  assert.equal(name, 'read_task_preferences');
  const entry = await syntheticWorkingEntry({ items: syntheticPreferences(31), sessionId: SESSION, token: parameters.taskContextToken });
  return copyPreferenceScope(entry, { ...entry, checkpoint_required: true, checkpoint_guidance: undefined,
    project_agent_context: { ...entry.project_agent_context, wake_mode: 'preference_recovery' },
    preference_delivery: { status: 'complete' }, preferences_complete: true, same_task_recovery_available: true, truncated: false });
};
const assertBoundedRecovery = text => {
  assert.ok(text.length <= INLINE_CHARS, `${text.length} chars`);
  assert.equal(text.startsWith(BLOCKED_PREFERENCE_LABEL), false);
  assert.ok(label(text).includes(OMITTED_PREFERENCES_LABEL));
  const frame = hookFrame(text);
  assert.equal(frame.taskContextToken, 'task-current');
  assert.ok(frame.preferences_omitted.count > 0);
  for (const claim of ['preferences_complete', 'same_task_recovery_available', 'preference_delivery']) {
    assert.equal(Object.hasOwn(frame, claim), false, `${claim} is not claimed`);
  }
};

test('a host-notification turn refreshes the current task within the inline limit and claims no complete set', async () => {
  const notification = '<task-notification>\n<task-id>bsynth01x</task-id>\n<status>completed</status>\n</task-notification>';
  const output = await claudeLifecycleOutput('UserPromptSubmit', { ...input, prompt: notification }, recovered, { currentTask });
  assertBoundedRecovery(output.hookSpecificOutput.additionalContext);
});

test('a compaction restore delivers the current task within the inline limit and claims no full result', async () => {
  const output = await claudeLifecycleOutput('SessionStart', { session_id: SESSION, source: 'compact' }, recovered, { currentTask });
  const text = output.hookSpecificOutput.additionalContext;
  assertBoundedRecovery(text);
  assert.doesNotMatch(label(text), /full result/);
  assert.match(label(text), /restored current mandatory preferences for the same owned task, bounded/);
});
