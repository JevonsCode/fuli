import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { claudeLifecycleOutput, claudeLifecycleUnavailable, runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-hook.js';
import { claudeLifecycleCommand } from '../src/agents/claude-code/lifecycle-hooks.js';
import { transcriptCaptureLedger } from '../src/conversations/transcript-capture-gap.js';

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

const shellNotification = '<task-notification>\n<task-id>bsynth01x</task-id>\n<status>completed</status>\n</task-notification>';
const monitorEvent = line => `<task-notification>\n<task-id>br4synth9</task-id>\n<summary>Monitor event</summary>\n<event>${line}</event>\n</task-notification>`;
const ciMonitorEvent = '<ci-monitor-event>"Auto-fix" is watching PR #1: the synthetic check failed.</ci-monitor-event>';

// A synthetic host session whose current task the fake reader re-reads in place.
function refreshFixture({ task = { token: 'fuli-task-a', sessionId: input.session_id, sourceApplication: 'claude_code', checkpoint: null },
  read } = {}) {
  const calls = [];
  let revision = 1;
  const invoke = async (name, parameters) => {
    calls.push([name, parameters]);
    if (name === 'begin_task_context') return { taskContextToken: 'fuli-task-new-entry' };
    assert.equal(name, 'read_task_preferences');
    if (read) return read(parameters);
    return { taskContextToken: parameters.taskContextToken, checkpoint_required: revision > 1,
      effective_preferences: [{ instruction: `Synthetic preference, revision ${revision}.` }],
      active_conflicts: revision > 1 ? [{ id: 'synthetic-conflict' }] : [] };
  };
  const submit = (prompt, extra = {}) => claudeLifecycleOutput('UserPromptSubmit', { ...input, prompt, ...extra }, invoke,
    { currentTask: async (sessionId, source) => { calls.push(['current', sessionId, source]); return task; } });
  return { calls, invoke, submit, change: () => { revision = 2; } };
}

test('Claude host-notification envelopes and system deliveries refresh the current task in place, never enter', async () => {
  const refreshed = [shellNotification, monitorEvent('build ok'), ciMonitorEvent,
    `<ci-monitor-event>outer <ci-monitor-event>nested</ci-monitor-event> event</ci-monitor-event>`];
  for (const [prompt, extra] of [...refreshed.map(prompt => [prompt, {}]), ['Any text the host delivers.', { isMeta: true }]]) {
    const f = refreshFixture();
    const output = await f.submit(prompt, extra);
    assert.deepEqual(f.calls.map(([name]) => name), ['current', 'read_task_preferences'], prompt);
    assert.deepEqual(f.calls[1][1], { taskContextToken: 'fuli-task-a', sourceApplication: 'claude_code',
      sourceSessionId: input.session_id, sourceSessionVerified: true });
    const context = output.hookSpecificOutput.additionalContext;
    if (extra.isMeta) assert.match(context, /本轮是宿主系统投递，但任务归属未确认.*host system delivery, but its task ownership is not confirmed/);
    else assert.match(context, /来源和任务归属都未确认.*its source and task ownership are not confirmed; no task was created or switched/);
    // The refreshed task is shown for reference, never as this turn's task.
    assert.match(context, /is not this turn's confirmed task/);
    assert.match(context, /start a task explicitly with get_collaboration_preferences/);
    assert.doesNotMatch(context, /not a new user task|Pass taskContextToken to every FULI call/);
    assert.match(context, /"taskContextToken":"fuli-task-a"/);
    assert.doesNotMatch(context, /fuli-task-new-entry/);
  }
  // Anything else is a prompt and enters as before.
  for (const prompt of ['Synthetic user task.', 'Please inspect ' + shellNotification, shellNotification + '\nNow do another task',
    shellNotification + shellNotification, '<task-notification><task-id> </task-id></task-notification>', '<task-notification><task-id>',
    ciMonitorEvent + ciMonitorEvent, '<ci-monitor-event> </ci-monitor-event>', 'See ' + ciMonitorEvent]) {
    const f = refreshFixture();
    const output = await f.submit(prompt);
    assert.deepEqual(f.calls.map(([name]) => name), ['begin_task_context'], prompt);
    assert.match(output.hookSpecificOutput.additionalContext, /fuli-task-new-entry/);
  }
});

test('Claude refresh turns ignore transcript source guesses and deliver every mid-run change', async t => {
  // dot, #272: a task id in tool output, a paste after the tail window, or any queue record is no
  // longer evidence for anything; the envelope refreshes the current task whatever the transcript says.
  const directory = mkdtempSync(join(tmpdir(), 'fuli-claude-refresh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const transcript = join(directory, 'session.jsonl');
  writeFileSync(transcript, [
    { type: 'user', sessionId: input.session_id, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'Read: br4synth9' }] } },
    { type: 'queue-operation', operation: 'enqueue', sessionId: input.session_id, content: monitorEvent('line 0') },
    { type: 'user', sessionId: input.session_id, origin: { kind: 'task-notification' }, message: { content: monitorEvent('line 0') } },
    { type: 'user', sessionId: input.session_id, message: { content: 'x'.repeat(600 * 1024) } },
    { type: 'queue-operation', operation: 'enqueue', sessionId: input.session_id, content: monitorEvent('line 0') }
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  const f = refreshFixture();
  for (let index = 0; index < 10; index += 1) {
    if (index === 4) f.change();
    const context = (await f.submit(monitorEvent('line 0'), { transcript_path: transcript })).hookSpecificOutput.additionalContext;
    assert.match(context, new RegExp(`revision ${index < 4 ? 1 : 2}`));
    if (index >= 4) {
      assert.match(context, /synthetic-conflict/);
      assert.match(context, /"checkpoint_required":true/);
    }
  }
  assert.ok(f.calls.every(([name]) => name !== 'begin_task_context'));
});

test('Claude refresh turns with nothing to re-read say so and start no task', async () => {
  const owned = { token: 'fuli-task-a', sessionId: input.session_id, sourceApplication: 'claude_code', checkpoint: null };
  const cases = [
    ['no current task', { task: null }, /本会话没有当前任务.*\(this session has no current task\)/],
    ['closed task', { task: { ...owned, checkpoint: { phase: 'complete' } } }, /\(the current task of this session is closed\)/],
    ['another session', { task: { ...owned, sessionId: 'another-session' } }, /\(the current task belongs to another session\)/],
    ['missing Agent or scope', { task: owned, read: () => { throw Object.assign(new Error('Recovery requires the task Agent identity.'),
      { code: 'preference_recovery_blocked' }); } }, /\(the current task's ownership or scope could not be confirmed: Recovery requires the task Agent identity\.\)/],
    ['unknown or superseded token', { task: owned, read: () => { throw Object.assign(new Error('private Provider detail'),
      { code: 'not_found' }); } }, /\(the current task's ownership or scope could not be confirmed\); no task/],
    ['FULI stopped since the task began', { task: owned, read: () => ({ status: 'fuli_off' }) }, /\(FULI is off for this session\)/]
  ];
  for (const [label, options, expected] of cases) {
    const f = refreshFixture(options);
    const context = (await f.submit(shellNotification)).hookSpecificOutput.additionalContext;
    assert.match(context, expected, label);
    assert.match(context, /FULI：本轮没有建立有效的任务上下文.*FULI: no valid task context is established for this turn/, label);
    assert.match(context, /no task was created or switched\. If this turn is new work, start a task explicitly/, label);
    // The old token is never presented as this turn's task.
    assert.doesNotMatch(context, /fuli-task-a|private Provider detail|keep using/, label);
    assert.ok(f.calls.every(([name]) => name !== 'begin_task_context'), label);
  }
  // A session FULI is off for is refused before anything is read.
  const f = refreshFixture();
  const off = await claudeLifecycleOutput('UserPromptSubmit', { ...input, prompt: shellNotification }, f.invoke,
    { currentTask: async () => owned, entryRefusal: async () => ({ reason: 'session_off' }) });
  assert.doesNotMatch(off.hookSpecificOutput.additionalContext, /refreshed/);
  assert.deepEqual(f.calls, []);
  // An unavailable runtime never tells the model to start a task for a refresh turn.
  const unavailable = claudeLifecycleUnavailable('UserPromptSubmit', { ...input, prompt: shellNotification });
  assert.doesNotMatch(unavailable.hookSpecificOutput.additionalContext, /First call get_collaboration_preferences/);
  assert.match(unavailable.hookSpecificOutput.additionalContext, /start a task explicitly with get_collaboration_preferences/);
  assert.match(claudeLifecycleUnavailable('UserPromptSubmit', input).hookSpecificOutput.additionalContext,
    /First call get_collaboration_preferences/);
});

test('Claude installed hook refreshes in place without a task entry or transcript claim', async () => {
  const calls = [];
  const never = name => () => { throw new Error('Unexpected refresh work: ' + name); };
  const app = { config: { personal: { spaceId: 'synthetic-space' } },
    taskContextRegistry: { current: async () => ({ token: 'fuli-task-a', sessionId: input.session_id,
      sourceApplication: 'claude_code', checkpoint: null }) },
    getCapturePolicy: () => ({ enabled: true }), personal: { conversation: never('conversation') } };
  const output = await runClaudeLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => ({ ...input, prompt: shellNotification }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: RUNTIME_CONFIG }), openApplication: () => app,
    createLeases: () => ({ withGraphLease: async (_owner, run) => run() }), onTranscriptGuard: never('transcript'),
    callTool: async (_app, name, parameters) => { calls.push(name); return { taskContextToken: parameters.taskContextToken,
      effective_preferences: [{ instruction: 'Synthetic refreshed preference.' }] }; }
  });
  assert.deepEqual(calls, ['read_task_preferences']);
  assert.match(output.hookSpecificOutput.additionalContext, /Synthetic refreshed preference/);
  assert.match(output.hookSpecificOutput.additionalContext, /"taskContextToken":"fuli-task-a"/);
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

// A synthetic host session through the installed hook: a fake Provider keeps
// the transcript cursor and what each append attributed to which task.
async function unresolvedTurnSession(t) {
  const { mkdtemp, rm, appendFile, writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'fuli-claude-unresolved-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const runtimeConfigPath = join(directory, 'runtime.json');
  const transcript = join(directory, 'session.jsonl');
  const line = record => JSON.stringify({ sessionId: input.session_id, ...record }) + '\n';
  await writeFile(transcript, line({ type: 'user', message: { role: 'user', content: 'Synthetic task A.' } }));
  const task = { token: 'fuli-task-synthetic-a', project_agent_id: 'engineer', personal_project_id: 'synthetic-project',
    session_id: input.session_id, source_application: 'claude_code', personal_space_id: 'synthetic-space', entry_via: 'hook' };
  const state = { current: task, checkpointed: false, cursor: 0, appended: [] };
  const calls = [];
  const app = { config: { personal: { spaceId: 'synthetic-space' } }, getCapturePolicy: () => ({ enabled: true }),
    getCapturePolicyVersion: () => 'absent',
    taskContextRegistry: { current: async () => state.current && { token: state.current.token, sessionId: input.session_id,
      sourceApplication: 'claude_code', checkpoint: state.checkpointed ? { phase: 'complete' } : null } },
    personal: {
      currentTaskContext: async () => state.current,
      conversation: async (operation, query) => {
        if (query.mode === 'policy') return { enabled: true };
        if (query.mode === 'session') return { initialized: true, cursor: state.cursor };
        if (operation === 'append') {
          assert.equal(query.expected_cursor, state.cursor);
          state.appended.push(...query.events.map(event => ({ token: query.task_context_token, ...event })));
          state.cursor = query.cursor;
          return { status: 'saved' };
        }
        return { status: 'saved', cursor: state.cursor };
      }
    } };
  const { prompt: _prompt, ...native } = { ...input, transcript_path: transcript };
  const hook = (event, extra = {}) => runClaudeLifecycleHook(['--event', event], {
    readInput: async () => ({ ...native, ...extra }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath }), openApplication: () => app,
    createLeases: () => ({ withGraphLease: async (_owner, run) => run() }), captureTimeoutMs: 30_000,
    callTool: async (_app, name, parameters) => {
      calls.push(name);
      if (name === 'read_task_preferences') return { taskContextToken: parameters.taskContextToken,
        effective_preferences: [{ instruction: 'Synthetic preference.' }] };
      if (name === 'begin_task_context') {
        state.current = { ...task, token: 'fuli-task-synthetic-b' };
        state.checkpointed = false;
        return { taskContextToken: state.current.token, effective_preferences: [] };
      }
      if (name === 'verify_task_checkpoint') return state.checkpointed ? { status: 'checkpointed' }
        : { decision: 'block', entry_via: 'hook', task_context_token: state.current.token, reason: 'FULI_CHECKPOINT_REQUIRED: synthetic' };
      if (name === 'checkpoint_task_knowledge') state.checkpointed = true;
      return { status: 'saved' };
    } });
  const ledger = transcriptCaptureLedger(runtimeConfigPath, input, 'claude_code');
  const host = record => appendFile(transcript, line(record));
  const notification = '<task-notification>\n<task-id>bsynth01x</task-id>\n<status>completed</status>\n</task-notification>';
  return { state, calls, hook, ledger, task, host,
    // A notification-shaped turn; the same envelope pasted by a person reaches the hook identically.
    async refreshTurn(reply = 'SYNTHETIC_UNKNOWN_TURN_REPLY') {
      await host({ type: 'user', message: { role: 'user', content: notification } });
      await hook('UserPromptSubmit', { prompt: notification });
      await host({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
      return ledger.heldTurns().turns.at(-1);
    },
    // A Stop that settles nothing: no verify, no automatic checkpoint.
    async quietStop(label) {
      calls.length = 0;
      const output = await hook('Stop');
      assert.match(output.systemMessage ?? '', /^(Fuli: 这段内容的任务归属未确认，未记入任何任务；原文仍在本地会话记录中)?$/, label);
      assert.deepEqual(calls, [], `${label}: the held task is neither verified nor settled`);
    },
    said: () => state.appended.filter(event => !/^\[Not recorded/.test(event.content)) };
}

const checkpointCall = (id, token) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id,
  name: 'mcp__fuli__checkpoint_task_knowledge', input: { taskContextToken: token, disposition: 'retain_nothing' } }] } });
const toolResult = (id, extra = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
  content: '{"status":"checkpointed"}', ...extra }] } });

test('Claude Stop of an unresolved turn neither settles nor records under the task until an explicit continuation', async t => {
  const s = await unresolvedTurnSession(t);
  for (const label of ['notification-shaped turn', 'pasted envelope']) {
    assert.ok(await s.refreshTurn(), label);
    await s.quietStop(label);
    await s.quietStop(`${label}, repeated Stop`);
  }
  assert.doesNotMatch(JSON.stringify(s.said()), /SYNTHETIC_UNKNOWN_TURN_REPLY|task-notification/);
  assert.ok(s.state.appended.some(event => /task ownership was not confirmed/.test(event.content)), 'skipped with a reason');
  // Calls that name A's token but do not state this turn is A's.
  const nonResolving = [
    ['a read-only call', [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read',
      name: 'mcp__fuli__read_task_preferences', input: { taskContextToken: s.task.token } }] } }, toolResult('toolu_read')]],
    ['a search naming the token', [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_search',
      name: 'mcp__fuli__search_knowledge_graph', input: { query: 'x', taskContextToken: s.task.token } }] } }, toolResult('toolu_search')]],
    ['a failed checkpoint', [checkpointCall('toolu_failed', s.task.token), toolResult('toolu_failed', { is_error: true })]],
    ['a checkpoint without its result', [checkpointCall('toolu_pending', s.task.token)]],
    ['another tool naming the token', [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use',
      id: 'toolu_bash', name: 'Bash', input: { command: `echo ${s.task.token}` } }] } }, toolResult('toolu_bash')]]
  ];
  for (const [label, records] of nonResolving) {
    await s.refreshTurn();
    for (const record of records) await s.host(record);
    await s.quietStop(label);
  }
  // A checkpoint call of an earlier turn whose result arrives in a newer turn does not end the newer turn.
  await s.refreshTurn();
  await s.host(checkpointCall('toolu_old', s.task.token));
  const older = s.ledger.heldTurns().turns.at(-1);
  const newer = await s.refreshTurn();
  assert.notEqual(newer.turn, older.turn);
  await s.host(toolResult('toolu_old'));
  s.state.checkpointed = true;
  await s.quietStop('a delayed receipt from an earlier turn');
  assert.equal(s.ledger.endTurns(older.turn), false, 'an older turn id never ends a newer turn');
  assert.deepEqual(s.ledger.heldTurns().turns.at(-1), newer);
  s.state.checkpointed = false;
  // An explicit, successful continuation in the turn, confirmed by the Provider: recording resumes for A.
  await s.refreshTurn('SYNTHETIC_CONTINUED_REPLY');
  await s.host(checkpointCall('toolu_ok', s.task.token));
  await s.host(toolResult('toolu_ok'));
  s.state.checkpointed = true;
  s.calls.length = 0;
  await s.hook('Stop');
  assert.deepEqual(s.calls, ['verify_task_checkpoint']);
  assert.deepEqual(s.ledger.heldTurns().turns, []);
  assert.ok(s.said().some(event => event.token === s.task.token && /SYNTHETIC_CONTINUED_REPLY/.test(event.content)));
  assert.doesNotMatch(JSON.stringify(s.said()), /SYNTHETIC_UNKNOWN_TURN_REPLY/);
});

test('Claude unresolved turns stay held through resets until a fresh entry, and never settle the held task', async t => {
  const s = await unresolvedTurnSession(t);
  await s.refreshTurn();
  for (const [label, reset] of [['SessionStart resume', () => s.hook('SessionStart', { source: 'resume' })],
    ['SessionStart clear', () => s.hook('SessionStart', { source: 'clear' })],
    ['SessionStart startup', () => s.hook('SessionStart', { source: 'startup' })],
    ['compaction', () => s.hook('PreCompact', { trigger: 'auto' })]]) {
    await reset();
    assert.ok(s.ledger.heldTurns().turns.length, label);
    await s.host({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SYNTHETIC_AFTER_RESET' }] } });
    await s.quietStop(label);
    await s.quietStop(`${label}, repeated Stop`);
  }
  assert.doesNotMatch(JSON.stringify(s.said()), /SYNTHETIC_UNKNOWN_TURN_REPLY|SYNTHETIC_AFTER_RESET/);
  // A fresh entry is evidence from its own turn: B starts normally and its Stop settles B.
  await s.host({ type: 'user', message: { role: 'user', content: 'Synthetic task B.' } });
  await s.hook('UserPromptSubmit', { prompt: 'Synthetic task B.' });
  assert.deepEqual(s.ledger.heldTurns().turns, []);
  assert.equal(s.state.current.token, 'fuli-task-synthetic-b');
  await s.host({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SYNTHETIC_TASK_B_REPLY' }] } });
  s.calls.length = 0;
  await s.hook('Stop');
  assert.deepEqual(s.calls, ['verify_task_checkpoint', 'checkpoint_task_knowledge']);
  assert.ok(s.said().some(event => event.token === 'fuli-task-synthetic-b' && /SYNTHETIC_TASK_B_REPLY/.test(event.content)));
  assert.doesNotMatch(JSON.stringify(s.said()), /SYNTHETIC_UNKNOWN_TURN_REPLY|SYNTHETIC_AFTER_RESET/);
});

test('Claude unresolved turn ends without an owner when another task became current during it', async t => {
  const s = await unresolvedTurnSession(t);
  await s.refreshTurn('SYNTHETIC_MOVED_REPLY');
  s.state.current = { ...s.task, token: 'fuli-task-synthetic-c' };
  s.calls.length = 0;
  await s.hook('Stop');
  assert.deepEqual(s.ledger.heldTurns().turns, []);
  assert.deepEqual(s.calls, ['verify_task_checkpoint', 'checkpoint_task_knowledge'], 'the new current task settles normally');
  assert.doesNotMatch(JSON.stringify(s.said()), /SYNTHETIC_MOVED_REPLY/);
});
