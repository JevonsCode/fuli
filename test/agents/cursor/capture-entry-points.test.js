// rec#5 C4 through Cursor's own hooks. Cursor's prompt hook has no message for an
// accepted prompt, so its Agent learns that a project is not recorded from the
// receipt its sessionStart guidance makes it read and copy.
// Synthetic only: temporary directories and a recording Provider double. No FULI
// data directory, port-2727 service, Cursor configuration or client is used.
import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool } from '../../../src/agent-tools.js';
import { runCursorLifecycleHook } from '../../../src/agents/cursor/lifecycle-hook.js';
import { cursorEntry, finishTask, fixture, PRIVATE, receiptOf } from '../../fixtures/capture-project-fixture.js';

const SESSION = 'synthetic-cursor-session';
const PROJECT_OFF = '此项目未开启记忆；你明确提交的修改仍会保存';

function cursorHook(f, event, input) {
  return runCursorLifecycleHook(['--event', event], { readInput: async () => input, write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => {} }) });
}

test('Cursor: a switched-off project reaches its Agent through the receipt, and nothing is recorded', async (t) => {
  const f = await fixture(t);
  f.store.update({ recordProjects: { 'job-hunt': false } });
  const start = await cursorHook(f, 'sessionStart', { conversation_id: SESSION, workspace_roots: [f.dirs['job-hunt']] });
  assert.match(start.additional_context, /agent_receipt\.markdown unchanged exactly once, including greetings and capture-disabled tasks/);
  const entry = await cursorEntry(f, f.dirs['job-hunt'], { session: SESSION });
  assert.deepEqual(entry.output, { continue: true }, 'the prompt goes on, with nothing shown that names the turn');
  assert.ok(receiptOf(entry.context).endsWith(` · ${PROJECT_OFF}`));
  const checkpoint = await finishTask(f, entry.context, 'cursor');
  assert.equal(JSON.stringify(checkpoint.agent_receipt).includes(PRIVATE), false);
  assert.deepEqual(await cursorHook(f, 'stop', { conversation_id: SESSION }), {});
  assert.deepEqual(f.captureWrites(), []);
});

test('Cursor: "这次别记" pauses at once with no confirmation and the next receipt says so', async (t) => {
  const f = await fixture(t);
  const first = await cursorEntry(f, f.dirs.novel, { session: SESSION });
  const paused = await callAgentTool(f.app, 'update_capture_policy', { sessionPaused: true,
    taskContextToken: first.context.taskContextToken, sourceApplication: 'cursor' });
  assert.equal(paused.status, 'session_paused');
  assert.equal(paused.confirmUrl, undefined, 'a session pause needs no console confirmation');
  const next = await cursorEntry(f, f.dirs.novel, { session: SESSION });
  assert.match(receiptOf(next.context), /本会话已暂停记录/);
  assert.equal(f.store.read().projectMode, 'all', 'nothing long-term changed');
});
