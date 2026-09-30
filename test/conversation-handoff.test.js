import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withTranscriptGuard, transcriptDigest } from '../src/conversations/transcript-guard.js';
import { syncConversationTranscript, claimTranscriptBoundary, recordTranscriptTaskEntry } from '../src/conversations/sync-transcript.js';
import { normalizeCodexRecord, verifyCodexTranscript } from '../src/agents/codex/conversation-transcript.js';
import { runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';

const adapter = { normalize: normalizeCodexRecord, verify: verifyCodexTranscript };
const header = JSON.stringify({ type: 'session_meta', payload: { id: 'session' } }) + '\n';
const row = (role, text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }) + '\n';
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
      if (request.expected_cursor !== cursor) throw new Error('CAS mismatch');
      if (operation === 'append') {
        if (request.agent_id !== owner) throw new Error('Wrong owner');
        appended.push(...request.events.map(event => ({ ...event, owner })));
        cursor = request.cursor;
        return { status: 'saved' };
      }
      if (operation === 'boundary') {
        if (failClaim) throw new Error('Claim failed');
        owner = request.agent_id; return { status: 'bound', cursor };
      }
    }
  } };
  const runtime = join(dir, 'runtime.json');
  const run = callback => withTranscriptGuard(runtime, input, 'codex', true, callback);
  return { dir, input, app, run, appended, calls, runtime,
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

test('guard serializes same-session hooks and persists only hashes and cursors with private permissions', async t => {
  const f = await fixture(t, '');
  await f.run(async guard => {
    await assert.rejects(f.run(async () => { assert.fail('Concurrent hook entered'); }), /EADDRINUSE/);
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

test('lifecycle blocks an unverified boundary before invoking begin_task_context', async t => {
  const f = await fixture(t, row('user', 'different'));
  let invoked = false;
  const result = await runCodexLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => f.input, write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtime }),
    openApplication: () => f.app,
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation() }),
    callTool: async () => { invoked = true; return {}; }
  });
  assert.equal(result.decision, 'block');
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
