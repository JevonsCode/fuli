import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claudeCodeWake } from '../packages/roundtable/src/agents/claude-code/wake.js';
import { parseFinalAnswer, wakeArguments } from '../packages/roundtable/src/roundtable/wake.js';

test('Claude Code resumes by forking, so an open window is never written', () => {
  assert.deepEqual(wakeArguments('claude_code', { sessionId: 'cc-session-1' }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--resume', 'cc-session-1', '--fork-session']);
  assert.deepEqual(wakeArguments('claude_code', { cwd: '/work/app' }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk']);
});

test('a read-only wake keeps the non-interactive mode with the reading tools only, and denies file edits and both shells', () => {
  assert.deepEqual(wakeArguments('claude_code', { mode: 'read_only', plannedSessionId: 'planned-1' }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
      '--tools', 'Read,Grep,Glob', '--disallowedTools', 'Edit,Write,NotebookEdit,MultiEdit,Bash,PowerShell', '--session-id', 'planned-1']);
  assert.ok(!wakeArguments('claude_code', { mode: 'read_only' }).includes('plan'));
});

test('a wake mode outside answer and read_only is refused: work for another computer is a constrained run, not a wake', () => {
  assert.deepEqual(wakeArguments('claude_code', { mode: 'answer' }), wakeArguments('claude_code', {}));
  for (const mode of ['worktree_edit', 'write_anywhere']) assert.throws(() => wakeArguments('claude_code', { mode }), /Invalid wake mode/);
});

test('an ask from another computer loads exactly the given MCP servers: FULI\'s own, or none at all', () => {
  const entry = { command: 'C:/synthetic/node.exe', args: ['C:/synthetic/mcp-server.js', '--source-application', 'claude_code'],
    settings: {} };
  const strict = (servers) => ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: servers })];
  const tail = (args) => args.slice(args.indexOf('--strict-mcp-config'), args.indexOf('--strict-mcp-config') + 3);
  assert.deepEqual(tail(wakeArguments('claude_code', { mode: 'read_only', mcpServers: { fuli: entry } })),
    strict({ fuli: { type: 'stdio', command: entry.command, args: entry.args } }));
  assert.deepEqual(tail(wakeArguments('claude_code', { mode: 'read_only', mcpServers: {} })), strict({}));
  assert.deepEqual(wakeArguments('claude_code', { mode: 'answer', mcpServers: { fuli: entry } }), wakeArguments('claude_code', {}));
  assert.ok(!wakeArguments('claude_code', { mode: 'read_only' }).includes('--strict-mcp-config'));
});

test('Claude Code answers come from the final result event', () => {
  assert.deepEqual(parseFinalAnswer('claude_code', { code: 0, stdout: [
    JSON.stringify({ type: 'system', session_id: 'fork-1' }), JSON.stringify({ type: 'result', result: ' 好的 ' })].join('\n') }),
  { body: '好的', sessionId: 'fork-1' });
  // rec#129: the init event names the model the session runs; FULI records it as reported.
  assert.deepEqual(parseFinalAnswer('claude_code', { code: 0, stdout: [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fork-2', model: 'synthetic-model-a' }),
    JSON.stringify({ type: 'result', result: 'ok' })].join('\n') }),
  { body: 'ok', sessionId: 'fork-2', model: 'synthetic-model-a' });
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

test('a delegated Claude Code wake binds its named session before the client starts', async () => {
  const { wakeAgent } = await import('../packages/roundtable/src/roundtable/wake.js');
  const order = [];
  let launchArgs = null;
  const answer = await wakeAgent({ client: 'claude_code', sessionId: 'cc-session-1', cwd: '/work/app', prompt: 'Question',
    delegationToken: 'x'.repeat(43), env: { FULI_CLAUDE_BIN: '/opt/claude' },
    onSession: async session => { order.push(['bound', session]); },
    run: async (_command, args, { onEvent }) => {
      launchArgs = args;
      const planned = args[args.indexOf('--session-id') + 1];
      order.push(['started', planned]);
      onEvent({ type: 'system', subtype: 'init', session_id: planned });
      return { code: 0, stdout: [JSON.stringify({ type: 'system', subtype: 'init', session_id: planned }),
        JSON.stringify({ type: 'result', result: 'Answer' })].join('\n') };
    } });
  const planned = launchArgs[launchArgs.indexOf('--session-id') + 1];
  assert.match(planned, /^[0-9a-f-]{36}$/);
  assert.deepEqual(launchArgs.slice(-5), ['--resume', 'cc-session-1', '--fork-session', '--session-id', planned]);
  assert.deepEqual(order, [['bound', planned], ['started', planned]], 'bound once, before the start');
  assert.deepEqual(answer, { body: 'Answer', sessionId: planned });

  await assert.rejects(wakeAgent({ client: 'claude_code', cwd: '/work/app', prompt: 'Question', delegationToken: 'x'.repeat(43),
    env: { FULI_CLAUDE_BIN: '/opt/claude' }, onSession: async () => {},
    run: async (_command, _args, { onEvent }) => { onEvent({ type: 'system', subtype: 'init', session_id: 'another-session-1' }); return { code: 0, stdout: '' }; } }),
  { code: 'session_mismatch' });
});
