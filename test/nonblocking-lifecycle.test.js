import test from 'node:test';
import assert from 'node:assert/strict';
import { codexStopLifecycleOutput, runCodexLifecycleCommand } from '../src/agents/codex/lifecycle-hook.js';
import { claudeLifecycleOutput } from '../src/agents/claude-code/lifecycle-hook.js';
import { cursorLifecycleOutput } from '../src/agents/cursor/lifecycle-hook.js';
import { spawn } from 'node:child_process';

for (const [host, run] of [
  ['Codex', (input, invoke) => codexStopLifecycleOutput(input, invoke)],
  ['Claude', (input, invoke) => claudeLifecycleOutput('Stop', input, invoke)],
  ['Cursor', (input, invoke) => cursorLifecycleOutput('stop', input, invoke)]
]) test(`${host} checkpoint reminders never intercept completion or create another model turn`, async () => {
  const calls = [];
  const invoke = async name => {
    calls.push(name);
    return { status: 'checkpoint_required', decision: 'block', reason: 'Checkpoint pending', task_context_token: 'synthetic-token' };
  };
  for (const active of [false, true]) {
    const result = await run({ session_id: 'synthetic-session', status: 'completed', stop_hook_active: active, loop_count: Number(active) }, invoke);
    assert.notEqual(result.decision, 'block');
    assert.notEqual(result.continue, false);
    assert.equal(result.followup_message, undefined);
  }
  assert.ok(calls.every(name => name === 'verify_task_checkpoint'), 'A hook must not fabricate a work log or checkpoint');
});

test('Codex command deadline permits submission even if input never finishes', async () => {
  const child = spawn(process.execPath, ['src/agents/codex/lifecycle-hook.js', '--event', 'UserPromptSubmit', '--timeout-ms', '100']);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  clearTimeout(timeout);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  const output = JSON.parse(stdout);
  assert.notEqual(output.decision, 'block');
  assert.equal(output.hookSpecificOutput, undefined);
  assert.match(output.systemMessage, /unavailable/);
});

test('Codex deadline releases opened resources even when a Provider ignores cancellation', async () => {
  const closed = [], writes = [];
  const result = await runCodexLifecycleCommand(['--event', 'Stop', '--timeout-ms', '20'], {
    readInput: async () => ({ session_id: 'synthetic-session' }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: '/synthetic/runtime.json' }),
    openApplication: () => ({ close: async () => { closed.push('app'); } }),
    createLeases: () => ({ withGraphLease: async () => new Promise(() => {}), close: async () => { closed.push('lease'); } }),
    write: value => writes.push(value)
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(closed.sort(), ['app', 'lease']);
  assert.equal(writes.length, 1);
  assert.notEqual(JSON.parse(writes[0]).decision, 'block');
});
