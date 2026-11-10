// rec#110 item 6: a blocked entry still carries its taskContextToken, so it
// says exactly what that token may be used for.
import assert from 'node:assert/strict';
import test from 'node:test';
import { successToolResult } from '../src/mcp/tool-result.js';

test('a blocked preference entry names the only tools its token is for', () => {
  const entry = { taskContextToken: 'fuli-task-synthetic', checkpoint_required: true,
    context: { source_truncated: true }, effective_preferences: [] };
  const { structuredContent } = successToolResult(entry, { preferenceContext: true, limitBytes: 32 * 1024 });
  const delivery = structuredContent.preference_delivery;
  assert.equal(delivery.status, 'blocked');
  assert.equal(delivery.reason, 'source_window');
  assert.equal(structuredContent.taskContextToken, 'fuli-task-synthetic');
  assert.deepEqual(delivery.token_use, ['read_task_preferences', 'checkpoint_task_knowledge']);
  assert.match(delivery.guidance, /only for token_use: pass it to no other FULI tool/);
});
