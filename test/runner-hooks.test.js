import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { RUNNER_HOOK_CONTEXT, runnerSessionStartContext } from '../src/runner/runner-mode.js';

// The installed hooks on a runner (docs/runner.md): a data directory with a
// runner store and no graph runtime. Each hook loads nothing, contacts nothing,
// leaves the folder as it was and tells the model at a prompt to enter the
// task through FULI's MCP server, as the OpenCode and DeepSeek plugin hook does.
function runnerDataDirectory(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-runner-hooks-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, 'runner'));
  writeFileSync(join(dataDir, 'runner', 'runner.sqlite'), '');
  return { dataDir, runtimeConfigPath: join(dataDir, 'graph-runtime.json') };
}

function runHook(entry, args, stdin) {
  const child = spawn(process.execPath, [resolve(entry), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stdin.end(stdin);
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', (exitCode) => done({ stdout, exitCode }));
  });
}

const PROMPT = JSON.stringify({ session_id: 'synthetic-session', prompt: 'synthetic request', hook_event_name: 'UserPromptSubmit' });

for (const [client, entry, marker] of [['Claude Code', 'src/agents/claude-code/lifecycle-hook.js', '--fuli-claude-lifecycle'],
  ['Codex', 'src/agents/codex/lifecycle-hook.js', '--fuli-lifecycle']]) {
  test(`on a runner the ${client} hook loads nothing and at a prompt names get_collaboration_preferences`, async (t) => {
    const { dataDir, runtimeConfigPath } = runnerDataDirectory(t);
    const args = (event) => [marker, '--runtime-config', runtimeConfigPath, '--event', event];
    const prompt = await runHook(entry, args('UserPromptSubmit'), PROMPT);
    const stop = await runHook(entry, args('Stop'), JSON.stringify({ session_id: 'synthetic-session' }));

    assert.equal(prompt.exitCode, 0);
    assert.deepEqual(JSON.parse(prompt.stdout), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
      additionalContext: RUNNER_HOOK_CONTEXT } });
    assert.match(RUNNER_HOOK_CONTEXT, /get_collaboration_preferences/);
    assert.deepEqual([stop.exitCode, stop.stdout], [0, '']);
    assert.deepEqual(readdirSync(dataDir).sort(), ['runner'], 'nothing was written beside the runner store');
  });
}

test('on a runner Cursor\'s hook loads nothing, lets the prompt through and names its session at session start', async (t) => {
  const { dataDir, runtimeConfigPath } = runnerDataDirectory(t);
  const run = (event) => runHook('src/agents/cursor/lifecycle-hook.js', ['--runtime-config', runtimeConfigPath, '--event', event],
    JSON.stringify({ conversation_id: 'synthetic-session', prompt: 'synthetic request' }));
  const [start, prompt, stop] = [await run('sessionStart'), await run('beforeSubmitPrompt'), await run('stop')];

  // Cursor gives its MCP server no session: without it named here, an entry gets no task token,
  // and no call that needs one (resume_agent_conversation) can follow.
  assert.deepEqual(JSON.parse(start.stdout), { additional_context: runnerSessionStartContext('synthetic-session') });
  assert.match(JSON.parse(start.stdout).additional_context,
    /get_collaboration_preferences with sessionId="synthetic-session", projectPath=current directory/);
  assert.match(JSON.parse(start.stdout).additional_context, /resume_agent_conversation/);
  assert.deepEqual(JSON.parse(prompt.stdout), { continue: true });
  assert.deepEqual(JSON.parse(stop.stdout), {});
  assert.deepEqual([start.exitCode, prompt.exitCode, stop.exitCode], [0, 0, 0]);
  assert.deepEqual(readdirSync(dataDir).sort(), ['runner']);
});
