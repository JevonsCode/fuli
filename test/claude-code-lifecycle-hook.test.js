import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { claudeLifecycleOutput, runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-hook.js';
import { claudeLifecycleCommand } from '../src/agents/claude-code/lifecycle-hooks.js';

// A private runtime directory, so no hook reaches a shared absolute path.
const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), 'fuli-claude-hook-'));
const RUNTIME_CONFIG = join(RUNTIME_ROOT, 'runtime.json');
after(() => rmSync(RUNTIME_ROOT, { recursive: true, force: true }));

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

// Synthetic records in the shape Claude Code writes before UserPromptSubmit runs:
// the turn is `enqueue {content}` then a content-less `dequeue`; its own user record follows the hook.
function claudeNotificationTranscript(t, sessionId = input.session_id) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-claude-notification-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'session.jsonl');
  const main = { sessionId };
  return {
    path,
    write: records => writeFileSync(path, records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n')),
    queue: (operation, content, extra = {}) => ({ type: 'queue-operation', operation, ...main,
      ...(content === undefined ? {} : { content }), ...extra }),
    dequeue: (extra = {}) => ({ type: 'queue-operation', operation: 'dequeue', ...main, ...extra }),
    toolResult: (text, extra = {}) => ({ type: 'user', ...main,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_synthetic', content: text }] }, ...extra }),
    turn: (content, origin, extra = {}) => ({ type: 'user', ...main, origin, message: { role: 'user', content }, ...extra }),
    attachment: (prompt, commandMode, extra = {}) => ({ type: 'attachment', ...main,
      attachment: { type: 'queued_command', prompt, commandMode }, ...extra }),
    assistant: () => ({ type: 'assistant', ...main, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
  };
}

const SHELL_TASK = 'bsynth01x';
const MONITOR_TASK = 'br4synth9';
const taskNotification = (taskId = SHELL_TASK) => `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_synthetic</tool-use-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>`;
const monitorEvent = (line, taskId = MONITOR_TASK) => `<task-notification>\n<task-id>${taskId}</task-id>\n<summary>Monitor event: "synthetic watch"</summary>\n<event>${line}</event>\n</task-notification>`;
const ciMonitorEvent = '<ci-monitor-event>"Auto-fix" is watching PR #1: the synthetic check failed.</ci-monitor-event>';

test('Claude host notifications from session-owned background tasks preserve the original task before runtime work', async t => {
  const fixture = claudeNotificationTranscript(t);
  const { queue, dequeue, toolResult, turn, attachment, write } = fixture;
  const prompt = taskNotification();
  const native = { ...input, prompt, transcript_path: fixture.path };
  const started = toolResult(`Command running in background with ID: ${SHELL_TASK}. Output is being written to: synthetic.output`);
  const monitorStarted = toolResult(`Monitor started (task ${MONITOR_TASK}, expires in 30m).`);
  const invocations = [];
  const invoke = async name => { invocations.push(name); return { taskContextToken: 'fuli-task-synthetic' }; };
  const positives = [
    ['pending enqueue', [started, queue('enqueue', prompt)]],
    ['dequeued for this turn', [started, queue('enqueue', prompt), dequeue()]],
    ['another notification queued meanwhile', [started, queue('enqueue', prompt), dequeue(), queue('enqueue', taskNotification('bother001'))]],
    ['sidechain removal is not this session', [started, queue('enqueue', prompt), queue('remove', prompt, { isSidechain: true })]],
    ['Monitor event', [monitorStarted, queue('enqueue', monitorEvent('build ok')), dequeue()], monitorEvent('build ok')],
    ['Monitor started before the readable tail', [turn(monitorEvent('first line'), { kind: 'task-notification' }),
      queue('enqueue', monitorEvent('second line')), dequeue()], monitorEvent('second line')]
  ];
  for (const [label, records, submitted = prompt] of positives) {
    write(records);
    const output = await claudeLifecycleOutput('UserPromptSubmit', { ...native, prompt: submitted }, invoke);
    assert.match(output.hookSpecificOutput.additionalContext, /Keep the current task context/, label);
    assert.doesNotMatch(JSON.stringify(output), /fuli-task-synthetic|effective_preferences|begin_task_context/, label);
  }
  assert.deepEqual(invocations, []);
  write([started, queue('enqueue', prompt), dequeue()]);
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
    '--event', 'UserPromptSubmit', '--runtime-config', join(dirname(fixture.path), 'must-not-open.json')], {
    input: JSON.stringify(native), encoding: 'utf8', timeout: 5000
  });
  assert.equal(command.status, 0);
  assert.equal(command.stderr, '');
  assert.deepEqual(JSON.parse(command.stdout), direct);
  await claudeLifecycleOutput('Stop', native, async name => {
    assert.equal(name, 'verify_task_checkpoint'); return { decision: 'block', reason: 'FULI_CHECKPOINT_REQUIRED: original task' };
  }).then(stop => assert.equal(stop.systemMessage, 'FULI_CHECKPOINT_REQUIRED: original task'));

  const delivered = [started, queue('enqueue', prompt), dequeue(), turn(prompt, { kind: 'task-notification' }), fixture.assistant()];
  const negatives = [
    ['no queue source', [started, turn(prompt, { kind: 'human' })]],
    ['removed queue', [started, queue('enqueue', prompt), queue('remove', prompt)]],
    ['removal without payload', [started, queue('enqueue', prompt), queue('remove')]],
    ['different session', [started, queue('enqueue', prompt, { sessionId: 'another-session' })]],
    ['different prompt', [started, queue('enqueue', prompt + '\nUser followup')]],
    ['sidechain source', [started, queue('enqueue', prompt, { isSidechain: true })]],
    ['queued by a person', [started, queue('enqueue', prompt), attachment(prompt, 'prompt')]],
    ['absorbed into a turn', [started, queue('enqueue', prompt), attachment(prompt, 'task-notification')]],
    ['person queued the same text earlier', [started, queue('enqueue', prompt), attachment(prompt, 'prompt'),
      queue('remove', prompt), queue('enqueue', prompt), dequeue()]],
    ['paste of a delivered notification', [...delivered, queue('enqueue', prompt), dequeue()]],
    ['paste of a delivered notification without the queue', delivered],
    ['paste of an absorbed notification', [started, queue('enqueue', prompt), attachment(prompt, 'task-notification'),
      queue('remove', prompt, { reason: 'absorbed_mid_turn' }), queue('enqueue', prompt), dequeue()]],
    ['task this session never started', [queue('enqueue', prompt), dequeue()]],
    ['task named only after the enqueue', [queue('enqueue', prompt), started, dequeue()]],
    ['task id inside a longer token', [toolResult(`ID: x${SHELL_TASK}2`), queue('enqueue', prompt), dequeue()]],
    ['task named by a person', [turn(`please watch ${SHELL_TASK}`, { kind: 'human' }), queue('enqueue', prompt), dequeue()]],
    ['earlier notification the host did not record', [turn(taskNotification(), { kind: 'human' }),
      queue('enqueue', prompt), dequeue()], taskNotification()],
    ['task started in a sidechain', [toolResult(`ID: ${SHELL_TASK}`, { isSidechain: true }), queue('enqueue', prompt), dequeue()]],
    ['invalid JSON', ['{invalid', started, queue('enqueue', prompt)]],
    ['partial trailing record', [started, queue('enqueue', prompt), '{"type":"queue-operation","operation":"remove"']],
    ['forged prefix only', [started, queue('enqueue', '<task-notification><task-id>')], '<task-notification><task-id>'],
    ['empty task identifier', [started, queue('enqueue', '<task-notification><task-id> </task-id></task-notification>')],
      '<task-notification><task-id> </task-id></task-notification>'],
    ['multiple envelopes', [started, queue('enqueue', prompt + prompt)], prompt + prompt],
    ['pasted surrounding text', [started, queue('enqueue', 'Please inspect ' + prompt)], 'Please inspect ' + prompt],
    ['user continuation', [started, queue('enqueue', prompt + '\nNow do another task')], prompt + '\nNow do another task'],
    // The desktop app queues CI monitor events as ordinary prompts that name no session-owned id.
    ['CI monitor event', [started, queue('enqueue', ciMonitorEvent), dequeue()], ciMonitorEvent]
  ];
  for (const [label, records, submitted = prompt] of negatives) {
    write(records); invocations.length = 0;
    await claudeLifecycleOutput('UserPromptSubmit', { ...native, prompt: submitted }, invoke);
    assert.deepEqual(invocations, ['begin_task_context'], label);
  }
  invocations.length = 0;
  await claudeLifecycleOutput('UserPromptSubmit', { ...native, transcript_path: join(dirname(fixture.path), 'missing.jsonl') }, invoke);
  assert.deepEqual(invocations, ['begin_task_context'], 'unreadable transcript must preserve normal entry');

  const encoded = [started, queue('enqueue', prompt)].map(record => JSON.stringify(record)).join('\n');
  // The bounded tail can begin at valid-looking JSON inside a cut, invalid line.
  writeFileSync(fixture.path, 'cut-prefix' + encoded + ' '.repeat(512 * 1024 - Buffer.byteLength(encoded) - 1) + '\n');
  invocations.length = 0;
  await claudeLifecycleOutput('UserPromptSubmit', native, invoke);
  assert.deepEqual(invocations, ['begin_task_context'], 'a truncated first line is not host evidence');
  // Cutting inside UTF-8 must not hide complete records on the next lines.
  writeFileSync(fixture.path, '记'.repeat(200_000) + '\n' + encoded + '\n');
  invocations.length = 0;
  await claudeLifecycleOutput('UserPromptSubmit', native, invoke);
  assert.deepEqual(invocations, [], 'complete records after a discarded partial line remain usable');
});

test('Claude Monitor notification turns inject at least 80% fewer bytes and the next user task gets every change', async t => {
  const fixture = claudeNotificationTranscript(t);
  const { queue, dequeue, toolResult, turn, write } = fixture;
  // A synthetic entry of the size seen on real Monitor turns (~3 KB).
  let revision = 1;
  const retrievals = [];
  const delivered = [];
  const taskContext = () => ({
    taskContextToken: `fuli-task-revision-${revision}`,
    checkpoint_required: revision > 1,
    effective_preferences: [{ instruction: `Synthetic preference, revision ${revision}.` }],
    preference_conflicts: revision > 1 ? [{ summary: 'Synthetic conflict between two saved preferences.' }] : [],
    task_knowledge_recall: { status: 'matched', items: Array.from({ length: 8 }, (_, index) => ({
      id: `synthetic-knowledge-${index}`, summary: `Synthetic project fact ${index}: ${'detail '.repeat(30)}` })) },
    project_agent_snapshot: `Synthetic directory snapshot: ${'src/module.js '.repeat(40)}`
  });
  const invoke = async (name, parameters) => { retrievals.push([name, parameters.taskPrompt]); return taskContext(); };
  const delivery = { deliver: async (value, _origin, format) => { delivered.push(value.taskContextToken); return format(value); } };
  const bytes = output => Buffer.byteLength(JSON.stringify(output));
  const submit = prompt => claudeLifecycleOutput('UserPromptSubmit', { ...input, prompt, transcript_path: fixture.path },
    invoke, { delivery });

  const first = await submit('Synthetic user task: watch the build.');
  assert.match(first.hookSpecificOutput.additionalContext, /revision 1/);
  const events = Array.from({ length: 10 }, (_, index) => monitorEvent(`synthetic build line ${index}`));
  const history = [turn('Synthetic user task: watch the build.', { kind: 'human' }),
    toolResult(`Monitor started (task ${MONITOR_TASK}, expires in 30m).`)];
  // Before: the same ten turns without the session-owned task evidence take the full entry, as every
  // dequeued notification did when a content-less dequeue was read as a removal.
  let before = 0;
  for (const event of events) {
    write([turn('Synthetic user task: watch the build.', { kind: 'human' }), queue('enqueue', event), dequeue()]);
    before += bytes(await submit(event));
  }
  assert.equal(retrievals.length, 11);
  retrievals.length = 0; delivered.length = 0;
  // Preferences, a conflict and a checkpoint requirement change while notification turns run.
  revision = 2;
  let after = 0;
  for (const event of events) {
    write([...history, queue('enqueue', event), dequeue()]);
    const output = await submit(event);
    assert.match(output.hookSpecificOutput.additionalContext, /not a new user task/);
    after += bytes(output);
    history.push(queue('enqueue', event), dequeue(), turn(event, { kind: 'task-notification' }), fixture.assistant());
  }
  t.diagnostic(`10 Monitor notification turns: before ${before} bytes, after ${after} bytes (${Math.round(100 - after * 100 / before)}% less)`);
  assert.ok(after <= before * 0.2, `expected at least 80% fewer bytes: before ${before}, after ${after}`);
  // A skipped turn neither retrieves nor records a delivery, so nothing is acknowledged early.
  assert.deepEqual(retrievals, []);
  assert.deepEqual(delivered, []);

  write([...history, queue('enqueue', 'Synthetic user task: fix the failing test.'), dequeue()]);
  const next = await submit('Synthetic user task: fix the failing test.');
  assert.deepEqual(retrievals, [['begin_task_context', 'Synthetic user task: fix the failing test.']]);
  assert.deepEqual(delivered, ['fuli-task-revision-2']);
  const context = next.hookSpecificOutput.additionalContext;
  assert.match(context, /revision 2/);
  assert.match(context, /Synthetic conflict between two saved preferences/);
  assert.match(context, /"checkpoint_required":true/);
  assert.match(context, /fuli-task-revision-2/);
});

test('Claude adapter releases runtime resources after failure and preserves request cancellation', async () => {
  const closed = [];
  const controller = new AbortController();
  await assert.rejects(runClaudeLifecycleHook(['--event', 'UserPromptSubmit'], {
    signal: controller.signal,
    readInput: async () => input,
    resolveRuntimeOptions: () => ({ runtimeConfigPath: RUNTIME_CONFIG }),
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
    '--event', 'UserPromptSubmit', '--runtime-config', join(RUNTIME_ROOT, 'missing.json')], {
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
    '--event', 'UserPromptSubmit', '--runtime-config', join(RUNTIME_ROOT, 'private-missing.json')], {
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
