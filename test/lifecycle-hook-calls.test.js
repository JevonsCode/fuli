// Which forwarded hook calls the console takes (lifecycle-hook-calls.js), the
// route's "ran" headers before the work, and the cleanup of a call past its
// deadline. Synthetic data only.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createServer } from '../src/server.js';
import { createLifecycleHookCalls } from '../src/agents/lifecycle-hook-calls.js';
import { HOOK_OUTCOME_HEADER, hookClock } from '../src/agents/lifecycle-forwarder.js';
import { runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-event.js';

const VERSION = JSON.parse((await import('node:fs')).readFileSync('package.json', 'utf8')).version;

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-hook-calls-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// A run double whose calls end only when the test settles them.
function heldRuns() {
  const calls = [];
  const run = (call, { onSettled }) => {
    calls.push({ call, settle: onSettled });
    return Promise.resolve({ stdout: '{}\n', stderr: '', exitCode: 0 });
  };
  return { run, calls };
}

const callOf = (session, extra = {}) => ({ client: 'claude-code', argv: ['--event', 'Stop'], env: {}, cwd: tmpdir(),
  timeoutMs: 50, stdin: [Buffer.from(JSON.stringify({ session_id: session, ...extra }))] });

test('the console takes calls of one session together, and at most its cap at once', async () => {
  const runs = heldRuns();
  const calls = createLifecycleHookCalls({ runtimeConfigPath: 'synthetic', baseEnv: {}, maxCalls: 2, run: runs.run,
    record: () => {} });
  for (const session of ['synthetic-a', 'synthetic-a']) await (await calls.admit(callOf(session))).start();
  assert.equal(calls.running(), 2);
  assert.deepEqual(await calls.admit(callOf('synthetic-b')), { refused: 'busy' });
  runs.calls[0].settle();
  assert.equal(calls.running(), 1);
  assert.ok((await calls.admit(callOf('synthetic-b'))).start);
});

test('admissions that overlap never take more calls than the cap, and an unstarted one gives its place back', async () => {
  const runs = heldRuns();
  const calls = createLifecycleHookCalls({ runtimeConfigPath: 'synthetic', baseEnv: {}, maxCalls: 8, run: runs.run,
    record: () => {} });
  // Every admission is checked before any of them starts, as the route's
  // awaits can interleave them.
  const admitted = await Promise.all(Array.from({ length: 20 }, (_, index) => calls.admit(callOf(`synthetic-${index}`))));
  const taken = admitted.filter(entry => entry.start);
  assert.equal(taken.length, 8);
  assert.equal(admitted.filter(entry => entry.refused === 'busy').length, 12);
  assert.equal(calls.running(), 8, 'a taken call holds its place before it starts');
  taken[7].release();
  assert.equal(calls.running(), 7);
  await Promise.all(taken.slice(0, 7).map(entry => entry.start()));
  assert.equal(calls.running(), 7);
  assert.ok((await calls.admit(callOf('synthetic-late'))).start);
  assert.deepEqual(await calls.admit(callOf('synthetic-over')), { refused: 'busy' });
});

test('a call past its deadline is recorded and keeps its session out until it ends', async () => {
  const runs = heldRuns();
  const recorded = [];
  const calls = createLifecycleHookCalls({ runtimeConfigPath: 'synthetic', baseEnv: {}, run: runs.run,
    record: entry => recorded.push(entry) });
  await (await calls.admit(callOf('synthetic-slow'))).start();
  // Before its deadline (and grace) the same session is still taken.
  assert.ok((await calls.admit(callOf('synthetic-slow'))).start);
  await delay(1100);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].error.code, 'lifecycle_call_overdue');
  assert.equal(recorded[0].client, 'claude_code');
  assert.deepEqual(await calls.admit(callOf('synthetic-slow')), { refused: 'session_overdue' });
  assert.ok((await calls.admit(callOf('synthetic-other'))).start, 'other sessions are not held up');
  runs.calls[0].settle();
  assert.ok((await calls.admit(callOf('synthetic-slow'))).start, 'its late end lets the session in again');
});

test('a payload whose transcript is not a regular file, or whose cwd is not a folder, is not taken', async t => {
  const root = scratch(t);
  const file = join(root, 'synthetic.jsonl');
  writeFileSync(file, '');
  const calls = createLifecycleHookCalls({ runtimeConfigPath: 'synthetic', baseEnv: {}, run: heldRuns().run, record: () => {} });
  assert.ok((await calls.admit(callOf('s', { transcript_path: file, cwd: root }))).start);
  assert.ok((await calls.admit(callOf('s', { transcript_path: join(root, 'missing.jsonl') }))).start, 'not written yet');
  assert.deepEqual(await calls.admit(callOf('s', { transcript_path: root })), { refused: 'unsafe_path' });
  assert.deepEqual(await calls.admit(callOf('s', { cwd: file })), { refused: 'unsafe_path' });
});

test('the route starts a call only while the hook still waits, after sending "ran"', async t => {
  const root = scratch(t);
  const runtimeConfigPath = join(root, 'graph-runtime.json');
  let started = 0;
  let released = 0;
  const order = [];
  const lifecycleHooks = { runtimeConfigPath, admit: async () => {
    await delay(150);
    return { release: () => { released += 1; }, start: async () => { started += 1; await delay(200); order.push('finished'); return { stdout: 'x\n', stderr: '', exitCode: 0 }; } };
  } };
  const app = { graphiti: true, close: () => {} };
  const server = await createServer({ port: 0, app, lifecycleHooks, peer: false });
  t.after(() => server.close());
  const call = { version: VERSION, cwd: root, env: {}, timeoutMs: 5000, stdin: '', startBy: hookClock() + 60_000,
    argv: ['--runtime-config', runtimeConfigPath, '--event', 'Stop'] };
  const body = JSON.stringify(call);
  const send = () => httpRequest(new URL('/api/lifecycle-hooks/claude-code', server.url),
    { method: 'POST', headers: { 'content-type': 'application/json' } });
  // The hook stops waiting before the console gets to it.
  const abandoned = send();
  abandoned.on('error', () => {});
  abandoned.end(body);
  await delay(50);
  abandoned.destroy();
  await delay(250);
  assert.equal(started, 0);
  assert.equal(released, 1, 'the abandoned call gives its place back');
  // Past the time the hook stops waiting for "ran", the console refuses: the
  // hook may already be running the call itself.
  const late = await new Promise((done, fail) => {
    const request = send();
    request.once('error', fail);
    request.once('response', response => {
      response.resume();
      response.once('end', () => done({ status: response.statusCode, outcome: response.headers[HOOK_OUTCOME_HEADER] }));
    });
    request.end(JSON.stringify({ ...call, startBy: hookClock() - 1 }));
  });
  assert.deepEqual(late, { status: 503, outcome: 'refused' });
  assert.equal(started, 0);
  assert.equal(released, 2);
  // A waiting hook gets "ran" with the headers, then the answer.
  const answered = await new Promise((done, fail) => {
    const request = send();
    request.once('error', fail);
    request.once('response', response => {
      order.push(`headers:${response.headers[HOOK_OUTCOME_HEADER]}`);
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => done(text));
    });
    request.end(body);
  });
  assert.equal(started, 1);
  assert.deepEqual(order, ['headers:ran', 'finished'], 'the headers come before the work ends');
  assert.deepEqual(JSON.parse(answered), { stdout: 'x\n', stderr: '', exitCode: 0 });
});

test('at its deadline a Claude call closes its lease and stores once, even if its work never ends', async () => {
  const closed = [];
  let cleanup;
  const never = new Promise(() => {});
  void runClaudeLifecycleHook(['--event', 'Stop'], {
    readInput: async () => ({ session_id: 'synthetic-hung', cwd: tmpdir() }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: join(tmpdir(), 'synthetic-missing', 'graph-runtime.json') }),
    openApplication: () => ({ close: async () => { closed.push('app'); } }),
    createLeases: () => ({ withGraphLease: () => never, close: async () => { closed.push('lease'); } }),
    onCleanup: close => { cleanup = close; }
  });
  await delay(20);
  await cleanup();
  await cleanup();
  assert.deepEqual(closed.sort(), ['app', 'lease']);
});
