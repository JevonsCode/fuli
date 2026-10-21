import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { claudeLifecycleOutput, runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-hook.js';
import { claudeLifecycleCommand } from '../src/agents/claude-code/lifecycle-hooks.js';
import { callAgentTool } from '../src/agent-tools.js';
import { beginTaskContext } from '../src/graphiti/agent-knowledge-workflows.js';
import { TaskContextRegistry } from './fixtures/in-memory-task-context-registry.js';

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

// Synthetic records in the shapes the former host-notification checks accepted
// as proof that the host started a turn. None is proof: a person's queued
// command is enqueued the same way, and only a later attachment tells them apart.
function claudeNotificationTranscript(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-claude-notification-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'session.jsonl');
  const main = { sessionId: input.session_id };
  return {
    path,
    write: lines => writeFileSync(path, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n'),
    queue: (operation, content) => ({ type: 'queue-operation', operation, ...main, ...(content === undefined ? {} : { content }) }),
    toolResult: text => ({ type: 'user', ...main,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_synthetic', content: text }] } }),
    turn: (content, origin) => ({ type: 'user', ...main, origin, message: { role: 'user', content } })
  };
}

const shellNotification = '<task-notification>\n<task-id>bsynth01x</task-id>\n<status>completed</status>\n</task-notification>';
const monitorEvent = line => `<task-notification>\n<task-id>br4synth9</task-id>\n<summary>Monitor event</summary>\n<event>${line}</event>\n</task-notification>`;
const ciMonitorEvent = '<ci-monitor-event>"Auto-fix" is watching PR #1: the synthetic check failed.</ci-monitor-event>';

test('Claude prompts shaped like host notifications enter like any prompt, whatever the transcript shows', async t => {
  const fixture = claudeNotificationTranscript(t);
  const { queue, toolResult, turn, write } = fixture;
  const filler = turn('x'.repeat(600 * 1024), { kind: 'human' });
  const cases = [
    // Accepted before this change: a pending exact enqueue. A person's queued command looks the same.
    ['pending enqueue of the exact text', shellNotification, [queue('enqueue', shellNotification)]],
    ['enqueue then dequeue', shellNotification, [queue('enqueue', shellNotification), queue('dequeue')]],
    // dot, #272 P2 1: a task id that only appears in tool output proves nothing about the sender.
    ['task id named by tool output', shellNotification, [toolResult('Read result: ... bsynth01x ...'),
      queue('enqueue', shellNotification), queue('dequeue')]],
    // dot, #272 P2 2: the earlier delivery left the readable tail; a same-id event is still inside it.
    ['paste after the earlier delivery left the tail', monitorEvent('build ok'), [
      queue('enqueue', monitorEvent('build ok')), queue('dequeue'), turn(monitorEvent('build ok'), { kind: 'task-notification' }),
      filler, turn(monitorEvent('second line'), { kind: 'task-notification' }),
      queue('enqueue', monitorEvent('build ok')), queue('dequeue')]],
    ['Monitor event', monitorEvent('build ok'), [queue('enqueue', monitorEvent('build ok')), queue('dequeue')]],
    ['CI monitor event', ciMonitorEvent, [queue('enqueue', ciMonitorEvent), queue('dequeue')]],
    ['no transcript record', shellNotification, []]
  ];
  for (const [label, prompt, lines] of cases) {
    write(lines);
    for (const native of [{ ...input, prompt, transcript_path: fixture.path }, { ...input, prompt, transcript_path: fixture.path, isMeta: true }]) {
      const invocations = [];
      const output = await runClaudeLifecycleHook(['--event', 'UserPromptSubmit'], { readInput: async () => native,
        invoke: async name => { invocations.push(name); return { taskContextToken: 'fuli-task-full-entry' }; } });
      assert.deepEqual(invocations, ['begin_task_context'], label);
      assert.match(output.hookSpecificOutput.additionalContext, /fuli-task-full-entry/, label);
      assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /not a new user task/, label);
    }
  }
});

test('Claude notification-shaped turns deliver every mid-run change in full', async () => {
  // dot, #272 P2 3: preference, conflict and checkpoint changes during a long monitor reach the very next turn.
  let revision = 1;
  const invoke = async () => ({ taskContextToken: `fuli-task-revision-${revision}`, checkpoint_required: revision > 1,
    effective_preferences: [{ instruction: `Synthetic preference, revision ${revision}.` }],
    active_conflicts: revision > 1 ? [{ id: 'synthetic-conflict' }] : [] });
  for (let index = 0; index < 10; index += 1) {
    if (index === 4) revision = 2;
    const output = await claudeLifecycleOutput('UserPromptSubmit', { ...input, prompt: monitorEvent(`line ${index}`) }, invoke);
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, new RegExp(`revision ${revision}`));
    if (revision > 1) {
      assert.match(context, /synthetic-conflict/);
      assert.match(context, /"checkpoint_required":true/);
    }
  }
});

test('Claude notification-shaped turns of unknown source begin a task exactly as a user prompt does', async () => {
  // The real entry path with a synthetic Provider: begin_task_context through the Agent tool dispatcher.
  let index = 0;
  const registry = new TaskContextRegistry({ tokenFactory: () => `fuli-task-synthetic-${index += 1}` });
  const app = { config: { personal: { spaceId: 'synthetic-space' } }, taskContextRegistry: registry,
    getCapturePolicy: () => ({ enabled: true }), personal: { conversation: async () => ({ status: 'saved' }) },
    getCollaborationPreferences: async () => ({
      context: { personal_space_id: 'synthetic-space', personal_project_id: 'synthetic-project', project_agent_id: null },
      effective_preferences: [{ instruction: 'Synthetic preference.' }], preferences_complete: true }) };
  app.beginTaskContext = parameters => beginTaskContext(app, parameters);
  const enter = prompt => claudeLifecycleOutput('UserPromptSubmit', { ...input, prompt },
    (name, parameters) => callAgentTool(app, name, parameters));
  const entries = [];
  for (const prompt of ['Synthetic user task: run the build in the background.', monitorEvent('build ok'),
    'Synthetic user follow-up.']) {
    const context = (await enter(prompt)).hookSpecificOutput.additionalContext;
    entries.push({ token: /"taskContextToken":"([^"]+)"/.exec(context)[1],
      previousMissing: /"previous_checkpoint_missing":true/.test(context) });
  }
  // Each entry, the notification-shaped one included, creates a task and makes it the session's current
  // one. The open task it replaces can no longer be checkpointed and the next entry reports it missing.
  // Right for a person's prompt; for a real host notification this moves the task. Keeping the task on a
  // notification needs a provable host source, which neither the hook input nor the transcript has.
  assert.deepEqual(entries, [{ token: 'fuli-task-synthetic-1', previousMissing: false },
    { token: 'fuli-task-synthetic-2', previousMissing: true }, { token: 'fuli-task-synthetic-3', previousMissing: true }]);
  assert.throws(() => registry.checkpoint('fuli-task-synthetic-1', { disposition: 'retain_nothing' }, 'claude_code'),
    /unknown or superseded/);
  assert.equal(registry.verify(input.session_id, 'claude_code').task_context_token, 'fuli-task-synthetic-3');
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
