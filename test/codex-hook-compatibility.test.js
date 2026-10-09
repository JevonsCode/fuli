// Synthetic regression fixtures. Live Provider verification is reported separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-hook.js';
import { runCursorLifecycleHook } from '../src/agents/cursor/lifecycle-hook.js';
import { withTranscriptGuard, transcriptDigest } from '../src/conversations/transcript-guard.js';
import { syncConversationTranscript } from '../src/conversations/sync-transcript.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';

const missing = () => new ProviderRequestError('Not Found', {
  status: 404, code: 'provider_error',
  diagnostic: { category: 'provider_error', status: 404, detail: 'Not Found' }
});
const transient = (code = 'provider_unavailable', status = 0) => new ProviderRequestError('Synthetic outage', { code, status });

async function fixture(t, currentTaskContext, conversation = async () => { throw Error('Unexpected conversation request'); }) {
  const directory = await mkdtemp(join(tmpdir(), 'jvs-a-hook-compat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeConfigPath = join(directory, 'runtime.json');
  const input = { session_id: randomUUID(), cwd: directory, prompt: 'synthetic retry', transcript_path: join(directory, 'missing.jsonl') };
  const calls = [], lookups = [];
  let closed = 0;
  const app = {
    config: { personal: { spaceId: 'synthetic-space' } }, getCapturePolicy: () => ({ enabled: true }),
    personal: {
      currentTaskContext: async (...args) => { lookups.push(args); return currentTaskContext(...args); },
      conversation
    }, close: async () => { closed++; }
  };
  const dependencies = {
    readInput: async () => input,
    resolveRuntimeOptions: () => ({ runtimeConfigPath }), openApplication: () => app,
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => { closed++; } }),
    callTool: async (_app, name) => { calls.push(name); return { taskContextToken: 'synthetic-task', effective_preferences: [], conversation: { status: 'unassigned' } }; },
    write: () => {}
  };
  const run = (event = 'UserPromptSubmit') => runCodexLifecycleHook(['--event', event], dependencies);
  return { directory, runtimeConfigPath, input, app, dependencies, run, calls, lookups, closed: () => closed };
}

test('first missing endpoint permits Codex submission without context, task entry or history writes', async t => {
  const f = await fixture(t, async () => { throw missing(); });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.run();
    assert.notEqual(result.decision, 'block');
    assert.match(result.systemMessage, /provider.*version|not available/i);
    assert.equal(result.hookSpecificOutput, undefined);
  }
  assert.equal(f.lookups.length, 2, 'A route absence is not a transient retry');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(join(f.directory, 'transcript-guards')), []);
  assert.equal(f.closed(), 4);
});

test('shared synchronization still reports a missing endpoint as entry blocked', async t => {
  const f = await fixture(t, async () => { throw missing(); });
  const result = await syncConversationTranscript(f.app, f.input, 'codex', {});
  assert.equal(result.entryBlocked, true);
  assert.equal(result.code, 'current_task_endpoint_unavailable');
});

for (const [name, error] of [
  ['unauthenticated', new ProviderRequestError('Unauthorized', { status: 401 })],
  ['forbidden', new ProviderRequestError('Forbidden', { status: 403 })],
  ['resource 404', new ProviderRequestError('Task context not found', { status: 404 })],
  ['scope conflict', new ProviderRequestError('Scope conflict', { status: 409 })],
  ['validation failure', new ProviderRequestError('Invalid scope', { status: 422 })],
  ['malformed provider JSON', new ProviderRequestError('Invalid JSON', { code: 'provider_invalid_response' })],
  ['unknown parser failure', new SyntaxError('Synthetic parse failure')],
  ['untyped error with misleading properties', Object.assign(new Error('Not Found'), { status: 404, code: 'provider_error', diagnostic: { detail: 'Not Found' } })]
]) test(`${name} skips Fuli context without intercepting submission or writing tasks`, async t => {
  const f = await fixture(t, async () => { throw error; });
  const output = await f.run();
  assert.notEqual(output.decision, 'block');
  assert.equal(output.hookSpecificOutput, undefined);
  assert.equal(f.lookups.length, 1);
  assert.deepEqual(f.calls, []);
});

for (const [code, status] of [['provider_unavailable', 0], ['provider_timeout', 504],
  ['provider_http_5xx', 502], ['provider_http_5xx', 503], ['provider_http_5xx', 504]]) {
  test(`${code} ${status} retries only the first read and recovers normal task entry`, async t => {
    let attempts = 0;
    const f = await fixture(t, async () => { if (++attempts === 1) throw transient(code, status); return null; });
    assert.notEqual((await f.run()).decision, 'block');
    assert.equal(f.lookups.length, 3, 'Two initial attempts, followed by the normal post-entry boundary lookup');
    assert.deepEqual(f.calls, ['begin_task_context']);
    assert.equal(f.lookups[0][1]?.timeoutMs, 1500);
    assert.equal(f.lookups[1][1]?.timeoutMs, 1500);
    assert.equal(f.lookups[2][1], undefined, 'Boundary claims retain their own verification path');
  });
}

test('exhausted first-read retries permit native submission with no task or Agent context', async t => {
  const f = await fixture(t, async () => { throw transient(); });
  const result = await f.run();
  assert.notEqual(result.decision, 'block');
  assert.match(result.systemMessage, /temporarily unavailable|retry/i);
  assert.equal(result.hookSpecificOutput, undefined);
  assert.equal(f.lookups.length, 2);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(join(f.directory, 'transcript-guards')), []);
});

for (const phase of ['scan', 'ready', 'beginning', 'claim']) test(`an existing ${phase} guard cannot be bypassed by the missing endpoint`, async t => {
  const f = await fixture(t, async () => { throw missing(); });
  const state = { version: 1, phase, owner: transcriptDigest('old-owner'), prompt: transcriptDigest(f.input.prompt), scanCursor: 0, boundary: 0 };
  await withTranscriptGuard(f.runtimeConfigPath, f.input, 'codex', true, guard => guard.write(state));
  const output = await f.run();
  assert.notEqual(output.decision, 'block');
  assert.equal(output.hookSpecificOutput, undefined);
  assert.deepEqual(f.calls, []);
  await withTranscriptGuard(f.runtimeConfigPath, f.input, 'codex', true, guard => assert.deepEqual(guard.value, state));
});

test('an exhausted transient read cannot bypass a pending guard', async t => {
  const f = await fixture(t, async () => { throw transient(); });
  const state = { version: 1, phase: 'scan', owner: transcriptDigest('old-owner'), prompt: transcriptDigest(f.input.prompt), scanCursor: 0 };
  await withTranscriptGuard(f.runtimeConfigPath, f.input, 'codex', true, guard => guard.write(state));
  const output = await f.run();
  assert.notEqual(output.decision, 'block');
  assert.equal(output.hookSpecificOutput, undefined);
  assert.deepEqual(f.calls, []);
  await withTranscriptGuard(f.runtimeConfigPath, f.input, 'codex', true, guard => assert.deepEqual(guard.value, state));
});

test('later policy route 404 stays blocked', async t => {
  const f = await fixture(t, async () => ({ token: 'task', project_agent_id: 'agent', personal_project_id: 'project' }), async () => { throw missing(); });
  const output = await f.run();
  assert.notEqual(output.decision, 'block');
  assert.equal(output.hookSpecificOutput, undefined);
  assert.deepEqual(f.calls, []);
  assert.equal(f.lookups.length, 1);
});

for (const task of [{}, [], 'invalid', { token: 'synthetic-task', project_agent_id: 'agent' }]) {
  test(`malformed current context ${JSON.stringify(task)} is blocked before task entry`, async t => {
    const f = await fixture(t, async () => task);
    const output = await f.run();
  assert.notEqual(output.decision, 'block');
  assert.equal(output.hookSpecificOutput, undefined);
    assert.deepEqual(f.calls, []);
  });
}

test('a current context returned for another host session is blocked before restoration', async t => {
  const f = await fixture(t, async () => ({ token: 'synthetic-task', personal_project_id: 'project', project_agent_id: 'agent',
    source_application: 'codex', session_id: 'foreign-session' }));
  const output = await f.run();
  assert.notEqual(output.decision, 'block');
  assert.equal(output.hookSpecificOutput, undefined);
  assert.deepEqual(f.calls, []);
});

test('healthy unassigned task entry still obtains the normal context', async t => {
  const f = await fixture(t, async () => null);
  const result = await f.run();
  assert.notEqual(result.decision, 'block');
  assert.deepEqual(f.calls, ['begin_task_context']);
  assert.ok(result.hookSpecificOutput);
});

for (const [source, run, event] of [['claude_code', runClaudeLifecycleHook, 'UserPromptSubmit']]) {
  test(`${source} permits submission without Fuli context on the missing endpoint`, async t => {
    const f = await fixture(t, async () => { throw missing(); });
    f.dependencies.readInput = async () => ({ ...f.input, conversation_id: f.input.session_id, workspace_roots: [f.input.cwd] });
    const result = await run(['--event', event], f.dependencies);
    assert.notEqual(result.decision, 'block');
    assert.notEqual(result.continue, false);
    assert.equal(result.hookSpecificOutput, undefined);
    assert.deepEqual(f.calls, []);
  });
}

test('Cursor retains its existing task-entry behavior and does not acquire a transcript bypass', async t => {
  const f = await fixture(t, async () => { throw missing(); });
  f.dependencies.readInput = async () => ({ ...f.input, conversation_id: f.input.session_id, workspace_roots: [f.input.cwd] });
  assert.deepEqual(await runCursorLifecycleHook(['--event', 'beforeSubmitPrompt'], f.dependencies), { continue: true });
  assert.deepEqual(f.calls, ['begin_task_context']);
  assert.equal(f.lookups.length, 0, 'Cursor currently has no transcript lookup in its entry adapter');
});
