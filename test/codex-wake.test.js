import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { codexWake } from '../src/agents/codex/wake.js';
import { parseFinalAnswer, wakeArguments } from '../src/agent-roundtable/wake.js';

test('Codex runs read-only, resuming a session or starting in the project directory', () => {
  assert.deepEqual(wakeArguments('codex', { sessionId: 'cx-session-1' }),
    ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', 'cx-session-1', '-']);
  assert.deepEqual(wakeArguments('codex', { cwd: '/work/app' }),
    ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', '/work/app', '-']);
});

test('Codex answers are the last agent message of a completed turn', () => {
  assert.deepEqual(parseFinalAnswer('codex', { code: 0, stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: 'cx-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    JSON.stringify({ type: 'turn.completed' })].join('\n') }), { body: 'done', sessionId: 'cx-1' });
  assert.throws(() => parseFinalAnswer('codex', { code: 0, stdout: JSON.stringify({ type: 'turn.failed' }) }), /did not return an answer/);
  assert.throws(() => parseFinalAnswer('codex', { code: 0, stdout:
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }) }), /did not return an answer/);
});

test('Codex sessions resume from the directory in their session metadata', () => {
  const home = mkdtempSync(join(tmpdir(), 'fuli-codex-wake-'));
  mkdirSync(join(home, '.codex', 'sessions', '2026', '10', '10'), { recursive: true });
  writeFileSync(join(home, '.codex', 'sessions', '2026', '10', '10', 'rollout-2026-10-10T00-00-00-cx-session-1.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/app' } })}\n`);
  assert.equal(codexWake.sessionDirectory('cx-session-1', { home, env: {} }), '/work/app');
  assert.equal(codexWake.sessionDirectory('missing-session', { home, env: {} }), null);
});

test('On Windows the newest bundled Codex CLI is used when PATH has none', () => {
  const local = mkdtempSync(join(tmpdir(), 'fuli-codex-bin-'));
  const bin = join(local, 'OpenAI', 'Codex', 'bin');
  mkdirSync(join(bin, 'old'), { recursive: true });
  mkdirSync(join(bin, 'new'), { recursive: true });
  writeFileSync(join(bin, 'old', 'codex.exe'), '');
  writeFileSync(join(bin, 'new', 'codex.exe'), '');
  utimesSync(join(bin, 'old', 'codex.exe'), new Date('2026-01-01'), new Date('2026-01-01'));
  utimesSync(join(bin, 'new', 'codex.exe'), new Date('2026-10-01'), new Date('2026-10-01'));
  const command = codexWake.resolveCommand({ env: { LOCALAPPDATA: local }, which: () => null, platform: 'win32' });
  assert.equal(command, join(bin, 'new', 'codex.exe'));
});
