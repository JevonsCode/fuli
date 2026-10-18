import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { TRANSCRIPT_GUARD_BUSY } from '../src/conversations/transcript-guard-lock.js';
import { withTranscriptGuard, transcriptDigest } from '../src/conversations/transcript-guard.js';
import { syncConversationTranscript, claimTranscriptBoundary, recordTranscriptTaskEntry } from '../src/conversations/sync-transcript.js';
import { normalizeCodexRecord, verifyCodexTranscript } from '../src/agents/codex/conversation-transcript.js';
import { runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-hook.js';

const adapter = { normalize: normalizeCodexRecord, verify: verifyCodexTranscript };
const header = JSON.stringify({ type: 'session_meta', payload: { id: 'session' } }) + '\n';
const row = (role, text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }) + '\n';
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
});
// The loopback port the guard used before it switched to a Fuli-owned lock name.
const formerGuardPort = (runtime, sessionId) => {
  const key = transcriptDigest(`${runtime}\0codex\0${sessionId}`);
  const lockKey = transcriptDigest(`${join(dirname(runtime), 'transcript-guards')}\0${key}`);
  return 49152 + (parseInt(lockKey.slice(0, 8), 16) % 16384);
};
async function fixture(t, tail) {
  const dir = await mkdtemp(join(tmpdir(), 'fuli-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'transcript.jsonl');
  await writeFile(path, header + tail);
  const input = { transcript_path: path, session_id: 'session', prompt: 'incoming', cwd: '/synthetic' };
  let cursor = header.length, owner = 'old', task = 'old', failClaim = false, enabled = true, policyEnabled = true;
  const appended = [], calls = [];
  const app = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled }), personal: {
    currentTaskContext: async () => ({ personal_project_id: 'project', project_agent_id: task, token: task }),
    conversation: async (operation, request) => {
      calls.push({ operation, ...request });
      if (request.mode === 'policy') return { enabled: policyEnabled };
      if (request.mode === 'session') return { cursor, initialized: true };
      if (request.expected_cursor !== cursor && !(request.fallback_recovery && request.cursor === cursor)) throw new Error('CAS mismatch');
      if (operation === 'append') {
        if (request.agent_id !== owner) throw new Error('Wrong owner');
        appended.push(...request.events.map(event => ({ ...event, owner })));
        cursor = request.cursor;
        return { status: 'saved' };
      }
      if (operation === 'boundary') {
        if (failClaim) throw new Error('Claim failed');
        if (request.fallback_recovery) cursor = request.cursor;
        owner = request.agent_id; return { status: request.fallback_recovery ? 'saved' : 'bound', cursor };
      }
    }
  } };
  const runtime = join(dir, 'runtime.json');
  const run = callback => withTranscriptGuard(runtime, input, 'codex', true, callback);
  const entries = [];
  const hook = () => runCodexLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => input, write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: runtime }),
    openApplication: () => app,
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation() }),
    callTool: async (_app, name) => { entries.push(name); task = 'new'; return { taskContextToken: 'new' }; }
  });
  return { dir, input, app, run, hook, entries, appended, calls, runtime,
    switchTask: value => { task = value; }, failClaim: value => { failClaim = value; }, disable: () => { enabled = false; }, disablePolicy: () => { policyEnabled = false; } };
}

test('mismatching user text at EOF is not appended to the old owner or treated as a boundary', async t => {
  const f = await fixture(t, row('user', 'incoming with host-added text'));
  const result = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.equal(result.entryBlocked, true);
  assert.equal(f.appended.length, 0);
  await f.run(async guard => {
    assert.equal(guard.value.phase, 'scan');
    const stop = await syncConversationTranscript(f.app, { ...f.input, prompt: undefined }, 'codex', adapter, guard);
    assert.equal(stop.entryBlocked, true);
  });
  assert.equal(f.appended.length, 0);
});

test('complete EOF before the host writes its prompt remains a supported boundary', async t => {
  const f = await fixture(t, row('assistant', 'prior completed answer'));
  const result = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.equal(result.atPromptBoundary, true);
  assert.equal(result.entryBlocked, false);
  assert.deepEqual(f.appended.map(event => event.content), ['prior completed answer']);
});

test('more than eight pages resume across guard reloads without switching the task or losing the tail', async t => {
  const f = await fixture(t, row('user', 'previous task') + Array.from({ length: 950 }, (_, i) => row('assistant', `old-${i}`)).join('') + row('user', 'incoming'));
  const first = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.equal(first.entryBlocked, true);
  assert.equal(f.appended.length, 0);
  let result;
  for (let attempt = 0; attempt < 8; attempt++) {
    result = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
    if (!result.entryBlocked) break;
  }
  assert.equal(result.atPromptBoundary, true);
  assert.equal(result.entryBlocked, false);
  assert.equal(f.appended.length, 951);
  assert.ok(f.appended.every(event => event.owner === 'old' && event.content !== 'incoming'));
  await f.run(async guard => {
    f.switchTask('new');
    await recordTranscriptTaskEntry(guard, { taskContextToken: 'new' });
    f.failClaim(true);
    assert.equal((await claimTranscriptBoundary(f.app, f.input, 'codex', result, adapter, guard)).entryBlocked, true);
  });
  f.failClaim(false);
  await f.run(async guard => {
    await syncConversationTranscript(f.app, { ...f.input, prompt: undefined }, 'codex', adapter, guard);
    assert.equal(guard.value, null);
  });
  assert.deepEqual(f.appended.at(-1), { event_id: f.appended.at(-1).event_id, content: 'incoming', role: 'user', kind: 'message', owner: 'new' });
});

test('stale guard does not bind an unrelated task and disabled capture leaves it untouched', async t => {
  const f = await fixture(t, row('assistant', 'old'));
  await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  f.switchTask('unrelated');
  const result = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.equal(result.entryBlocked, true);
  assert.equal(f.calls.filter(call => call.operation === 'boundary').length, 0);
  f.disable();
  await f.run(async guard => {
    const before = structuredClone(guard.value);
    assert.equal((await syncConversationTranscript(f.app, f.input, 'codex', adapter, guard)).status, 'capture_disabled');
    assert.deepEqual(guard.value, before);
  });
});

function identifyFallback(f, changes = {}) {
  const current = f.app.personal.currentTaskContext;
  f.app.personal.currentTaskContext = async () => ({ ...await current(),
    entry_via: 'tool', session_id: f.input.session_id,
    source_application: 'codex', personal_space_id: 'space', ...changes });
}

for (const phase of ['scan', 'ready', 'beginning', 'claim']) {
  test(`same-session fallback recovers a ${phase} guard without importing the uncertain interval`, async t => {
    const f = await fixture(t, row('user', 'host-decorated task') + row('assistant', 'fallback answer'));
    await f.run(guard => guard.write({ version: 1, phase, owner: transcriptDigest('old'),
      prompt: transcriptDigest('incoming'), scanCursor: header.length,
      boundary: header.length, ...(phase === 'claim' ? { nextOwner: transcriptDigest('interrupted') } : {}) }));
    f.switchTask('fallback'); identifyFallback(f);
    const end = (await stat(f.input.transcript_path)).size;
    const recovered = await f.run(guard => syncConversationTranscript(f.app,
      { ...f.input, prompt: undefined }, 'codex', adapter, guard));
    assert.notEqual(recovered.entryBlocked, true);
    assert.equal(recovered.cursor, end);
    assert.equal(recovered.omitted, true);
    const request = f.calls.find(call => call.fallback_recovery);
    assert.equal(request.task_context_token, 'fallback');
    assert.equal(request.expected_cursor, header.length);
    assert.equal(request.cursor, end);
    assert.deepEqual(request.events ?? [], []);
    assert.deepEqual(f.appended, [], 'Uncertain native text is never submitted as events');
    await f.run(guard => assert.equal(guard.value, null));
    f.input.prompt = 'next task';
    await appendFile(f.input.transcript_path, row('user', 'next task'));
    await f.hook();
    assert.deepEqual(f.entries, ['begin_task_context'], 'The next prompt uses the Hook rather than fallback');
    await appendFile(f.input.transcript_path, row('assistant', 'new verified answer'));
    const saved = await f.run(guard => syncConversationTranscript(f.app,
      { ...f.input, prompt: undefined }, 'codex', adapter, guard));
    assert.notEqual(saved.entryBlocked, true);
    assert.deepEqual(f.appended.map(event => [event.content, event.owner]),
      [['next task', 'new'], ['new verified answer', 'new']]);
  });
}

test('fallback recovery retains a retryable guard after a boundary failure', async t => {
  const f = await fixture(t, row('user', 'uncertain'));
  await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  f.switchTask('fallback'); identifyFallback(f); f.failClaim(true);
  const first = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.equal(first.entryBlocked, true);
  f.failClaim(false);
  const retry = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.notEqual(retry.entryBlocked, true);
  assert.equal(retry.omitted, true);
  await f.run(guard => assert.equal(guard.value, null));
});

test('fallback recovery replays a committed boundary after a lost response', async t => {
  const f = await fixture(t, row('user', 'uncertain'));
  await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  f.switchTask('fallback'); identifyFallback(f);
  const conversation = f.app.personal.conversation;
  let loseResponse = true;
  f.app.personal.conversation = async (operation, request) => {
    const result = await conversation(operation, request);
    if (request.fallback_recovery && loseResponse) { loseResponse = false; throw new Error('Lost response'); }
    return result;
  };
  const first = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.equal(first.entryBlocked, true);
  const retry = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.notEqual(retry.entryBlocked, true);
  const requests = f.calls.filter(call => call.fallback_recovery);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  await f.run(guard => assert.equal(guard.value, null));
});

for (const changes of [{ session_id: 'foreign' }, { source_application: 'other' },
  { personal_space_id: 'foreign' }, { entry_via: 'hook' }, { entry_via: undefined }]) {
  test(`fallback recovery rejects unverifiable native ownership ${JSON.stringify(changes)}`, async t => {
    const f = await fixture(t, row('user', 'uncertain'));
    await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
    f.switchTask('fallback'); identifyFallback(f, changes);
    const result = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
    assert.equal(result.entryBlocked, true);
    assert.equal(f.calls.some(call => call.fallback_recovery), false);
    assert.deepEqual(f.appended, []);
  });
}

test('fallback recovery waits for a complete native tail', async t => {
  const f = await fixture(t, row('user', 'uncertain'));
  await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  await appendFile(f.input.transcript_path, '{"unfinished":');
  f.switchTask('fallback'); identifyFallback(f);
  const result = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.equal(result.entryBlocked, true);
  assert.equal(f.calls.some(call => call.fallback_recovery), false);
});

test('fallback recovery rejects a native file belonging to another session', async t => {
  const f = await fixture(t, row('user', 'uncertain'));
  await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  await writeFile(f.input.transcript_path, JSON.stringify({ type: 'session_meta', payload: { id: 'foreign' } }) + '\n');
  f.switchTask('fallback'); identifyFallback(f);
  const result = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.equal(result.entryBlocked, true);
  assert.equal(f.calls.some(call => call.fallback_recovery), false);
});

test('Claude Code resumes normal Hook task entry after a same-session fallback', async t => {
  const f = await fixture(t, '');
  const native = (role, text) => JSON.stringify({ sessionId: 'session', type: role,
    message: { content: [{ type: 'text', text }] } }) + '\n';
  await writeFile(f.input.transcript_path, native('user', 'unverified prior task') + native('assistant', 'fallback answer'));
  await withTranscriptGuard(f.runtime, f.input, 'claude_code', true, guard => guard.write({
    version: 1, phase: 'scan', owner: transcriptDigest('old'), prompt: transcriptDigest('old prompt'),
    scanCursor: header.length, userMessages: 0, omitted: false }));
  f.switchTask('fallback'); identifyFallback(f, { source_application: 'claude_code' });
  const output = await runClaudeLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => f.input, write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtime }), openApplication: () => f.app,
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation() }),
    callTool: async (_app, name) => { f.entries.push(name); f.switchTask('new'); return { taskContextToken: 'new' }; }
  });
  assert.deepEqual(f.entries, ['begin_task_context']);
  assert.match(output.hookSpecificOutput.additionalContext, /Fuli task context/);
  const recovery = f.calls.find(call => call.fallback_recovery);
  assert.equal(recovery.source_application, 'claude_code');
  assert.deepEqual(f.appended, []);
});

test('guard serializes same-session hooks and persists only hashes and cursors with private permissions', async t => {
  const f = await fixture(t, '');
  await f.run(async guard => {
    await assert.rejects(f.run(async () => { assert.fail('Concurrent hook entered'); }), { code: TRANSCRIPT_GUARD_BUSY });
    await guard.write({ version: 1, phase: 'scan', owner: transcriptDigest('old'), prompt: transcriptDigest('incoming'), scanCursor: header.length, userMessages: 0, omitted: false });
  });
  const directory = join(f.dir, 'transcript-guards');
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const path = join(directory, files[0]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const data = await readFile(path, 'utf8');
  assert.ok(!data.includes('incoming') && !data.includes(f.input.transcript_path));
  await f.run(async guard => { assert.equal(guard.value.scanCursor, header.length); });
});

test('an unrelated listener on the former hashed loopback port does not block the guard or task entry', async t => {
  const f = await fixture(t, row('assistant', 'prior completed answer'));
  const blocker = createServer();
  t.after(() => new Promise(resolve => blocker.close(() => resolve())));
  try { await listen(blocker, formerGuardPort(f.runtime, f.input.session_id)); } catch (error) {
    // Something else already owns the port, which is the same foreign-holder case.
    if (error.code !== 'EADDRINUSE') throw error;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await f.hook();
    assert.notEqual(result.decision, 'block');
    assert.doesNotMatch(result.systemMessage ?? '', /another Fuli hook|lock/i);
  }
  assert.deepEqual(f.entries, ['begin_task_context', 'begin_task_context', 'begin_task_context']);
});

test('a same-session hook reports a held guard as another Fuli hook and does not begin a task', async t => {
  const f = await fixture(t, row('assistant', 'prior completed answer'));
  await f.run(async () => {
    const result = await f.hook();
    assert.notEqual(result.decision, 'block');
    assert.match(result.systemMessage, /Another Fuli hook for this host session is still running/);
    assert.equal(result.hookSpecificOutput, undefined);
  });
  assert.deepEqual(f.entries, []);
  assert.deepEqual(f.appended, []);
  const result = await f.hook();
  assert.doesNotMatch(result.systemMessage ?? '', /Another Fuli hook/);
  assert.deepEqual(f.entries, ['begin_task_context']);
});

test('guards for different sessions do not contend', async t => {
  const f = await fixture(t, '');
  await f.run(async () => {
    await withTranscriptGuard(f.runtime, { ...f.input, session_id: 'other-session' }, 'codex', true, async () => {});
  });
});

test('lifecycle skips unverified context without intercepting the native prompt', async t => {
  const f = await fixture(t, row('user', 'different'));
  let invoked = false;
  const result = await runCodexLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => f.input, write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtime }),
    openApplication: () => f.app,
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation() }),
    callTool: async () => { invoked = true; return {}; }
  });
  assert.notEqual(result.decision, 'block');
  assert.equal(result.hookSpecificOutput, undefined);
  assert.equal(invoked, false);
});


test('a later exact retry quarantines the earlier ambiguous user record instead of assigning it to the old Agent', async t => {
  const f = await fixture(t, row('assistant', 'safe old answer') + row('user', 'incoming decorated by host'));
  await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  await appendFile(f.input.transcript_path, row('user', 'incoming'));
  const result = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.equal(result.atPromptBoundary, true);
  assert.ok(!f.appended.some(event => event.content === 'incoming decorated by host'));
  assert.ok(f.appended.some(event => /omitted.*ambiguous/i.test(event.content)));
});


test('a killed hook leaves resumable state and its OS lock is released on process exit', async t => {
  const f = await fixture(t, '');
  const moduleUrl = new URL('../src/conversations/transcript-guard.js', import.meta.url).href;
  const script = `const { withTranscriptGuard, transcriptDigest } = await import(process.argv[1]);
    await withTranscriptGuard(process.argv[2], JSON.parse(process.argv[3]), 'codex', true, async guard => {
      await guard.write({ version: 1, phase: 'scan', owner: transcriptDigest('old'), prompt: transcriptDigest('incoming'), scanCursor: 123, userMessages: 0, omitted: false });
      process.exit(0);
    });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, f.runtime, JSON.stringify(f.input)], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  await f.run(async guard => { assert.equal(guard.value.scanCursor, 123); });
});

test('a hook process killed while holding the guard serializes other processes until the OS releases it', async t => {
  const f = await fixture(t, '');
  const moduleUrl = new URL('../src/conversations/transcript-guard.js', import.meta.url).href;
  const script = `const { withTranscriptGuard, transcriptDigest } = await import(process.argv[1]);
    await withTranscriptGuard(process.argv[2], JSON.parse(process.argv[3]), 'codex', true, async guard => {
      await guard.write({ version: 1, phase: 'scan', owner: transcriptDigest('old'), prompt: transcriptDigest('incoming'), scanCursor: 456, userMessages: 0, omitted: false });
      process.stdout.write('held');
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleUrl, f.runtime, JSON.stringify(f.input)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('held')) resolve(); });
    child.once('exit', code => reject(new Error(`Guard holder exited early (${code}): ${stderr}`)));
  });
  await assert.rejects(f.run(async () => { assert.fail('Entered while another process held the guard'); }), { code: TRANSCRIPT_GUARD_BUSY });
  assert.match((await f.hook()).systemMessage, /Another Fuli hook/);
  assert.deepEqual(f.entries, []);
  child.kill('SIGKILL');
  await exited;
  await f.run(async guard => { assert.equal(guard.value.scanCursor, 456); });
});

test('an interrupted begin without a recorded new token never guesses the current owner', async t => {
  const f = await fixture(t, '');
  await f.run(async guard => {
    await guard.write({ version: 1, phase: 'beginning', owner: transcriptDigest('old'), prompt: transcriptDigest('incoming'), scanCursor: header.length, boundary: header.length });
  });
  const result = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.equal(result.entryBlocked, true);
  assert.match(result.reason, /new host session/);
  assert.equal(f.calls.filter(call => ['append', 'boundary'].includes(call.operation)).length, 0);
});

test('a repeated prompt in old backlog does not select the previous turn boundary', async t => {
  const f = await fixture(t, row('user', 'incoming') + row('assistant', 'previous answer') + row('user', 'incoming'));
  const result = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.equal(result.atPromptBoundary, true);
  assert.deepEqual(f.appended.map(event => event.content), ['incoming', 'previous answer']);
});


test('disabled conversation policy does not mutate a pending guard while starting a task', async t => {
  const f = await fixture(t, '');
  await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  let before;
  await f.run(async guard => { before = structuredClone(guard.value); });
  f.disablePolicy();
  let invoked = false;
  const result = await runCodexLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => f.input, write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtime }),
    openApplication: () => f.app,
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation() }),
    callTool: async () => { invoked = true; f.switchTask('new'); return { taskContextToken: 'new' }; }
  });
  assert.equal(invoked, true);
  assert.notEqual(result.decision, 'block');
  await f.run(async guard => { assert.deepEqual(guard.value, before); });
});

test('native system and metadata after the current prompt do not invalidate its visible boundary', async t => {
  const f = await fixture(t, row('assistant', 'old answer') + row('user', 'incoming') + row('system', 'host context') + JSON.stringify({ type: 'turn_context', payload: { mode: 'synthetic' } }) + '\n');
  const result = await f.run(guard => syncConversationTranscript(f.app, f.input, 'codex', adapter, guard));
  assert.equal(result.atPromptBoundary, true);
  assert.deepEqual(f.appended.map(event => event.content), ['old answer']);
});

test('an append failure after a committed page reports partial capture and keeps its cursor', async t => {
  const f = await fixture(t, Array.from({ length: 60 }, (_, i) => row('assistant', `line-${i}`)).join(''));
  const conversation = f.app.personal.conversation;
  let writes = 0;
  f.app.personal.conversation = async (operation, request) => {
    if (operation === 'append' && ++writes === 2) throw new Error('Transient write failure');
    return conversation(operation, request);
  };
  const result = await f.run(guard => syncConversationTranscript(f.app, { ...f.input, prompt: undefined }, 'codex', adapter, guard));
  assert.equal(result.status, 'partial');
  assert.match(result.reason, /pages were saved/);
  assert.equal(f.appended.length, 50);
  f.app.personal.conversation = conversation;
  await f.run(guard => syncConversationTranscript(f.app, { ...f.input, prompt: undefined }, 'codex', adapter, guard));
  assert.equal(f.appended.length, 60);
});

test('only a busy guard lock is attributed to another Fuli hook', async () => {
  const { acquireTranscriptGuardLock } = await import('../src/conversations/transcript-guard-lock.js');
  const { transcriptGuardFailureMessage } = await import('../src/conversations/transcript-guard.js');
  const unsupported = await acquireTranscriptGuardLock(tmpdir(), transcriptDigest('synthetic'), 'synthetic-os').catch(error => error);
  assert.notEqual(unsupported.code, TRANSCRIPT_GUARD_BUSY);
  assert.match(transcriptGuardFailureMessage(unsupported), /could not be completed safely/);
  assert.match(transcriptGuardFailureMessage(Object.assign(new Error('foreign'), { code: 'EADDRINUSE' })), /could not be completed safely/);
  assert.match(transcriptGuardFailureMessage(Object.assign(new Error('busy'), { code: TRANSCRIPT_GUARD_BUSY })), /Another Fuli hook/);
});
