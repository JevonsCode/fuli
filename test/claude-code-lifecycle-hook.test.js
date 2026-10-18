import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { claudeLifecycleOutput, runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-hook.js';
import { claudeLifecycleCommand } from '../src/agents/claude-code/lifecycle-hooks.js';

const input = { session_id: 'synthetic-claude-session', cwd: '/synthetic/project',
  prompt: 'Synthetic hook verification.', transcript_path: 'DO_NOT_READ', user_email: 'DO_NOT_COPY' };

test('Claude command entry restores context without any host MCP connection', async () => {
  const calls = [];
  const output = await claudeLifecycleOutput('UserPromptSubmit', input, async (name, args) => {
    calls.push([name, args]);
    return { taskContextToken: 'fuli-task-synthetic', effective_preferences: [{ instruction: 'synthetic preference' }] };
  });
  assert.deepEqual(calls, [['begin_task_context', { sessionId: input.session_id,
    projectPath: input.cwd, taskPrompt: input.prompt, sourceApplication: 'claude_code', sourceSessionId: input.session_id }]]);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /fuli-task-synthetic/);
  assert.match(output.hookSpecificOutput.additionalContext, /synthetic preference/);
  assert.doesNotMatch(JSON.stringify(calls), /DO_NOT/);
});

test('Claude Stop verifies the same session and provides an advisory without another model turn', async () => {
  const calls = [];
  const invoke = async (name, args) => {
    calls.push([name, args]);
    return { decision: 'block', task_context_token: 'fuli-task-synthetic', reason: 'FULI_CHECKPOINT_REQUIRED: finish' };
  };
  assert.deepEqual(await claudeLifecycleOutput('Stop', input, invoke), {
    systemMessage: 'FULI_CHECKPOINT_REQUIRED: finish'
  });
  const active = await claudeLifecycleOutput('Stop', { ...input, stop_hook_active: true }, invoke);
  assert.equal(active.decision, undefined);
  assert.ok(calls.every(([name]) => name === 'verify_task_checkpoint'));
  assert.deepEqual(await claudeLifecycleOutput('Stop', input, async () => ({ status: 'checkpointed' })), {});
});

test('Claude adapter rejects missing session and malformed entry before invoking tools', async () => {
  let calls = 0;
  const invoke = async () => { calls += 1; };
  await assert.rejects(claudeLifecycleOutput('UserPromptSubmit', {}, invoke), /session identifier/);
  await assert.rejects(claudeLifecycleOutput('UserPromptSubmit', { session_id: 'session' }, invoke), /cwd and prompt/);
  assert.equal(calls, 0);
});

test('Claude pending main-session background notifications preserve the original task before runtime work', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-claude-notification-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const prompt = '<task-notification>\n<task-id>synthetic-background</task-id>\n<status>completed</status>\n</task-notification>';
  const transcript = join(directory, 'session.jsonl');
  const native = { ...input, prompt, transcript_path: transcript };
  const queue = (operation, extra = {}) => ({ type: 'queue-operation', operation, sessionId: input.session_id, content: prompt, ...extra });
  const attachment = (commandMode, extra = {}) => ({ type: 'attachment', sessionId: input.session_id,
    attachment: { type: 'queued_command', prompt, commandMode }, ...extra });
  const write = records => writeFileSync(transcript, records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n'));
  const invocations = [];
  const invoke = async name => { invocations.push(name); return { taskContextToken: 'fuli-task-synthetic' }; };
  for (const records of [[queue('enqueue')], [queue('enqueue'), attachment('task-notification')],
    [queue('enqueue'), attachment('prompt'), queue('remove'), queue('enqueue')],
    [queue('enqueue'), queue('remove', { isSidechain: true })]]) {
    write(records);
    const output = await claudeLifecycleOutput('UserPromptSubmit', native, invoke);
    assert.match(output.hookSpecificOutput.additionalContext, /Keep the current task context/);
    assert.doesNotMatch(JSON.stringify(output), /fuli-task-synthetic|effective_preferences|begin_task_context/);
  }
  assert.deepEqual(invocations, []);
  const calls = [];
  const never = name => () => { calls.push(name); throw new Error('Unexpected notification runtime work: ' + name); };
  const output = await runClaudeLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => native,
    invoke: never('invoke'), resolveRuntimeOptions: never('resolve'), openApplication: never('Provider'),
    createLeases: never('lease'), onTranscriptGuard: never('transcript'), callTool: never('tool')
  });
  assert.match(output.hookSpecificOutput.additionalContext, /not a new user task/);
  // The installed hook path must bypass runtime setup as well as its injectable invoke path.
  const direct = await runClaudeLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => native, resolveRuntimeOptions: never('resolve'), openApplication: never('Provider'),
    createLeases: never('lease'), onTranscriptGuard: never('transcript'), callTool: never('tool')
  });
  assert.match(direct.hookSpecificOutput.additionalContext, /not a new user task/);
  assert.deepEqual(calls, []);
  const command = spawnSync(process.execPath, ['src/agents/claude-code/lifecycle-hook.js',
    '--event', 'UserPromptSubmit', '--runtime-config', join(directory, 'must-not-open.json')], {
    input: JSON.stringify(native), encoding: 'utf8', timeout: 5000
  });
  assert.equal(command.status, 0);
  assert.equal(command.stderr, '');
  assert.deepEqual(JSON.parse(command.stdout), direct);
  await claudeLifecycleOutput('Stop', native, async name => {
    assert.equal(name, 'verify_task_checkpoint'); return { decision: 'block', reason: 'FULI_CHECKPOINT_REQUIRED: original task' };
  }).then(stop => assert.equal(stop.systemMessage, 'FULI_CHECKPOINT_REQUIRED: original task'));

  const negatives = [
    ['no queue source', [{ type: 'user', sessionId: input.session_id, message: { content: prompt } }]],
    ['removed queue', [queue('enqueue'), attachment('task-notification'), queue('remove')]],
    ['removal without payload', [queue('enqueue'), queue('remove', { content: undefined })]],
    ['different session', [queue('enqueue', { sessionId: 'another-session' })]],
    ['different prompt', [queue('enqueue', { content: prompt + '\nUser followup' })]],
    ['sidechain source', [queue('enqueue', { isSidechain: true })]],
    ['explicit user', [queue('enqueue'), attachment('prompt')]],
    ['user takes precedence', [queue('enqueue'), attachment('prompt'), attachment('task-notification')]],
    ['duplicate enqueue cannot erase user evidence', [queue('enqueue'), attachment('prompt'), queue('enqueue')]],
    ['invalid JSON', ['{invalid', queue('enqueue')]],
    ['partial trailing record', [queue('enqueue'), '{"type":"queue-operation","operation":"remove"']],
    ['forged prefix only', [queue('enqueue', { content: '<task-notification><task-id>' })], '<task-notification><task-id>'],
    ['empty task identifier', [queue('enqueue', { content: '<task-notification><task-id> </task-id></task-notification>' })],
      '<task-notification><task-id> </task-id></task-notification>'],
    ['multiple envelopes', [queue('enqueue', { content: prompt + prompt })], prompt + prompt],
    ['pasted surrounding text', [queue('enqueue', { content: 'Please inspect ' + prompt })], 'Please inspect ' + prompt],
    ['user continuation', [queue('enqueue', { content: prompt + '\nNow do another task' })], prompt + '\nNow do another task']
  ];
  for (const [label, records, submitted = prompt] of negatives) {
    write(records); invocations.length = 0;
    await claudeLifecycleOutput('UserPromptSubmit', { ...native, prompt: submitted }, invoke);
    assert.deepEqual(invocations, ['begin_task_context'], label);
  }
  invocations.length = 0;
  await claudeLifecycleOutput('UserPromptSubmit', { ...native, transcript_path: join(directory, 'missing.jsonl') }, invoke);
  assert.deepEqual(invocations, ['begin_task_context'], 'unreadable transcript must preserve normal entry');

  const encoded = JSON.stringify(queue('enqueue'));
  // The bounded tail can begin at valid-looking JSON inside a cut, invalid line.
  writeFileSync(transcript, 'cut-prefix' + encoded + ' '.repeat(512 * 1024 - Buffer.byteLength(encoded) - 1) + '\n');
  invocations.length = 0;
  await claudeLifecycleOutput('UserPromptSubmit', native, invoke);
  assert.deepEqual(invocations, ['begin_task_context'], 'a truncated first line is not host evidence');
  // Cutting inside UTF-8 must not hide a complete enqueue on the next line.
  writeFileSync(transcript, '记'.repeat(200_000) + '\n' + encoded + '\n');
  invocations.length = 0;
  await claudeLifecycleOutput('UserPromptSubmit', native, invoke);
  assert.deepEqual(invocations, [], 'complete records after a discarded partial line remain usable');
});

test('Claude adapter releases runtime resources after failure and preserves request cancellation', async () => {
  const closed = [];
  const controller = new AbortController();
  await assert.rejects(runClaudeLifecycleHook(['--event', 'UserPromptSubmit'], {
    signal: controller.signal,
    readInput: async () => input,
    resolveRuntimeOptions: () => ({ runtimeConfigPath: '/synthetic/runtime.json' }),
    openApplication: () => ({ close: async () => { closed.push('app'); } }),
    createLeases: () => ({
      withGraphLease: async (_owner, operation, request) => {
        assert.equal(request.signal, controller.signal); return operation();
      },
      close: async () => { closed.push('lease'); throw new Error('private cleanup detail'); }
    }),
    callTool: async (_app, _name, _args, request) => {
      assert.equal(request.signal, controller.signal); throw new Error('synthetic outage');
    }
  }), /synthetic outage/);
  assert.deepEqual(closed.sort(), ['app', 'lease']);
});

test('installed command contract fails open on malformed input without leaking diagnostics', () => {
  const result = spawnSync(process.execPath, ['src/agents/claude-code/lifecycle-hook.js',
    '--event', 'UserPromptSubmit', '--runtime-config', '/synthetic/missing.json'], {
    input: '{private-invalid-input', encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.systemMessage, /not verified/);
  assert.doesNotMatch(result.stdout, /private-invalid-input|synthetic\/missing/);
});

test('Claude hook deadline returns an explicit degraded context even when stdin never closes', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['src/agents/claude-code/lifecycle-hook.js',
    '--event', 'UserPromptSubmit', '--timeout-ms', '100']);
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  assert.equal(code, 0);
  assert.match(JSON.parse(stdout).systemMessage, /not verified/);
});

test('Claude runtime failure preserves a known native session for fallback without private diagnostics', () => {
  const result = spawnSync(process.execPath, ['src/agents/claude-code/lifecycle-hook.js',
    '--event', 'UserPromptSubmit', '--runtime-config', '/synthetic/private-missing.json'], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /sessionId="synthetic-claude-session"/);
  assert.match(context, /get_collaboration_preferences/);
  assert.doesNotMatch(result.stdout, /DO_NOT|private-missing|Synthetic hook verification/);
});

test('Claude command quotes shell metacharacters and never interpolates user input', () => {
  // A POSIX fixture: pin the platform and the hook path so the Windows host's
  // path.join and quoting rules do not apply to it.
  const command = claudeLifecycleCommand({ platform: 'linux', nodePath: "/synthetic/node's bin/node",
    mcpServerPath: '/synthetic/$(touch do-not-run)/mcp-server.js',
    claudeLifecycleHookPath: '/synthetic/$(touch do-not-run)/agents/claude-code/lifecycle-hook.js',
    runtimeConfigPath: '/synthetic/runtime.json' }, 'Stop', 30);
  assert.match(command, /'\\''/);
  assert.match(command, /'\/synthetic\/\$\(touch do-not-run\)/);
  assert.doesNotMatch(command, /\$\{prompt\}|\$\{session_id\}/);
});

test('Claude blocked handoff delivers a fresh task without importing history or changing the pending guard', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { withTranscriptGuard, transcriptDigest } = await import('../src/conversations/transcript-guard.js');
  const directory = await mkdtemp(join(tmpdir(), 'jvs-a-claude-fallback-'));
  const runtimeConfigPath = join(directory, 'runtime.json');
  const native = { ...input, transcript_path: join(directory, 'missing.jsonl') };
  const guardState = { version: 1, phase: 'claim', owner: transcriptDigest('old-token'),
    nextOwner: transcriptDigest('interrupted-token'), prompt: transcriptDigest(native.prompt), scanCursor: 0, boundary: 0 };
  const calls = [];
  let savedState;
  try {
    await withTranscriptGuard(runtimeConfigPath, native, 'claude_code', true, async guard => {
      await guard.write(guardState); savedState = structuredClone(guard.value);
    });
    const output = await runClaudeLifecycleHook(['--event', 'UserPromptSubmit'], {
      readInput: async () => native,
      resolveRuntimeOptions: () => ({ runtimeConfigPath }),
      createLeases: () => ({ withGraphLease: async (_owner, operation) => operation() }),
      openApplication: () => ({ config: { personal: { spaceId: 'synthetic-space' } },
        getCapturePolicy: () => ({ enabled: true }), personal: {
          currentTaskContext: async () => ({ token: 'externally-replaced-token', project_agent_id: 'engineer', personal_project_id: 'project' }),
          conversation: async (_operation, query) => query.mode === 'policy' ? { enabled: true } : { initialized: true, cursor: 0 }
        } }),
      callTool: async (_app, name) => { calls.push(name); return { taskContextToken: 'fresh-entry-token' }; }
    });
    assert.match(output.systemMessage, /not imported/);
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const context = output.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(context, /First call get_collaboration_preferences/);
    assert.match(context, /fresh-entry-token/);
    assert.doesNotMatch(context, /old-token|interrupted-token|externally-replaced-token|missing.jsonl/);
    assert.deepEqual(calls, ['begin_task_context']);
    await withTranscriptGuard(runtimeConfigPath, native, 'claude_code', true, guard => assert.deepEqual(guard.value, savedState));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function claudeGuardFixture(t) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'jvs-a-claude-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeConfigPath = join(directory, 'runtime.json');
  const native = { ...input, transcript_path: join(directory, 'missing.jsonl') };
  const calls = [], lookups = [];
  const run = () => runClaudeLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => native,
    resolveRuntimeOptions: () => ({ runtimeConfigPath }),
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation() }),
    openApplication: () => ({ config: { personal: { spaceId: 'synthetic-space' } },
      getCapturePolicy: () => ({ enabled: true }), personal: {
        currentTaskContext: async () => { lookups.push('current'); return null; },
        conversation: async (_operation, query) => query.mode === 'policy' ? { enabled: true } : { initialized: true, cursor: 0 }
      } }),
    callTool: async (_app, name) => { calls.push(name); return { taskContextToken: 'synthetic-task' }; }
  });
  return { runtimeConfigPath, native, run, calls, lookups };
}

test('Claude task entry is not blocked by an unrelated listener on the former guard port', async t => {
  const { createServer } = await import('node:net');
  const { transcriptDigest } = await import('../src/conversations/transcript-guard.js');
  const f = await claudeGuardFixture(t);
  const key = transcriptDigest(`${f.runtimeConfigPath}\0claude_code\0${f.native.session_id}`);
  const lockKey = transcriptDigest(`${join(dirname(f.runtimeConfigPath), 'transcript-guards')}\0${key}`);
  const blocker = createServer();
  t.after(() => new Promise(resolve => blocker.close(() => resolve())));
  await new Promise(resolve => {
    // An existing owner of the port is the same foreign-holder case.
    blocker.once('error', resolve);
    blocker.listen({ host: '127.0.0.1', port: 49152 + (parseInt(lockKey.slice(0, 8), 16) % 16384), exclusive: true }, resolve);
  });
  const output = await f.run();
  assert.doesNotMatch(output.systemMessage ?? '', /Another Fuli hook|lock/i);
  assert.ok(f.lookups.length > 0, 'The hook must reach transcript synchronization');
  assert.deepEqual(f.calls, ['begin_task_context']);
});

test('Claude same-session hook skips the held transcript guard while delivering a task', async t => {
  const { withTranscriptGuard } = await import('../src/conversations/transcript-guard.js');
  const f = await claudeGuardFixture(t);
  await withTranscriptGuard(f.runtimeConfigPath, f.native, 'claude_code', true, async () => {
    const output = await f.run();
    assert.match(output.systemMessage, /Another Fuli hook for this host session is still running/);
    assert.notEqual(output.decision, 'block');
  });
  assert.deepEqual(f.calls, ['begin_task_context']);
  assert.deepEqual(f.lookups, []);
});
