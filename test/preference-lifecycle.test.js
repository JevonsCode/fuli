import assert from 'node:assert/strict';
import test from 'node:test';
import { currentTaskPreferences } from '../src/conversations/preference-lifecycle.js';

const TASK = { token: 'fuli-task-synthetic', sessionId: 'session-a', sourceApplication: 'claude_code' };
const refresh = page => currentTaskPreferences({ session_id: 'session-a' },
  { sourceApplication: 'claude_code', currentTask: async () => TASK, invoke: async () => page });

test('a hook frame never hands out the hook reader\'s cursor (rec#68)', async () => {
  const { status, context } = await refresh({ taskContextToken: TASK.token, effective_preferences: [{ instruction: 'one' }],
    preferences_complete: false, preference_delivery: { status: 'paginated', revision: 'r1', page_index: 0,
      page_count: 2, next_cursor: 'hook-process-cursor', guidance: 'Follow next_cursor.' } });
  assert.equal(status, 'refreshed');
  assert.equal('next_cursor' in context.preference_delivery, false);
  assert.match(context.preference_delivery.guidance, /read_task_preferences with this taskContextToken and no cursor/);
  assert.equal(context.preference_delivery.page_count, 2);
  assert.equal(context.preferences_complete, false);
});

test('a complete hook frame is passed through unchanged', async () => {
  const { context } = await refresh({ taskContextToken: TASK.token, effective_preferences: [],
    preferences_complete: true, preference_delivery: { status: 'complete' } });
  assert.deepEqual(context.preference_delivery, { status: 'complete' });
});
