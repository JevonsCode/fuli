import test from 'node:test';
import assert from 'node:assert/strict';
import { codexHookTimeoutMs, codexStopLifecycleOutput, runCodexLifecycleCommand } from '../src/agents/codex/lifecycle-hook.js';
import { claudeLifecycleOutput } from '../src/agents/claude-code/lifecycle-hook.js';
import { cursorLifecycleOutput } from '../src/agents/cursor/lifecycle-hook.js';
import { spawn, spawnSync } from 'node:child_process';
import { CHILD_HANG_GUARD_MS } from '../test-support/child-process-guard.js';

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
  const timeout = setTimeout(() => child.kill('SIGKILL'), CHILD_HANG_GUARD_MS);
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

test('Codex command failure preserves a known native session for checkpointable fallback', () => {
  const result = spawnSync(process.execPath, ['src/agents/codex/lifecycle-hook.js',
    '--event', 'UserPromptSubmit', '--runtime-config', '/synthetic/private-missing.json'], {
    input: JSON.stringify({ session_id: 'synthetic-native-session', cwd: '/synthetic/private-project',
      prompt: 'PRIVATE_PROMPT', transcript_path: 'PRIVATE_TRANSCRIPT' }),
    encoding: 'utf8', timeout: CHILD_HANG_GUARD_MS
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /get_collaboration_preferences/);
  assert.match(context, /sessionId="synthetic-native-session"/);
  assert.match(context, /fresh taskContextToken/);
  assert.match(context, /truthful workLog/);
  assert.match(context, /checkpoint_required.*checkpoint_guidance/);
  assert.match(context, /do not reuse an old token/);
  assert.doesNotMatch(result.stdout, /PRIVATE_|private-project|private-missing/);
  assert.notEqual(output.decision, 'block');
});

test('Codex command deadline retains the parsed native session and emits fallback once', async () => {
  const writes = [];
  const result = await runCodexLifecycleCommand(['--event', 'UserPromptSubmit', '--timeout-ms', '20'], {
    readInput: async () => ({ session_id: 'synthetic-timeout-session', cwd: '/private-project', prompt: 'PRIVATE_PROMPT' }),
    invoke: async () => new Promise(() => {}),
    write: value => writes.push(value)
  });
  assert.equal(result.timedOut, true);
  assert.equal(writes.length, 1);
  const output = JSON.parse(writes[0]);
  assert.equal(output.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /sessionId="synthetic-timeout-session"/);
  assert.match(output.systemMessage, /no answer within 20 ms/);
  assert.match(output.hookSpecificOutput.additionalContext, /checkpoint_task_knowledge/);
  assert.doesNotMatch(writes[0], /PRIVATE_PROMPT|private-project/);
  assert.notEqual(output.decision, 'block');
});

test('Codex command never guesses a fallback session or supplies entry context at Stop', async () => {
  for (const [event, session_id] of [
    ['UserPromptSubmit', undefined], ['UserPromptSubmit', ' '],
    ['UserPromptSubmit', 'x'.repeat(257)], ['UserPromptSubmit', 42], ['Stop', 'synthetic-native-session']
  ]) {
    const writes = [];
    await runCodexLifecycleCommand(['--event', event], {
      readInput: async () => ({ session_id, cwd: '/private-project', prompt: 'PRIVATE_PROMPT' }),
      invoke: async () => { throw new Error('PRIVATE_FAILURE'); },
      write: value => writes.push(value)
    });
    assert.equal(writes.length, 1);
    const output = JSON.parse(writes[0]);
    assert.equal(output.hookSpecificOutput, undefined);
    assert.doesNotMatch(writes[0], /PRIVATE_|private-project|sessionId=/);
    assert.match(output.systemMessage, /the hook failed/);
    assert.notEqual(output.decision, 'block');
  }
});

for (const [host, run, source] of [
  ['Codex', (input, invoke) => codexStopLifecycleOutput(input, invoke), 'codex'],
  ['Claude', (input, invoke) => claudeLifecycleOutput('Stop', input, invoke), 'claude_code']
]) test(`${host} closes a hook-delivered task with nothing recorded, honestly and without another model turn`, async () => {
  const calls = [];
  const invoke = async (name, input) => {
    calls.push({ name, input });
    return name === 'verify_task_checkpoint'
      ? { status: 'checkpoint_required', decision: 'block', reason: 'Checkpoint pending', task_context_token: 'synthetic-token', entry_via: 'hook' }
      : { status: 'checkpointed' };
  };
  const result = await run({ session_id: 'synthetic-session' }, invoke);
  assert.deepEqual(result, {});
  const close = calls.find(call => call.name === 'checkpoint_task_knowledge');
  assert.equal(close.input.taskContextToken, 'synthetic-token');
  assert.equal(close.input.disposition, 'retain_nothing');
  assert.equal(close.input.workLog.status, 'reported');
  assert.match(close.input.workLog.summary, /Auto-closed by the Stop hook/);
  assert.equal(close.input.sourceApplication, source);
  assert.equal('capture' in close.input, false);
});

test('Codex task entry waits up to 15 s for a cold start; other events keep 5 s; both stay under the host timeout', () => {
  assert.equal(codexHookTimeoutMs(['--event', 'UserPromptSubmit']), 15_000);
  assert.equal(codexHookTimeoutMs(['--event', 'UserPromptSubmit', '--timeout-ms', '60000']), 15_000);
  assert.equal(codexHookTimeoutMs(['--event', 'UserPromptSubmit', '--timeout-ms', '20']), 20);
  for (const event of ['Stop', 'SessionStart', 'PreCompact']) {
    assert.equal(codexHookTimeoutMs(['--event', event]), 5_000);
    assert.equal(codexHookTimeoutMs(['--event', event, '--timeout-ms', '9000']), 5_000);
  }
  assert.equal(codexHookTimeoutMs(['--event', 'Stop', '--timeout-ms', 'soon']), 5_000);
});
