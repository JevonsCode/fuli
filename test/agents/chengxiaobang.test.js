import assert from 'node:assert/strict';
import test from 'node:test';
import { runChengxiaobangLifecycleCommand } from '../../src/agents/chengxiaobang/lifecycle-hook.js';
import { chengxiaobangHookConfig } from '../../src/agents/chengxiaobang/hook-config.js';
import { fixture } from '../fixtures/capture-project-fixture.js';
import { runConnectCommand } from '../../src/cli/connect-command.js';

const session = 'synthetic-chengxiaobang-session';
async function run(f, event, extra = {}, calls = []) {
  const lines = [];
  await runChengxiaobangLifecycleCommand([], {
    readInput: async () => ({ hook_event_name: event, session_id: session, run_id: 'run-1',
      cwd: f.dirs.novel, prompt: 'Outline chapter four.', ...extra }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }),
    openApplication: () => f.app,
    createLeases: () => ({ withGraphLease: async (_, operation) => operation(), close: async () => {} }),
    callTool: (app, name, input, request) => {
      calls.push([name, input]);
      if (name === 'begin_task_context') {
        f.pending = true;
        return { taskContextToken: 'fuli-task-synthetic', checkpoint_required: false };
      }
      if (name === 'verify_task_checkpoint') return f.pending
        ? { decision: 'block', entry_via: 'hook', task_context_token: 'fuli-task-synthetic' } : {};
      if (name === 'checkpoint_task_knowledge') { f.pending = false; return { status: 'checkpointed' }; }
      assert.fail(`unexpected tool ${name}`);
    },
    write: line => lines.push(JSON.parse(line))
  });
  assert.equal(lines.length, 1);
  return lines[0];
}

test('native prompt injects context and Stop closes that same task; repeated Stop is harmless', async t => {
  const f = await fixture(t);
  const calls = [];
  const entry = await run(f, 'UserPromptSubmit', {}, calls);
  assert.deepEqual(Object.keys(entry), ['additionalContext']);
  assert.match(entry.additionalContext, /Fuli task context \(Chengxiaobang plugin\)/);
  assert.match(entry.additionalContext, /Pass taskContextToken/);
  assert.equal(calls[0][1].sourceApplication, 'other');
  assert.equal(calls[0][1].sessionId, session);
  assert.equal(calls[0][1].turnId, 'run-1');
  assert.deepEqual(await run(f, 'Stop', {}, calls), {});
  assert.ok(calls.some(([name]) => name === 'checkpoint_task_knowledge'));
  calls.length = 0;
  await run(f, 'Stop', { stop_hook_active: true }, calls);
  assert.deepEqual(calls.map(([name]) => name), ['verify_task_checkpoint']);
});

test('child and unrelated events cannot begin or close the parent task', async () => {
  for (const input of [{ hook_event_name: 'Stop', subagent: true },
    { hook_event_name: 'UserPromptSubmit', subagent: true }, { hook_event_name: 'SessionStart' }]) {
    const lines = [];
    await runChengxiaobangLifecycleCommand([], { readInput: async () => input,
      openApplication: () => assert.fail('must not open Fuli'), write: line => lines.push(JSON.parse(line)) });
    assert.deepEqual(lines, [{}]);
  }
});

test('missing host session fails open with a visible notice, not a fabricated identity', async t => {
  const f = await fixture(t);
  const calls = [];
  const result = await run(f, 'UserPromptSubmit', { session_id: undefined }, calls);
  assert.match(result.additionalContext, /unavailable/);
  assert.deepEqual(calls, []);
});

test('connection format prints mergeable hooks with absolute, quoted paths', () => {
  const config = chengxiaobangHookConfig({ nodePath: '/node path/node',
    mcpServerPath: '/fuli path/src/mcp-server.js', runtimeConfigPath: '/data path/runtime.json' });
  assert.deepEqual(config.hooks.map(h => h.event), ['UserPromptSubmit', 'Stop']);
  for (const hook of config.hooks) {
    assert.equal(hook.enabled, true);
    assert.equal(hook.timeoutSeconds, 20);
    assert.match(hook.command, /lifecycle-hook.js/);
    assert.match(hook.command, /['"]\/data path\/runtime.json['"]/);
  }
  let printed;
  const result = runConnectCommand(['--format', 'chengxiaobang-hooks', '--runtime-config', '/synthetic/runtime.json'],
    { write: text => { printed = JSON.parse(text); } });
  assert.deepEqual(printed, result);
  assert.throws(() => runConnectCommand(['--format', 'chengxiaobang-hooks', '--source-application', 'codex']), /omit MCP/);
});
