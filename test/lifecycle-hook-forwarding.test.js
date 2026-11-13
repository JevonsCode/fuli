// The installed Claude Code and Codex hooks as thin forwarders (rec#132 step
// 1): the forwarded answer equals the in-process one, the entry loads nothing
// heavy before it decides, and each fallback rule. Synthetic data only: a
// Provider double, a temporary data directory and a throwaway console.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpRequest, createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createServer } from '../src/server.js';
import { forwardLifecycleEvent, HOOK_OUTCOME_HEADER } from '../src/agents/lifecycle-forwarder.js';
import { reachableModules } from '../test-support/module-graph.js';
import { forgetConsole, recordConsole, startSyntheticHookProvider, syntheticHookDataDirectory }
  from '../test-support/synthetic-hook-provider.js';

const ROUTE = '/api/lifecycle-hooks/claude-code';
const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;
// Each client's installed command line (pack-manifest.js).
const CLIENTS = {
  'claude-code': { entry: resolve('src/agents/claude-code/lifecycle-hook.js'),
    args: (config, event, timeoutMs = 28000) => ['--fuli-claude-lifecycle', '--runtime-config', config, '--event', event,
      '--timeout-ms', String(timeoutMs)] },
  codex: { entry: resolve('src/agents/codex/lifecycle-hook.js'),
    args: (config, event, timeoutMs) => ['--fuli-lifecycle', '--runtime-config', config, '--event', event,
      ...(timeoutMs ? ['--timeout-ms', String(timeoutMs)] : [])] }
};

function runHook(fixture, event, stdin, { client = 'claude-code', timeoutMs } = {}) {
  const { entry, args } = CLIENTS[client];
  const child = spawn(process.execPath, [entry, ...args(fixture.runtimeConfigPath, event, timeoutMs)],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(stdin);
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', exitCode => done({ stdout, stderr, exitCode }));
  });
}

// Task tokens are random and each run uses its own session.
function comparable(result, session) {
  return { ...result, stdout: result.stdout.replaceAll(session, '<session>')
    .replace(/fuli-task-[0-9a-f-]{36}/g, '<token>') };
}

async function throwawayConsole(t) {
  const provider = await startSyntheticHookProvider();
  const fixture = syntheticHookDataDirectory(tmpdir(), provider.url);
  const started = await createServer({ port: 0, runtimeConfigPath: fixture.runtimeConfigPath, peer: false });
  let forwarded = 0;
  started.server.on('request', request => { if (request.url.startsWith('/api/lifecycle-hooks/')) forwarded += 1; });
  t.after(async () => {
    await started.close();
    await provider.close();
    fixture.remove();
  });
  return { fixture, provider, url: started.url, forwarded: () => forwarded };
}

// Each scenario: the hook calls of one session, the answer of the last compared.
const SCENARIOS = [
  ['prompt in a registered project', f => [['UserPromptSubmit', { cwd: f.projectPath, prompt: 'Synthetic prompt for the registered project' }]]],
  ['prompt in an unregistered folder', f => [['UserPromptSubmit', { cwd: f.otherPath, prompt: 'Synthetic prompt elsewhere' }]]],
  ['session start', f => [['SessionStart', { cwd: f.projectPath, source: 'startup' }]]],
  ['stop after a prompt', f => [['UserPromptSubmit', { cwd: f.projectPath, prompt: 'Synthetic prompt before stop' }],
    ['Stop', { cwd: f.projectPath, last_assistant_message: 'Synthetic reply' }]]],
  ['malformed input', () => [['UserPromptSubmit', '{synthetic-malformed']]],
  ['oversize input', f => [['UserPromptSubmit', { cwd: f.projectPath, prompt: 'x'.repeat(300 * 1024) }]]]
];

for (const client of Object.keys(CLIENTS)) {
  test(`the forwarded ${client} hook answers exactly as the hook run in its own process`, { timeout: 120_000 }, async t => {
    const service = await throwawayConsole(t);
    const { fixture } = service;
    for (const [name, calls] of SCENARIOS) {
      const results = {};
      for (const mode of ['here', 'there']) {
        if (mode === 'there') recordConsole(fixture.dataDir, { url: service.url });
        else forgetConsole(fixture.dataDir);
        const session = `synthetic-${client}-${name.replaceAll(' ', '-')}-${mode}`;
        const before = service.forwarded();
        let result;
        for (const [event, payload] of calls(fixture)) {
          const stdin = typeof payload === 'string' ? payload : JSON.stringify({ session_id: session, hook_event_name: event,
            transcript_path: join(fixture.root, `${session}.jsonl`), ...payload });
          result = await runHook(fixture, event, stdin, { client });
        }
        assert.equal(service.forwarded() - before, mode === 'there' ? calls(fixture).length : 0, `${name}: ${mode}`);
        results[mode] = comparable(result, session);
      }
      assert.ok(results.here.stdout.trim(), name);
      assert.deepEqual(results.there, results.here, name);
    }
  });

  test(`before it decides, the ${client} entry loads only modules that import nothing but Node built-ins`, () => {
    const { entry } = CLIENTS[client];
    const graph = [...reachableModules(entry, { dynamicImports: false })].map(path => resolve(path));
    assert.deepEqual(graph.sort(), [entry, resolve(entry, '..', 'hook-contract.js'),
      resolve('src/agents/lifecycle-forwarder.js'), resolve('src/local-runtime/processes.js')].sort());
    for (const path of graph) {
      const specifiers = [...readFileSync(path, 'utf8').matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1]);
      assert.ok(specifiers.every(specifier => specifier.startsWith('node:') || specifier.startsWith('.')), path);
    }
  });
}

// A console double: answers each hook call with `answer(request, response)`.
async function consoleDouble(t, answer) {
  let calls = 0;
  const server = createHttpServer((request, response) => { calls += 1; answer(request, response); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls: () => calls };
}

function forwardCall(fixture, { timeoutMs = 2000, isAlive = () => true } = {}) {
  return forwardLifecycleEvent({ client: 'claude-code', cwd: fixture.root, env: {}, stdin: [Buffer.from('{}')],
    argv: ['--runtime-config', fixture.runtimeConfigPath, '--event', 'UserPromptSubmit'] }, { timeoutMs, isAlive });
}

test('nothing sent: the hook runs itself without a recorded console, a live PID or a connection', async t => {
  const fixture = syntheticHookDataDirectory(tmpdir(), 'http://127.0.0.1:9');
  t.after(fixture.remove);
  assert.deepEqual(await forwardCall(fixture), { run: 'here', reason: 'no_console' });
  recordConsole(fixture.dataDir, { url: 'http://127.0.0.1:9' });
  assert.deepEqual(await forwardCall(fixture, { isAlive: () => false }), { run: 'here', reason: 'no_console' });
  recordConsole(fixture.dataDir, { url: 'https://example.invalid' });
  assert.deepEqual(await forwardCall(fixture), { run: 'here', reason: 'no_console' });
  // Nothing listens: the connection is refused before anything is sent.
  recordConsole(fixture.dataDir, { url: `http://127.0.0.1:${await freePort()}` });
  assert.deepEqual(await forwardCall(fixture), { run: 'here', reason: 'unreachable' });
});

test('a console that did not run the call lets the hook run it itself', async t => {
  const fixture = syntheticHookDataDirectory(tmpdir(), 'http://127.0.0.1:9');
  t.after(fixture.remove);
  const refused = await consoleDouble(t, (_request, response) => {
    response.writeHead(409, { [HOOK_OUTCOME_HEADER]: 'refused', 'content-type': 'application/json' });
    response.end('{}');
  });
  recordConsole(fixture.dataDir, { url: refused.url });
  assert.deepEqual(await forwardCall(fixture), { run: 'here', reason: 'refused' });
  // A console from before this route answers without the header.
  const older = await consoleDouble(t, (_request, response) => { response.writeHead(404); response.end('Not found'); });
  recordConsole(fixture.dataDir, { url: older.url });
  assert.deepEqual(await forwardCall(fixture), { run: 'here', reason: 'no_route' });
});

test('a call the console may have run is never run again', async t => {
  const fixture = syntheticHookDataDirectory(tmpdir(), 'http://127.0.0.1:9');
  t.after(fixture.remove);
  const silent = await consoleDouble(t, () => {});
  recordConsole(fixture.dataDir, { url: silent.url });
  const timedOut = await forwardCall(fixture, { timeoutMs: 100 });
  assert.equal(timedOut.run, 'lost');
  assert.equal(timedOut.error.code, 'lifecycle_forward_timeout');
  const dropped = await consoleDouble(t, request => request.socket.destroy());
  recordConsole(fixture.dataDir, { url: dropped.url });
  assert.equal((await forwardCall(fixture)).run, 'lost');
  const malformed = await consoleDouble(t, (_request, response) => {
    response.writeHead(200, { [HOOK_OUTCOME_HEADER]: 'ran', 'content-type': 'application/json' });
    response.end('{"stdout":1}');
  });
  recordConsole(fixture.dataDir, { url: malformed.url });
  assert.equal((await forwardCall(fixture)).run, 'lost');
});

for (const client of Object.keys(CLIENTS)) test(`the installed ${client} hook answers a lost call as unavailable and does not run it itself`, async t => {
  const provider = await startSyntheticHookProvider();
  const fixture = syntheticHookDataDirectory(tmpdir(), provider.url);
  t.after(async () => { await provider.close(); fixture.remove(); });
  const silent = await consoleDouble(t, () => {});
  recordConsole(fixture.dataDir, { url: silent.url });
  const result = await runHook(fixture, 'UserPromptSubmit', JSON.stringify({ session_id: 'synthetic-lost-session',
    cwd: fixture.projectPath, prompt: 'Synthetic prompt' }), { client, timeoutMs: 300 });
  assert.equal(result.exitCode, 0);
  assert.equal(silent.calls(), 1);
  assert.match(JSON.parse(result.stdout).systemMessage, /not verified/);
  assert.match(result.stdout, /sessionId=\\"synthetic-lost-session\\"/);
  assert.equal(provider.requests(), 0, 'the hook must not run the call it handed over');
});

function post(url, body, headers = {}) {
  return new Promise((done, fail) => {
    const request = httpRequest(new URL(ROUTE, url), { method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => done({ status: response.statusCode, outcome: response.headers[HOOK_OUTCOME_HEADER], text }));
      });
    request.once('error', fail);
    request.end(JSON.stringify(body));
  });
}

test('the console runs hook calls only for this computer, this data directory and this version', async t => {
  const service = await throwawayConsole(t);
  const { fixture } = service;
  const call = { version: VERSION, cwd: fixture.root, env: {}, stdin: Buffer.from('{}').toString('base64'),
    argv: ['--runtime-config', fixture.runtimeConfigPath, '--event', 'UserPromptSubmit'] };
  const authority = new URL(service.url).host;
  for (const [body, headers, status] of [
    [call, { origin: `http://${authority}` }, 403],
    [call, { 'x-fuli-delegation': 'synthetic' }, 400],
    [{ ...call, version: '0.0.0-synthetic' }, {}, 409],
    [{ ...call, argv: ['--runtime-config', join(fixture.root, 'other', 'graph-runtime.json'), '--event', 'Stop'] }, {}, 409],
    [{ ...call, env: { PATH: 'synthetic' } }, {}, 400],
    [{ ...call, cwd: 'relative' }, {}, 400]
  ]) {
    const answer = await post(service.url, body, headers);
    // The delegation gate refuses a malformed delegated call before this route.
    if (!headers['x-fuli-delegation']) assert.equal(answer.outcome, 'refused', answer.text);
    assert.equal(answer.status, status, answer.text);
  }
  const ran = await post(service.url, call);
  assert.equal(ran.status, 200);
  assert.equal(ran.outcome, 'ran');
  assert.deepEqual(Object.keys(JSON.parse(ran.text)).sort(), ['exitCode', 'stderr', 'stdout']);
});

async function freePort() {
  const server = createHttpServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}
