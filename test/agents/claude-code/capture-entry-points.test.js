// rec#5 C4 through Claude Code's own hooks: a project the person switched off is
// said so at entry and its transcript is never imported; "这次别记" applies at once.
// Synthetic only: temporary directories and a recording Provider double. No FULI
// data directory, port-2727 service, Claude Code configuration or client is used.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool } from '../../../src/agent-tools.js';
import { runClaudeLifecycleHook } from '../../../src/agents/claude-code/lifecycle-hook.js';
import { claudeEntry, fixture, PRIVATE, receiptOf } from '../../fixtures/capture-project-fixture.js';

const SESSION = 'synthetic-claude-session';
const PROJECT_OFF = '此项目未开启记忆；你明确提交的修改仍会保存';

// A Claude Code Stop through its real lifecycle hook, with its JSONL transcript.
function claudeStop(f, input) {
  return runClaudeLifecycleHook(['--event', 'Stop'], { readInput: async () => input,
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => {} }),
    captureTimeoutMs: 30_000 });
}

test('Claude Code: a switched-off project is said so at entry and Stop imports none of the turn', async (t) => {
  const f = await fixture(t);
  f.store.update({ recordProjects: { 'job-hunt': false } });
  const entry = await claudeEntry(f, f.dirs['job-hunt'], { session: SESSION });
  assert.ok(entry.output.systemMessage.includes(`Fuli: ${PROJECT_OFF}`));
  assert.ok(receiptOf(entry.context).endsWith(` · ${PROJECT_OFF}`));

  const transcript = join(f.root, 'claude.jsonl');
  await writeFile(transcript, `${JSON.stringify({ type: 'user', sessionId: SESSION, message: { content: `Plan ${PRIVATE}.` } })}\n`
    + `${JSON.stringify({ type: 'assistant', sessionId: SESSION, message: { content: [{ type: 'text', text: PRIVATE }] } })}\n`);
  await claudeStop(f, { session_id: SESSION, cwd: f.dirs['job-hunt'], transcript_path: transcript, hook_event_name: 'Stop' });
  assert.equal(f.captureWrites().some(write => write.content?.includes(PRIVATE)), false);
  assert.equal(f.knowledge.length, 0);
});

test('Claude Code: "这次别记" pauses at once with no confirmation and the next entry says so', async (t) => {
  const f = await fixture(t);
  const first = await claudeEntry(f, f.dirs.novel, { session: SESSION });
  const paused = await callAgentTool(f.app, 'update_capture_policy', { sessionPaused: true,
    taskContextToken: first.context.taskContextToken, sourceApplication: 'claude_code' });
  assert.equal(paused.status, 'session_paused');
  assert.equal(paused.previewToken, undefined, 'no preview for a session pause');
  const next = await claudeEntry(f, f.dirs.novel, { session: SESSION });
  assert.match(next.output.systemMessage, /Fuli: 本会话已暂停记录/);
  assert.equal(f.store.read().projectMode, 'all', 'nothing long-term changed');
});
