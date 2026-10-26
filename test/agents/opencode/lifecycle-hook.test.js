// The FULI side of the OpenCode plugin (rec#11 D-63): the lifecycle hook the
// plugin starts for a prompt and for a successful execution. Synthetic only:
// temporary directories and a recording Provider double. No FULI data
// directory, port-2727 service, OpenCode configuration or client is used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { callAgentTool } from '../../../src/agent-tools.js';
import { openCodeLifecycleOutput, runOpenCodeLifecycleCommand, runOpenCodeLifecycleHook }
  from '../../../src/agents/opencode/lifecycle-hook.js';
import { AUTO_CLOSE_SUMMARY } from '../../../src/conversations/stop-auto-close.js';
import { finishTask, fixture, openCodeEntry } from '../../fixtures/capture-project-fixture.js';

const SESSION = 'synthetic-opencode-session';
const leases = () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => {} });

function hook(f, event, input, calls = []) {
  return runOpenCodeLifecycleHook(['--event', event], { readInput: async () => input,
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases, callTool: (app, name, parameters, request) => {
      calls.push([name, parameters]);
      return callAgentTool(app, name, parameters, request);
    } });
}

test('a prompt begins the task as `opencode` with the OpenCode session and returns its entry as system text', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const output = await hook(f, 'prompt', { session_id: SESSION, message_id: 'synthetic-message', cwd: f.dirs.novel,
    prompt: 'Outline chapter four.' }, calls);
  assert.deepEqual(Object.keys(output), ['context']);
  const [[name, entry]] = calls;
  assert.equal(name, 'begin_task_context');
  assert.deepEqual({ ...entry }, { sessionId: SESSION, turnId: 'synthetic-message', projectPath: f.dirs.novel,
    taskPrompt: 'Outline chapter four.', sourceApplication: 'opencode', sourceSessionId: SESSION, ...entry.workKind ? { workKind: entry.workKind } : {} });
  const token = /"taskContextToken":"(fuli-task-[^"]+)"/.exec(output.context)?.[1];
  assert.ok(token, 'the entry carries its task token');
  const task = f.app.taskContextRegistry.context(token, 'opencode');
  assert.equal(task.sessionId, SESSION);
  assert.equal(task.turnId, 'synthetic-message', 'the OpenCode message id is the turn');
});

test('the entry label tells the model the stop closes a hook task and to pass its token', async () => {
  const output = await openCodeLifecycleOutput('prompt', { session_id: SESSION, cwd: '/synthetic/novel', prompt: 'Outline.' },
    async () => ({ taskContextToken: 'fuli-task-synthetic', checkpoint_required: false, checkpoint_guidance: 'reported' }));
  assert.match(output.context, /^Fuli task context \(OpenCode plugin\)\. Apply effective_preferences\. The Stop hook closes this task\./);
  assert.match(output.context, /Pass taskContextToken to every FULI call\./);
});

test('a successful execution closes the hook-delivered task honestly, as a Stop hook does', async () => {
  const calls = [];
  const output = await openCodeLifecycleOutput('stop', { session_id: SESSION }, async (name, input) => {
    calls.push([name, input]);
    return name === 'verify_task_checkpoint'
      ? { decision: 'block', entry_via: 'hook', task_context_token: 'fuli-task-synthetic', reason: 'FULI_CHECKPOINT_REQUIRED' }
      : { status: 'checkpointed' };
  });
  assert.deepEqual(output, {});
  assert.deepEqual(calls.map(([name]) => name), ['verify_task_checkpoint', 'checkpoint_task_knowledge']);
  assert.deepEqual(calls[0][1], { sessionId: SESSION, sourceApplication: 'opencode', sourceSessionId: SESSION });
  assert.equal(calls[1][1].taskContextToken, 'fuli-task-synthetic');
  assert.equal(calls[1][1].disposition, 'retain_nothing');
  assert.deepEqual(calls[1][1].workLog, { status: 'reported', summary: AUTO_CLOSE_SUMMARY });
});

test('the stop of a session with a checkpointed task writes nothing', async (t) => {
  const f = await fixture(t);
  const entry = await openCodeEntry(f, f.dirs.novel, { session: SESSION });
  await finishTask(f, entry.context, 'opencode');
  const calls = [];
  assert.deepEqual(await hook(f, 'stop', { session_id: SESSION }, calls), {});
  assert.deepEqual(calls.map(([name]) => name), ['verify_task_checkpoint']);
});

test('the person\'s FULI command line is answered for the model to relay, and an off session gets no entry', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const stopped = await hook(f, 'prompt', { session_id: SESSION, cwd: f.dirs.novel, prompt: 'fuli stop' }, calls);
  assert.match(stopped.context, /^The person's message is a FULI session command; FULI already applied it and answered: "FULI: /);
  const next = await hook(f, 'prompt', { session_id: SESSION, cwd: f.dirs.novel, prompt: 'Outline chapter four.' }, calls);
  assert.match(next.context, /^FULI is stopped for this session by the person\./);
  assert.deepEqual(calls, [], 'no task entry');
});

test('a hook with no session identifier is refused, never guessed', async (t) => {
  const f = await fixture(t);
  await assert.rejects(hook(f, 'prompt', { cwd: f.dirs.novel, prompt: 'x' }), /host session identifier/);
});

test('the process entry fails open within its deadline with one line and no task', async () => {
  const lines = [];
  const started = Date.now();
  const result = await runOpenCodeLifecycleCommand(['--event', 'prompt', '--timeout-ms', '200'], {
    readInput: async () => ({ session_id: SESSION, cwd: '/synthetic', prompt: 'x' }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: '/synthetic/graph-runtime.json' }),
    openApplication: () => ({ close: async () => {} }),
    createLeases: () => ({ withGraphLease: () => new Promise(() => {}), close: async () => {} }),
    write: (line) => lines.push(line)
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 2000);
  assert.equal(lines.length, 1);
  const { context } = JSON.parse(lines[0]);
  assert.match(context, /^Fuli context is unavailable \(no answer within 200 ms\)\. Continue with the user request;/);
  assert.match(context, /entry_incomplete=/);
});

test('the hook process exits right after its answer, so a detached close never lingers', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'p63-opencode-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const started = Date.now();
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../src/agents/opencode/lifecycle-hook.js', import.meta.url)),
    '--fuli-opencode-lifecycle', '--runtime-config', join(directory, 'missing-graph-runtime.json'), '--event', 'stop',
    '--timeout-ms', '5000'], { input: JSON.stringify({ session_id: SESSION }), encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{}\n');
  assert.ok(Date.now() - started < 15_000);
});

test('a broken hook answers the prompt with one line and the stop with nothing', async () => {
  for (const [event, expected] of [['prompt', /^Fuli context is unavailable \(the hook failed\)/], ['stop', null]]) {
    const lines = [];
    await runOpenCodeLifecycleCommand(['--event', event], {
      readInput: async () => ({ session_id: SESSION, cwd: '/synthetic', prompt: 'x' }),
      resolveRuntimeOptions: () => ({ runtimeConfigPath: '/synthetic/graph-runtime.json' }),
      openApplication: () => { throw new Error('/private/path is down'); }, write: (line) => lines.push(line) });
    const output = JSON.parse(lines[0]);
    if (expected) assert.match(output.context, expected);
    else assert.deepEqual(output, {});
    assert.doesNotMatch(lines[0], /private/, 'no exception text or path is printed');
  }
});
