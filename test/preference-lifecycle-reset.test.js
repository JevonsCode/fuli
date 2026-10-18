import assert from 'node:assert/strict';
import test from 'node:test';
import { codexLifecycleOutput } from '../src/agents/codex/lifecycle-hook.js';
import { claudeLifecycleOutput } from '../src/agents/claude-code/lifecycle-hook.js';
import { withCodexLifecycleHooks, withCodexTomlLifecycleHooks, withoutCodexLifecycleHooks } from '../src/agents/codex/lifecycle-hooks.js';
import { connectClaudeCode } from '../src/setup/claude-code-config.js';

const session = '019fc6ed-02a5-7832-8821-68e3b03e7cef';
const input = { session_id: session, transcript_path: '/synthetic/native.jsonl', source: 'compact' };
const context = { nodePath: '/synthetic/node', mcpServerPath: '/synthetic/src/mcp-server.js',
  runtimeConfigPath: '/synthetic/runtime.json' };

test('both native lifecycle adapters restore full current preferences for the existing token after compact/resume', async () => {
  for (const [adapter, source] of [[codexLifecycleOutput, 'codex'], [claudeLifecycleOutput, 'claude_code']]) {
    for (const reason of ['compact', 'resume']) {
      const calls = [];
      const task = { token: 'fuli-task-original-owned', sessionId: session, sourceApplication: source, checkpoint: null };
      const delivery = { reset: async origin => calls.push(['reset', origin]),
        deliver: async (value, origin, format) => { assert.equal(origin.forceFull, true); return format(value); } };
      const output = await adapter('SessionStart', { ...input, source: reason }, async (name, parameters) => {
        calls.push([name, parameters]);
        assert.equal(name, 'read_task_preferences');
        assert.equal(parameters.taskContextToken, task.token);
        assert.equal(parameters.sourceSessionId, session);
        assert.equal(parameters.sourceSessionVerified, true);
        return { taskContextToken: task.token, task_context_token: task.token, checkpoint_required: true,
          effective_preferences: [{ preference_key: 'changed-rule', preference_scope: 'global', instruction: 'Current full instruction' }],
          context: { project_agent_id: 'same-owner' }, agent_receipt: { required: true, markdown: 'Same owner' },
          preferences_complete: true, preference_delivery: { status: 'complete' } };
      }, { delivery, currentTask: async (id, app) => { assert.equal(id, session); assert.equal(app, source); return task; } });
      assert.equal(calls[0][0], 'reset');
      assert.deepEqual(calls.map(call => call[0]), ['reset', 'read_task_preferences']);
      const restored = JSON.parse(output.hookSpecificOutput.additionalContext.split('\n').at(-1));
      assert.equal(restored.taskContextToken, task.token);
      assert.equal(restored.effective_preferences[0].instruction, 'Current full instruction');
      assert.equal(restored.preference_delivery.status, 'complete');
    }
  }
});

test('clear/startup/PreCompact invalidate evidence without importing old context or creating a task', async () => {
  for (const adapter of [codexLifecycleOutput, claudeLifecycleOutput]) {
    let resets = 0;
    const deps = { delivery: { reset: async () => { resets++; } }, currentTask: () => { throw new Error('No old task read on clear'); } };
    const invoke = () => { throw new Error('No task entry/checkpoint on reset'); };
    for (const source of ['startup', 'clear']) assert.deepEqual(await adapter('SessionStart', { ...input, source }, invoke, deps), {});
    assert.deepEqual(await adapter('PreCompact', input, invoke, deps), {});
    assert.equal(resets, 3);
  }
});

test('reset recovery never selects another owner or restores a completed task', async () => {
  const invoke = () => { throw new Error('No entry or read for completed tasks'); };
  assert.deepEqual(await codexLifecycleOutput('SessionStart', input, invoke, {
    currentTask: async () => ({ checkpoint: { phase: 'complete' } }) }), {});
  await assert.rejects(codexLifecycleOutput('SessionStart', input, invoke, {
    currentTask: async () => ({ token: 'foreign', sessionId: 'another-session', sourceApplication: 'codex' })
  }), /same owned native task/);
});

test('managed command hook definitions add generation reset events and preserve other hooks without changing trust', () => {
  const unrelated = { hooks: [{ type: 'command', command: 'echo user-hook' }] };
  const initial = { hooks: { SessionStart: [unrelated] } };
  const next = withCodexLifecycleHooks(initial, { context });
  assert.deepEqual(next.hooks.SessionStart[0], unrelated);
  assert.match(next.hooks.SessionStart[1].hooks[0].command, /SessionStart/);
  assert.match(next.hooks.PreCompact[0].hooks[0].command, /PreCompact/);
  assert.deepEqual(withoutCodexLifecycleHooks(next), initial);
  assert.equal(withCodexLifecycleHooks(next, { context }).hooks.SessionStart.length, 2);
  const toml = withCodexTomlLifecycleHooks('', { context });
  assert.match(toml, /\[\[hooks\.SessionStart\]\]/);
  assert.match(toml, /\[\[hooks\.PreCompact\]\]/);
  const writes = new Map();
  connectClaudeCode({ id: 'claude', configPath: 'config', settingsPath: 'settings' }, context,
    { readConfig: path => path === 'settings' ? initial : {}, writeConfig: (path, value) => writes.set(path, value) });
  const claude = writes.get('settings');
  assert.deepEqual(claude.hooks.SessionStart[0], unrelated);
  assert.match(claude.hooks.SessionStart[1].hooks[0].command, /SessionStart/);
  assert.match(claude.hooks.PreCompact[0].hooks[0].command, /PreCompact/);
  assert.equal(claude.trusted, undefined);
});
