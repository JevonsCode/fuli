import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claudeCodeWake } from '../src/agents/claude-code/wake.js';
import { parseFinalAnswer, wakeArguments } from '../src/agent-roundtable/wake.js';

test('Claude Code resumes by forking, so an open window is never written', () => {
  assert.deepEqual(wakeArguments('claude_code', { sessionId: 'cc-session-1' }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--resume', 'cc-session-1', '--fork-session']);
  assert.deepEqual(wakeArguments('claude_code', { cwd: '/work/app' }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk']);
});

test('Claude Code answers come from the final result event', () => {
  assert.deepEqual(parseFinalAnswer('claude_code', { code: 0, stdout: [
    JSON.stringify({ type: 'system', session_id: 'fork-1' }), JSON.stringify({ type: 'result', result: ' 好的 ' })].join('\n') }),
  { body: '好的', sessionId: 'fork-1' });
  assert.throws(() => parseFinalAnswer('claude_code', { code: 0, stdout: JSON.stringify({ type: 'result', result: 'x', is_error: true }) }),
    /did not return an answer/);
});

test('Claude Code sessions resume from the directory they recorded', () => {
  const home = mkdtempSync(join(tmpdir(), 'fuli-claude-wake-'));
  mkdirSync(join(home, '.claude', 'projects', 'T--work-app'), { recursive: true });
  writeFileSync(join(home, '.claude', 'projects', 'T--work-app', 'cc-session-1.jsonl'),
    `${JSON.stringify({ type: 'queue-operation' })}\n${JSON.stringify({ type: 'user', cwd: 'T:\\work\\app' })}\n`);
  assert.equal(claudeCodeWake.sessionDirectory('cc-session-1', { home, env: {} }), 'T:\\work\\app');
  assert.equal(claudeCodeWake.sessionDirectory('missing-session', { home, env: {} }), null);
});

test('Claude Code honours an explicit binary before searching PATH', () => {
  const which = () => '/usr/bin/claude';
  assert.equal(claudeCodeWake.resolveCommand({ env: { FULI_CLAUDE_BIN: '/opt/claude' }, which, platform: 'linux' }), '/opt/claude');
  assert.equal(claudeCodeWake.resolveCommand({ env: {}, which, platform: 'linux' }), '/usr/bin/claude');
});
