import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { CONSTRAINED_RUN_CLIENTS, runConstrained } from '../packages/roundtable/src/roundtable/constrained-run.js';

// A fake process runner and synthetic settings text: no client starts, no real settings file is read.
const answer = (tools = ['Read', 'Grep', 'Glob'], mcpServers = []) => [JSON.stringify({ type: 'system', subtype: 'init',
  session_id: 'synthetic-run', tools, mcp_servers: mcpServers }), JSON.stringify({ type: 'result', result: 'Planned.' })].join('\n');
const ANSWER = answer();

// Hands each output line to onEvent as runProcess does; a throwing onEvent stops the run.
function fixture({ result = { code: 0, stdout: ANSWER, stderr: '' }, settings = null } = {}) {
  const calls = [];
  const read = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    for (const line of result.stdout.split('\n').filter(Boolean)) await options.onEvent(JSON.parse(line));
    return result;
  };
  const readText = (path) => { read.push(path); if (settings === null) throw new Error('missing'); return settings; };
  const env = { FULI_CLAUDE_BIN: 'synthetic-claude', FULI_ROUNDTABLE_DELEGATION: 'must-not-pass', PATH: '/synthetic/bin' };
  return { calls, read, go: (input) => runConstrained({ client: 'claude_code', cwd: '/synthetic/project', prompt: 'p',
    timeoutMs: 1000, env, home: '/synthetic/home', run, readText, ...input }) };
}

test('planning is a restricted, read-only Claude Code run with an empty strict MCP configuration', async () => {
  const f = fixture();
  assert.deepEqual(await f.go({ step: 'plan' }), { body: 'Planned.' });
  assert.deepEqual(f.calls[0].args, ['-p', '--output-format', 'stream-json', '--verbose', '--restricted', '--permission-mode', 'dontAsk',
    '--tools', 'Read,Grep,Glob', '--disallowedTools', 'Bash,PowerShell,WebFetch,WebSearch,NotebookEdit,Edit,Write,MultiEdit',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']);
  assert.equal(f.calls[0].options.cwd, '/synthetic/project');
  assert.equal(f.calls[0].options.env.FULI_ROUNDTABLE_DELEGATION, undefined, 'no grant reaches the run');
});

test('the edit is restricted with the file tools only, accepting edits, no shell, no web and no MCP server', async () => {
  const f = fixture();
  await f.go({ step: 'edit', cwd: '/synthetic/worktree' });
  assert.deepEqual(f.calls[0].args, ['-p', '--output-format', 'stream-json', '--verbose', '--restricted', '--permission-mode', 'acceptEdits',
    '--tools', 'Read,Grep,Glob,Edit,Write,MultiEdit', '--disallowedTools', 'Bash,PowerShell,WebFetch,WebSearch,NotebookEdit',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']);
  assert.equal(f.calls[0].options.cwd, '/synthetic/worktree');
});

test('the person\'s model settings from their user settings env block reach the child environment only', async () => {
  const f = fixture({ settings: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://synthetic.example.invalid', ANTHROPIC_MODEL: 'synthetic-model',
    NUMBER: 3, 'bad key': 'x' }, hooks: { Stop: [] } }) });
  await f.go({ step: 'plan', env: { FULI_CLAUDE_BIN: 'synthetic-claude', CLAUDE_CONFIG_DIR: '/synthetic/claude-config' } });
  assert.deepEqual(f.read, [join('/synthetic/claude-config', 'settings.json')], 'CLAUDE_CONFIG_DIR is respected');
  const { env } = f.calls[0].options;
  assert.deepEqual([env.ANTHROPIC_BASE_URL, env.ANTHROPIC_MODEL, env.NUMBER, env['bad key']],
    ['https://synthetic.example.invalid', 'synthetic-model', undefined, undefined]);
  assert.ok(!f.calls[0].args.join(' ').includes('synthetic.example.invalid'), 'never on the command line');
  const home = fixture({ settings: 'not json' });
  await home.go({ step: 'plan' });
  assert.deepEqual(home.read, [join('/synthetic/home', '.claude', 'settings.json')]);
});

test('a CLI that does not know restricted mode fails with its own detail, never runs unrestricted', async () => {
  const f = fixture({ result: { code: 1, stdout: '', stderr: "error: unknown option '--restricted'" } });
  await assert.rejects(f.go({ step: 'edit' }), { code: 'wake_failed', detail: 'restricted_mode_unsupported' });
  assert.equal(f.calls.length, 1);
});

test('the client\'s start event must prove the restriction: an extra tool, an MCP server or no start event stops the run', async () => {
  const bash = fixture({ result: { code: 0, stdout: answer(['Read', 'Grep', 'Glob', 'Bash']), stderr: '' } });
  await assert.rejects(bash.go({ step: 'plan' }), { code: 'wake_failed', detail: 'restricted_mode_unsupported' });
  const edit = fixture({ result: { code: 0, stdout: answer(['Read', 'Edit', 'Write']), stderr: '' } });
  await assert.rejects(edit.go({ step: 'plan' }), { detail: 'restricted_mode_unsupported' }, 'edit tools in a planning pass');
  assert.deepEqual(await edit.go({ step: 'edit' }), { body: 'Planned.' });
  const mcp = fixture({ result: { code: 0, stdout: answer(['Read'], [{ name: 'someone-elses', status: 'connected' }]), stderr: '' } });
  await assert.rejects(mcp.go({ step: 'plan' }), { detail: 'restricted_mode_unsupported' });
  const silent = fixture({ result: { code: 0, stdout: JSON.stringify({ type: 'result', result: 'Planned.' }), stderr: '' } });
  await assert.rejects(silent.go({ step: 'plan' }), { detail: 'restricted_mode_unsupported' });
});

test('only Claude Code runs constrained for now; Codex is refused', async () => {
  assert.deepEqual(CONSTRAINED_RUN_CLIENTS, ['claude_code']);
  const f = fixture();
  await assert.rejects(f.go({ client: 'codex', step: 'plan' }), { code: 'client_unavailable' });
  assert.deepEqual(f.calls, []);
});
