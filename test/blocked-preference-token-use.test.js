// rec#110 item 6: a blocked entry still carries its taskContextToken, so it
// says exactly what that token may be used for. rec#128: it names the
// same-task reader only where that reader can serve the task.
import assert from 'node:assert/strict';
import test from 'node:test';
import { successToolResult } from '../src/mcp/tool-result.js';
import { blockedPreferenceDelivery, blockedPreferenceRecovery } from '../src/mcp/preference-delivery.js';

const blockedEntry = context => successToolResult({ taskContextToken: 'fuli-task-synthetic', checkpoint_required: true,
  context: { source_truncated: true, ...context }, effective_preferences: [] }, { preferenceContext: true, limitBytes: 32 * 1024 })
  .structuredContent;

test('a blocked preference entry names the only tools its token is for', () => {
  const structuredContent = blockedEntry({ project_agent_id: 'synthetic-agent' });
  const delivery = structuredContent.preference_delivery;
  assert.equal(delivery.status, 'blocked');
  assert.equal(delivery.reason, 'source_window');
  assert.equal(structuredContent.taskContextToken, 'fuli-task-synthetic');
  assert.equal(structuredContent.same_task_recovery_available, true);
  assert.deepEqual(delivery.token_use, ['read_task_preferences', 'checkpoint_task_knowledge']);
  assert.match(delivery.guidance, /for token_use; FULI reads and searches may carry it, but no roundtable, team or write call/);
  assert.match(delivery.guidance, /Recover now: call read_task_preferences/);
  assert.match(delivery.guidance, /binds the host session its MCP process belongs to and may stay blocked, for example in a process started before \/clear/);
});

test('a blocked frame counts the active conflicts it leaves out, with their read only where recovery works', () => {
  const conflicts = [{ preference_key: 'synthetic-indent', alternatives: [{ instruction: 'tabs' }, { instruction: 'spaces' }] }];
  const entry = context => ({ taskContextToken: 'fuli-task-synthetic', checkpoint_required: true,
    context: { source_truncated: true, ...context }, effective_preferences: [], active_conflicts: conflicts });
  const recoverable = blockedPreferenceDelivery(entry({ project_agent_id: 'synthetic-agent' }), 'inline_budget');
  assert.equal(recoverable.active_conflicts, undefined);
  assert.deepEqual(recoverable.active_conflicts_omitted, { count: 1,
    read: { tool: 'read_task_preferences', arguments: { taskContextToken: 'fuli-task-synthetic' } } });
  assert.deepEqual(blockedPreferenceDelivery(entry({}), 'inline_budget').active_conflicts_omitted, { count: 1 });
  // The reader's own blocked result: reading again cannot recover it.
  assert.deepEqual(blockedPreferenceRecovery(entry({ project_agent_id: 'synthetic-agent' }), 'source_window')
    .active_conflicts_omitted, { count: 1 });
  // A frame blocked again keeps its count.
  assert.deepEqual(blockedPreferenceDelivery(recoverable, 'source_window').active_conflicts_omitted,
    recoverable.active_conflicts_omitted);
});

test('a blocked entry whose task the reader cannot serve never points at the reader', () => {
  // The reader replays the task Agent and refuses a task without one.
  const structuredContent = blockedEntry({});
  const delivery = structuredContent.preference_delivery;
  assert.equal(structuredContent.same_task_recovery_available, false);
  assert.deepEqual(delivery.token_use, ['checkpoint_task_knowledge']);
  assert.doesNotMatch(delivery.guidance, /Recover now/);
  assert.match(delivery.guidance, /same_task_recovery_available=false\): do not call read_task_preferences/);
  assert.match(delivery.guidance, /checkpoint this token with a truthful incomplete workLog/);
});
