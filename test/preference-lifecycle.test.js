import assert from 'node:assert/strict';
import test from 'node:test';
import { currentTaskPreferences } from '../src/conversations/preference-lifecycle.js';
import { createTaskPreferencePager } from '../src/graphiti/task-preference-pages.js';
import { preferenceSnapshot } from '../src/conversations/preference-snapshot.js';

const TASK = { token: 'fuli-task-synthetic', sessionId: 'session-a', sourceApplication: 'claude_code' };
const SCOPED_TASK = { ...TASK, personalProjectId: 'sample', projectAgentId: 'reader',
  preferenceScope: { version: 1, work_kind: null, workflow: null } };
// A reader result over the MCP budget, so the reader pages it.
const pagedProjection = () => ({ taskContextToken: TASK.token, task_context_token: TASK.token, checkpoint_required: true,
  preferences_complete: true, preference_delivery: { status: 'complete' }, truncated: false, same_task_recovery_available: true,
  context: { personal_space_id: 'synthetic-space', personal_project_id: 'sample', project_agent_id: 'reader' },
  effective_preferences: Array.from({ length: 12 }, (_, i) => ({ preference_key: `synthetic-${i}`, preference_scope: 'project',
    confirmation_status: 'confirmed', instruction: `Synthetic rule ${i}: ${'keep every word. '.repeat(160)}` })),
  active_conflicts: [], deferred_conflicts: [], agent_receipt: { required: true, markdown: 'Synthetic reader' } });
const refresh = page => currentTaskPreferences({ session_id: 'session-a' },
  { sourceApplication: 'claude_code', currentTask: async () => TASK, invoke: async () => page });

// rec#76: a first page alone blocks the turn and can never be confirmed, so the
// hook joins every page of the revision through its own reader process, and
// hands out no cursor (rec#68).
test('the hook joins every page of one revision into one complete, scoped frame and hands out no cursor', async () => {
  const pager = createTaskPreferencePager();
  const original = pagedProjection();
  const reads = [];
  const { status, context } = await currentTaskPreferences({ session_id: 'session-a' }, { sourceApplication: 'claude_code',
    currentTask: async () => SCOPED_TASK,
    invoke: async (name, input) => { reads.push(input.cursor ?? null); return pager.read(original, { cursor: input.cursor }); } });
  assert.equal(status, 'refreshed');
  assert.ok(reads.length > 1, 'more than one page');
  assert.equal(reads[0], null);
  assert.deepEqual(context.effective_preferences.map(item => item.preference_key),
    original.effective_preferences.map(item => item.preference_key));
  assert.deepEqual(context.preference_delivery, { status: 'complete' });
  assert.equal(context.preferences_complete, true);
  assert.doesNotMatch(JSON.stringify(context), /next_cursor|paginated/);
  assert.equal(preferenceSnapshot(context)?.sessionId, 'session-a', 'joined pages carry the task scope');
});

test('pages of another revision are refused, never joined', async () => {
  const page = (index, revision, next) => ({ taskContextToken: TASK.token, effective_preferences: [{ instruction: `p${index}` }],
    preferences_complete: next === null, preference_delivery: { status: 'paginated', revision, page_index: index, page_count: 2, next_cursor: next } });
  await assert.rejects(currentTaskPreferences({ session_id: 'session-a' }, { sourceApplication: 'claude_code', currentTask: async () => TASK,
    invoke: async (name, input) => (input.cursor ? page(1, 'r2', null) : page(0, 'r1', 'next')) }), { code: 'preference_cursor_invalid' });
});

test('a complete hook frame is passed through unchanged', async () => {
  const { context } = await refresh({ taskContextToken: TASK.token, effective_preferences: [],
    preferences_complete: true, preference_delivery: { status: 'complete' } });
  assert.deepEqual(context.preference_delivery, { status: 'complete' });
});
