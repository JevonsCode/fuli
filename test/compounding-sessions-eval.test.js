import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SESSIONS } from '../acceptance/compounding-sessions/sessions.js';
import { buildRepo } from '../acceptance/compounding-sessions/workspace.js';
import { sessionReport } from '../acceptance/compounding-sessions/metrics.js';

const CHECKS = new URL('../acceptance/compounding-sessions/checks.js', import.meta.url);

function check(sessionId, dir) {
  const result = spawnSync(process.execPath, [CHECKS.pathname.replace(/^\/([A-Za-z]:)/, '$1'), sessionId, dir],
    { encoding: 'utf8', timeout: 300_000 });
  return JSON.parse(result.stdout);
}

// The eval only measures something if each task is unsolved where its session starts and the reference solution
// passes the same hidden check; otherwise a session could "succeed" without the Agent doing the work.
test('compounding eval: every session starts unsolved and its reference solution passes', { timeout: 600_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-compound-'));
  try {
    for (const [index, session] of SESSIONS.entries()) {
      const start = check(session.id, buildRepo(index, join(root, `${session.id}-start`), { commit: false }));
      assert.equal(start.pass, false, `${session.id} must start unsolved`);
      const solved = check(session.id, buildRepo(index, join(root, `${session.id}-solved`), { solved: true, commit: false }));
      assert.equal(solved.pass, true, `${session.id} reference solution: ${JSON.stringify(solved)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compounding eval: a session report sums usage, splits tool calls and keeps the FULI hook size', () => {
  const events = [
    { type: 'system', subtype: 'init', session_id: 'x', model: 'claude-haiku-5-5', mcp_servers: [{ name: 'fuli' }], tools: ['Read', 'mcp__fuli__checkpoint_task_knowledge'] },
    { type: 'system', subtype: 'hook_response', hook_event: 'UserPromptSubmit',
      stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'ctx-ctx' } }) },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'fail', is_error: true }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'retry' } },
      { type: 'tool_use', id: 't4', name: 'mcp__fuli__checkpoint_task_knowledge', input: { disposition: 'retain_nothing' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't4', content: '{"status":"checkpointed"}' }] } },
    { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'done' }] } },
    { type: 'result', session_id: 'x', num_turns: 3, total_cost_usd: 0.01, result: 'done',
      usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 },
      modelUsage: { 'claude-haiku-5-5': { inputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, outputTokens: 5, costUSD: 0.01 } } }
  ];
  const report = sessionReport(events);
  assert.equal(report.usage.allInput, 130);
  assert.equal(report.usage.output, 5);
  assert.equal(report.costUsd, 0.01);
  assert.equal(report.modelRequests, 3);
  assert.deepEqual(report.tools, { total: 4, explore: 2, edit: 0, run: 1, fuli: 1, other: 0, failedRuns: 1 });
  assert.deepEqual(report.fuli.calls, ['checkpoint_task_knowledge']);
  assert.equal(report.hooks.promptContextBytes, 7);
});
