import assert from 'node:assert/strict';
import test from 'node:test';

import {
  withCodexLifecycleHooks,
  withoutCodexLifecycleHooks,
  withoutCodexTomlLifecycleHooks
} from '../src/agents/codex/lifecycle-hooks.js';
import {
  codexStopLifecycleOutput,
  runCodexLifecycleHook
} from '../src/agents/codex/lifecycle-hook.js';
import {
  cursorLifecycleOutput,
  runCursorLifecycleHook
} from '../src/agents/cursor/lifecycle-hook.js';
import { withCursorLifecycleHooks, withoutCursorLifecycleHooks } from '../src/agents/cursor/lifecycle-hooks.js';

test('Codex lifecycle config preserves other hooks and deduplicates only Fuli entries', () => {
  const other = { hooks: [{ type: 'command', command: 'echo other' }] };
  const original = { description: 'User hooks', hooks: { Stop: [other] } };
  const configured = withCodexLifecycleHooks(original);
  assert.deepEqual(configured.hooks.Stop[0], other);
  assert.deepEqual(configured.hooks.UserPromptSubmit[0].hooks[0].input, {
    sessionId: '${session_id}', turnId: '${turn_id}', projectPath: '${cwd}', taskPrompt: '${prompt}'
  });
  assert.equal(configured.hooks.Stop[1].hooks[0].tool, 'verify_task_checkpoint');
  assert.deepEqual(withCodexLifecycleHooks(configured), configured);
  assert.deepEqual(withoutCodexLifecycleHooks(configured), original);
});

test('Codex Stop adapter blocks the first unfinished checkpoint', async () => {
  const calls = [];
  const output = await codexStopLifecycleOutput({
    session_id: 'codex-session',
    stop_hook_active: false
  }, async (name, input) => {
    calls.push([name, input]);
    return {
      status: 'checkpoint_required',
      decision: 'block',
      task_context_token: 'fuli-task-synthetic-token',
      reason: 'FULI_CHECKPOINT_REQUIRED: finish the checkpoint.'
    };
  });

  assert.deepEqual(output, {
    decision: 'block',
    reason: 'FULI_CHECKPOINT_REQUIRED: finish the checkpoint.'
  });
  assert.deepEqual(calls, [[
    'verify_task_checkpoint',
    {
      sessionId: 'codex-session',
      sourceApplication: 'codex',
      sourceSessionId: 'codex-session'
    }
  ]]);
});

test('Codex Stop adapter bounds Provider-controlled hook messages', async () => {
  const prefix = 'FULI_CHECKPOINT_REQUIRED: ';
  const output = await codexStopLifecycleOutput({
    session_id: 'codex-session',
    stop_hook_active: false
  }, async () => ({
    decision: 'block',
    reason: `${prefix}${'记'.repeat(10_000)}`
  }));

  assert.equal(output.reason.startsWith(prefix), true);
  assert.equal(Buffer.byteLength(output.reason, 'utf8') <= 8_000, true);
  assert.match(output.reason, /truncated/);
});

test('Codex Stop adapter closes an unfinished checkpoint after one continuation', async () => {
  const calls = [];
  const output = await codexStopLifecycleOutput({
    session_id: 'codex-session',
    stop_hook_active: true
  }, async (name, input) => {
    calls.push([name, input]);
    return name === 'verify_task_checkpoint'
      ? {
          status: 'checkpoint_required',
          decision: 'block',
          task_context_token: 'fuli-task-synthetic-token',
          reason: 'FULI_CHECKPOINT_REQUIRED: finish the checkpoint.'
        }
      : { status: 'checkpointed', disposition: 'retain_nothing' };
  });

  assert.deepEqual(output, {});
  assert.deepEqual(calls[1], [
    'checkpoint_task_knowledge',
    {
      taskContextToken: 'fuli-task-synthetic-token',
      disposition: 'retain_nothing',
      reason: 'Codex Stop hook fallback after one checkpoint continuation.',
      sourceApplication: 'codex',
      sourceSessionId: 'codex-session'
    }
  ]);
});

test('Codex lifecycle command emits the exact Stop JSON contract', async () => {
  const writes = [];
  await runCodexLifecycleHook(['--event', 'Stop'], {
    readInput: async () => ({
      session_id: 'codex-session',
      stop_hook_active: false
    }),
    invoke: async () => ({
      decision: 'block',
      reason: 'FULI_CHECKPOINT_REQUIRED: finish the checkpoint.'
    }),
    write: (value) => writes.push(value)
  });

  assert.deepEqual(writes, [
    '{"decision":"block","reason":"FULI_CHECKPOINT_REQUIRED: finish the checkpoint."}\n'
  ]);
});

test('Codex lifecycle cleanup failures cannot corrupt output or skip application cleanup', async () => {
  const writes = [];
  let closed = 0;
  const output = await runCodexLifecycleHook([
    '--runtime-config', '/synthetic/runtime.json', '--event', 'Stop'
  ], {
    readInput: async () => ({
      session_id: 'codex-session',
      stop_hook_active: false
    }),
    write: (value) => writes.push(value),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: '/synthetic/runtime.json' }),
    openApplication: () => ({
      async close() {
        closed += 1;
        throw new Error('/private/application/path');
      }
    }),
    createLeases: () => ({
      async withGraphLease(_purpose, callback) { return callback(); },
      async close() {
        closed += 1;
        throw new Error('/private/lease/path');
      }
    }),
    callTool: async () => ({
      decision: 'block',
      reason: 'FULI_CHECKPOINT_REQUIRED: checkpoint.'
    })
  });

  assert.deepEqual(output, {
    decision: 'block',
    reason: 'FULI_CHECKPOINT_REQUIRED: checkpoint.'
  });
  assert.deepEqual(writes, [
    '{"decision":"block","reason":"FULI_CHECKPOINT_REQUIRED: checkpoint."}\n'
  ]);
  assert.equal(closed, 2);
  assert.equal(writes.join('').includes('/private/'), false);
});

test('Codex lifecycle closes an opened application when lease creation fails', async () => {
  let appClosed = false;
  await assert.rejects(() => runCodexLifecycleHook([
    '--runtime-config', '/synthetic/runtime.json', '--event', 'Stop'
  ], {
    readInput: async () => ({ session_id: 'codex-session' }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: '/synthetic/runtime.json' }),
    openApplication: () => ({
      async close() { appClosed = true; }
    }),
    createLeases: () => {
      throw new Error('Synthetic lease creation failure');
    }
  }), /Synthetic lease creation failure/);
  assert.equal(appClosed, true);
});

test('Cursor adapter uses documented events and never reads raw transcript or identity fields', async () => {
  const calls = [];
  const invoke = async (name, input) => {
    calls.push([name, input]);
    return name === 'verify_task_checkpoint'
      ? { status: 'checkpoint_required', reason: 'FULI_CHECKPOINT_REQUIRED: fuli-task-fixture-token Checkpoint.' }
      : { context: { project_agent_id: 'engineer' }, taskContextToken: 'fuli-task-fixture-token' };
  };
  const input = { conversation_id: 'cursor-conversation', generation_id: 'generation-1',
    workspace_roots: ['/synthetic/project'], prompt: 'Fix the synthetic test.',
    user_email: 'DO_NOT_COPY', transcript_path: 'DO_NOT_READ' };
  const begin = await cursorLifecycleOutput('beforeSubmitPrompt', input, invoke);
  assert.deepEqual(begin, { continue: true });
  assert.deepEqual(calls[0], ['begin_task_context', {
    sessionId: 'cursor-conversation', turnId: 'generation-1',
    projectPath: '/synthetic/project', taskPrompt: 'Fix the synthetic test.',
    sourceApplication: 'cursor', sourceSessionId: 'cursor-conversation'
  }]);
  const start = await cursorLifecycleOutput('sessionStart', input, invoke);
  assert.match(start.additional_context, /get_collaboration_preferences/);
  const stop = await cursorLifecycleOutput('stop', { ...input, status: 'completed' }, invoke);
  assert.match(stop.followup_message, /^FULI_CHECKPOINT_REQUIRED:/);
  assert.deepEqual(await cursorLifecycleOutput('stop', { ...input, status: 'aborted' }, invoke), {});
  assert.equal(JSON.stringify(calls).includes('DO_NOT_'), false);
});

test('Cursor session start does not select a role before the first task prompt', async () => {
  let calls = 0;
  const output = await cursorLifecycleOutput('sessionStart', {
    session_id: 'cursor-fresh-session',
    workspace_roots: ['/synthetic/project']
  }, async () => {
    calls += 1;
    return {
      project_agent_context: {
        role: { name: 'Premature project default' },
        memory: { revision: 0 }
      }
    };
  });

  assert.equal(calls, 0, 'a prompt-less session must not preselect a durable role');
  assert.match(output.additional_context, /get_collaboration_preferences/);
  assert.match(output.additional_context, /current request/);
  assert.doesNotMatch(output.additional_context, /Premature project default/);
});

test('Cursor Stop adapter bounds Provider-controlled follow-up messages', async () => {
  const prefix = 'FULI_CHECKPOINT_REQUIRED: ';
  const output = await cursorLifecycleOutput('stop', {
    conversation_id: 'cursor-conversation',
    status: 'completed'
  }, async () => ({
    status: 'checkpoint_required',
    reason: `${prefix}${'记'.repeat(10_000)}`
  }));

  assert.equal(output.followup_message.startsWith(prefix), true);
  assert.equal(Buffer.byteLength(output.followup_message, 'utf8') <= 8_000, true);
  assert.match(output.followup_message, /truncated/);
});

test('Cursor lifecycle cleanup failures do not escape or disclose local details', async () => {
  const writes = [];
  let closed = 0;
  const output = await runCursorLifecycleHook([
    '--runtime-config', '/synthetic/runtime.json', '--event', 'stop'
  ], {
    readInput: async () => ({
      conversation_id: 'cursor-conversation',
      status: 'aborted'
    }),
    write: (value) => writes.push(value),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: '/synthetic/runtime.json' }),
    openApplication: () => ({
      async close() {
        closed += 1;
        throw new Error('/private/application/path');
      }
    }),
    createLeases: () => ({
      async withGraphLease(_purpose, callback) { return callback(); },
      async close() {
        closed += 1;
        throw new Error('/private/lease/path');
      }
    })
  });

  assert.deepEqual(output, {});
  assert.deepEqual(writes, ['{}\n']);
  assert.equal(closed, 2);
  assert.equal(writes.join('').includes('/private/'), false);
});

test('Cursor multi-root input never guesses which project owns private memory', async () => {
  let invoked = false;
  const output = await cursorLifecycleOutput('beforeSubmitPrompt', {
    conversation_id: 'cursor-conversation', workspace_roots: ['/synthetic/a', '/synthetic/b'],
    prompt: 'Continue.'
  }, async () => { invoked = true; });
  assert.equal(invoked, false);
  assert.equal(output.continue, true);
  assert.match(output.user_message, /exact project/i);
});

test('Cursor config is idempotent, bounded and removes only managed commands', () => {
  const context = { nodePath: '/synthetic runtime/node', mcpServerPath: '/synthetic/src/mcp-server.js',
    runtimeConfigPath: '/synthetic/config.json', platform: 'darwin' };
  const original = { version: 1, hooks: { stop: [{ command: 'user-script' }] } };
  const configured = withCursorLifecycleHooks(original, context);
  assert.equal(configured.hooks.stop.length, 2);
  assert.equal(configured.hooks.stop[1].loop_limit, 2);
  assert.match(configured.hooks.beforeSubmitPrompt[0].command, /--fuli-lifecycle/);
  assert.deepEqual(withCursorLifecycleHooks(configured, context), configured);
  assert.deepEqual(withoutCursorLifecycleHooks(configured), original);
});

test('Codex TOML cleanup removes only a managed handler from a mixed hook group', () => {
  const source = [
    '[[hooks.Stop]]',
    'matcher = "always"',
    '',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "node lifecycle-hook.js --fuli-lifecycle --event Stop"',
    '',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "notify-me"',
    'timeout = 5',
    ''
  ].join('\n');

  const cleaned = withoutCodexTomlLifecycleHooks(source);
  assert.match(cleaned, /\[\[hooks\.Stop]]/);
  assert.match(cleaned, /command = "notify-me"/);
  assert.doesNotMatch(cleaned, /--fuli-lifecycle|lifecycle-hook\.js/);
});
