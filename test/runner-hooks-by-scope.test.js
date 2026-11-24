// The installed Claude Code and Codex hooks on a follower, by the folder of
// their payload (src/runner/hook-scope.js): a project routed to this computer
// runs its hooks here, as on any FULI; every other folder goes to the host
// exactly as before; what cannot be answered here is said, never sent to the
// host instead. Synthetic data only: a Provider double, a host listener on
// 127.0.0.1 whose hook is a double, temporary data directories.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { HOOK_OUTCOME_HEADER } from '../src/agents/lifecycle-forwarder.js';
import { createDeviceCertificate, deviceIdentity, loadDeviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { writeRecord } from '../src/runner/follower-local-runtime.js';
import { unavailableHere } from '../src/runner/hook-scope.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { hostOwner, LOCAL_OWNER, ROUTES_FILE, RoutesStore } from '../src/runner/routes-store.js';
import { RUNNER_HOOK_CONTEXT } from '../src/runner/runner-mode.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';
import { ownIssuer, readIssued } from '../src/runner/task-issuer.js';
import { forgetConsole, recordConsole, startSyntheticHookProvider, syntheticHookDataDirectory, SYNTHETIC_PROJECT_ID }
  from '../test-support/synthetic-hook-provider.js';

const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;
const HOST_STDOUT = '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"entered on the host"}}\n';
const CLIENTS = {
  'claude-code': { entry: resolve('src/agents/claude-code/lifecycle-hook.js'),
    args: (config, event) => ['--fuli-claude-lifecycle', '--runtime-config', config, '--event', event, '--timeout-ms', '20000'] },
  codex: { entry: resolve('src/agents/codex/lifecycle-hook.js'),
    args: (config, event) => ['--fuli-lifecycle', '--runtime-config', config, '--event', event, '--timeout-ms', '20000'] }
};

function runHook(fixture, event, stdin, { client = 'claude-code', env = {} } = {}) {
  const { entry, args } = CLIENTS[client];
  const startedAt = Date.now();
  const child = spawn(process.execPath, [entry, ...args(fixture.runtimeConfigPath, event)],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(stdin);
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', (exitCode) => done({ stdout, stderr, exitCode, ms: Date.now() - startedAt }));
  });
}

// A data directory of the Provider double, made a follower of a host listening here: its own device
// identity, the pairing, `global → host` and `default → host` as `fuli runner join` writes them.
async function follower(t) {
  const provider = await startSyntheticHookProvider();
  const fixture = syntheticHookDataDirectory(tmpdir(), provider.url);
  const host = deviceIdentity(await createDeviceCertificate());
  const own = await loadDeviceIdentity(join(fixture.dataDir, 'peer'));
  const hostStore = new RunnerHostStore(':memory:');
  hostStore.invite({ code: 'synthetic-invitation-code-0003', name: 'Follower B' });
  hostStore.pair({ code: 'synthetic-invitation-code-0003', fingerprint: own.fingerprint, name: 'Follower B' });
  const hostCalls = [];
  const routes = createRunnerRoutes({ app: {}, store: hostStore, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation(), runtimeConfigPath: '/host/data/graph-runtime.json',
    runHook: async (call) => {
      hostCalls.push({ event: call.argv.at(-1), payload: JSON.parse(Buffer.concat(call.stdin).toString('utf8')) });
      return { stdout: HOST_STDOUT, exitCode: 0 };
    } });
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, route: routes.handle,
    sourceAllowed: () => true });
  const store = new RunnerStore(join(fixture.dataDir, RUNNER_FILE));
  store.saveHost({ name: 'Host A', fingerprint: host.fingerprint, certPem: host.certPem, port: listener.port, addresses: ['127.0.0.1'] });
  store.close();
  t.after(async () => {
    await listener.close();
    await routes.close();
    hostStore.close();
    await provider.close();
    fixture.remove();
  });
  const withRoutes = (write) => {
    const store = new RoutesStore(join(fixture.dataDir, ROUTES_FILE));
    try { write(store); } finally { store.close(); }
  };
  return { fixture, provider, hostCalls, withRoutes, hostOwner: hostOwner(host.fingerprint), ownName: ownIssuer(fixture.dataDir) };
}

const ready = (dataDir) => writeRecord(dataDir, { state: 'ready', at: '2026-11-20T10:00:00Z', running: true, projects: [],
  createdHere: true });

const payload = (event, cwd, extra = {}) => JSON.stringify({ session_id: `synthetic-${event}-${Math.random()}`, hook_event_name: event,
  cwd, transcript_path: '/follower/only/transcript.jsonl', ...extra });
const prompt = (cwd) => payload('UserPromptSubmit', cwd, { prompt: 'Synthetic request' });
const stop = (cwd) => payload('Stop', cwd, { last_assistant_message: 'Synthetic reply' });
const start = (cwd) => payload('SessionStart', cwd, { source: 'startup' });

// A console double recorded for the data directory: a hook that went through it would show here.
// ran: it answers as a console that ran the call, else as one from before the hook route.
async function recordedConsole(t, dataDir, { ran = false } = {}) {
  let hookCalls = 0;
  const server = createHttpServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ service: 'fuli-local-console', pid: process.pid, version: VERSION }));
    }
    hookCalls += 1;
    request.resume();
    if (!ran) return response.writeHead(500).end();
    response.writeHead(200, { [HOOK_OUTCOME_HEADER]: 'ran', 'content-type': 'application/json' });
    response.end(JSON.stringify({ stdout: '{}\n', stderr: '', exitCode: 0 }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  recordConsole(dataDir, { url: `http://127.0.0.1:${server.address().port}` });
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }));
  return { hookCalls: () => hookCalls };
}

// Each row: the routes, the hook and its folder, and where the hook goes today
// (before this change, src/agents/lifecycle-forwarder.js on a follower):
// `host` the host runs it, `nothing` a hook a runner does not forward, `fallback`
// the prompt's instruction to enter the task through MCP. After this change
// every row is the same.
const ELSEWHERE = [
  ['no routes store yet, a prompt in a project folder', () => {}, 'UserPromptSubmit', (f) => prompt(f.projectPath), 'host'],
  ['following everything, a prompt in a project folder', (r, h) => r.followEverything(h), 'UserPromptSubmit',
    (f) => prompt(f.projectPath), 'host'],
  ['following everything, a turn end', (r, h) => r.followEverything(h), 'Stop', (f) => stop(f.projectPath), 'host'],
  ['following everything, a session start', (r, h) => r.followEverything(h), 'SessionStart', (f) => start(f.projectPath), 'nothing'],
  ['the project routed to the host by a route of its own', (r, h) => { r.followEverything(h); r.set(`project:${SYNTHETIC_PROJECT_ID}`, h); },
    'UserPromptSubmit', (f) => prompt(f.projectPath), 'host'],
  ['`default` edited to this computer, no project of its own', (r, h) => { r.set('global', h); r.set('default', LOCAL_OWNER); },
    'UserPromptSubmit', (f) => prompt(f.projectPath), 'host'],
  ['another project routed here, a prompt in a folder of no project', (r, h, f) => { r.followEverything(h);
    r.setLocalProject('project:widgets', join(f.root, 'widgets-folder')); }, 'UserPromptSubmit', (f) => prompt(f.otherPath), 'host'],
  ['another project routed here, a turn end in a folder of no project', (r, h, f) => { r.followEverything(h);
    r.setLocalProject('project:widgets', join(f.root, 'widgets-folder')); }, 'Stop', (f) => stop(f.otherPath), 'host'],
  ['another project routed here, a session start elsewhere', (r, h, f) => { r.followEverything(h);
    r.setLocalProject('project:widgets', join(f.root, 'widgets-folder')); }, 'SessionStart', (f) => start(f.otherPath), 'nothing'],
  ['a payload that is not JSON', (r, h) => r.followEverything(h), 'UserPromptSubmit', () => '{synthetic-malformed', 'fallback'],
  ['a payload without a folder', (r, h) => r.followEverything(h), 'UserPromptSubmit',
    () => JSON.stringify({ session_id: 'synthetic', prompt: 'x' }), 'fallback']
];

for (const [name, routed, event, stdin, today] of ELSEWHERE) {
  test(`elsewhere, as today (${today}): ${name}`, async (t) => {
    const f = await follower(t);
    f.withRoutes((routes) => routed(routes, f.hostOwner, f.fixture));
    mkdirSync(join(f.fixture.root, 'widgets-folder'), { recursive: true });
    ready(f.fixture.dataDir);
    const answer = await runHook(f.fixture, event, stdin(f.fixture));
    assert.equal(answer.exitCode, 0);
    assert.equal(f.provider.requests(), 0, 'nothing ran here');
    if (today === 'host') {
      assert.equal(answer.stdout, HOST_STDOUT);
      assert.deepEqual(f.hostCalls.map((call) => call.event), [event]);
      assert.equal(f.hostCalls[0].payload.transcript_path, undefined, 'the transcript stays on the follower');
    } else {
      assert.deepEqual(f.hostCalls, []);
      assert.equal(answer.stdout, today === 'fallback' ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
        additionalContext: RUNNER_HOOK_CONTEXT } })}\n` : '');
    }
  });
}

// A project routed to this computer, made for its folder (make-project-local.js), its runtime ready.
async function localProject(t, { runtime = true } = {}) {
  const f = await follower(t);
  f.withRoutes((routes) => {
    routes.followEverything(f.hostOwner);
    routes.setLocalProject(`project:${SYNTHETIC_PROJECT_ID}`, f.fixture.projectPath);
  });
  if (runtime) ready(f.fixture.dataDir);
  return f;
}

const tokenOf = (stdout) => /fuli-from-[0-9a-f]{16}\.fuli-task-[0-9a-f-]{36}|fuli-task-[0-9a-f-]{36}/.exec(stdout)?.[0] ?? null;

for (const client of Object.keys(CLIENTS)) {
  test(`a ${client} prompt in a project of this computer's runs here, its token named and remembered as this computer's`, async (t) => {
    const f = await localProject(t);
    const console = await recordedConsole(t, f.fixture.dataDir);
    const answer = await runHook(f.fixture, 'UserPromptSubmit', prompt(f.fixture.projectPath), { client });

    assert.equal(answer.exitCode, 0, answer.stderr);
    assert.deepEqual(f.hostCalls, [], 'nothing went to the host');
    assert.equal(console.hookCalls(), 0, 'not through the console, which sends its hook route to the host');
    assert.ok(f.provider.requests() > 0, 'this computer\'s own runtime answered');
    const token = tokenOf(answer.stdout);
    assert.ok(f.ownName && token?.startsWith(`fuli-from-${f.ownName}.`), answer.stdout);
    const raw = readIssued(token).token;
    assert.equal(answer.stdout.split(raw).length - 1, answer.stdout.split(token).length - 1, 'every copy of the token is named');
    f.withRoutes((routes) => assert.equal(routes.taskOwner(raw), LOCAL_OWNER));
  });
}

test('a project of this computer\'s answers its hooks as a FULI of its own does, the transcript kept here', async (t) => {
  const f = await localProject(t);
  const session = 'synthetic-same-session';
  const sessionPrompt = (s) => payload('UserPromptSubmit', f.fixture.projectPath, { session_id: s, prompt: 'Synthetic request',
    transcript_path: join(f.fixture.root, `${s}.jsonl`) });
  const here = await runHook(f.fixture, 'UserPromptSubmit', sessionPrompt(`${session}-follower`));
  const ended = await runHook(f.fixture, 'Stop', payload('Stop', f.fixture.projectPath, { session_id: `${session}-follower`,
    last_assistant_message: 'Synthetic reply', transcript_path: join(f.fixture.root, `${session}-follower.jsonl`) }));
  const started = await runHook(f.fixture, 'SessionStart', start(f.fixture.projectPath));
  assert.deepEqual(f.hostCalls, []);
  // The same data directory without the pairing: a FULI of its own.
  rmSync(join(f.fixture.dataDir, 'runner'), { recursive: true, force: true });
  const alone = await runHook(f.fixture, 'UserPromptSubmit', sessionPrompt(`${session}-alone`));
  const comparable = (result, s) => ({ exitCode: result.exitCode,
    stdout: result.stdout.replaceAll(s, '<session>').replace(/(fuli-from-[0-9a-f]{16}\.)?fuli-task-[0-9a-f-]{36}/g, '<token>') });
  assert.deepEqual(comparable(here, `${session}-follower`), comparable(alone, `${session}-alone`));
  assert.equal(ended.exitCode, 0);
  assert.equal(started.exitCode, 0);
});

test('a project of this computer\'s with its runtime not ready says so, sends nothing to the host, and does not wait', async (t) => {
  const f = await localProject(t, { runtime: false });
  const asked = await runHook(f.fixture, 'UserPromptSubmit', prompt(f.fixture.projectPath));
  const ended = await runHook(f.fixture, 'Stop', stop(f.fixture.projectPath));
  assert.deepEqual(f.hostCalls, []);
  assert.equal(f.provider.requests(), 0);
  const context = JSON.parse(asked.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /local_runtime_not_ready/);
  assert.match(context, /on this computer/);
  assert.match(context, /Start FULI on this computer/);
  assert.match(context, /Nothing was sent to Host A/);
  assert.match(context, /这台电脑/);
  assert.deepEqual([ended.exitCode, ended.stdout], [0, '']);
  assert.match(ended.stderr, /local_runtime_not_ready|cannot answer it yet/);
  assert.ok(asked.ms < 10_000 && ended.ms < 10_000, 'well inside the hook\'s own deadline');
});

test('routes this computer cannot read are said as they are, and the hook goes nowhere', async (t) => {
  const f = await follower(t);
  mkdirSync(join(f.fixture.dataDir, 'runner'), { recursive: true });
  writeFileSync(join(f.fixture.dataDir, ROUTES_FILE), 'not a database, synthetic');
  const asked = await runHook(f.fixture, 'UserPromptSubmit', prompt(f.fixture.projectPath));
  assert.equal(asked.exitCode, 0);
  assert.deepEqual(f.hostCalls, []);
  assert.equal(f.provider.requests(), 0);
  assert.match(JSON.parse(asked.stdout).hookSpecificOutput.additionalContext, /routes_unavailable.*runner\/routes\.sqlite/s);
});

test('a pairing this computer cannot read beside a project of its own is said, and the hook goes nowhere', async (t) => {
  const f = await localProject(t);
  writeFileSync(join(f.fixture.dataDir, RUNNER_FILE), 'not a database, synthetic');
  const asked = await runHook(f.fixture, 'UserPromptSubmit', prompt(f.fixture.projectPath));
  assert.equal(asked.exitCode, 0);
  assert.equal(f.provider.requests(), 0);
  const context = JSON.parse(asked.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /hook_route_unknown/);
  assert.match(context, /fuli routes list/);
});

test('a project of this computer\'s whose FULI cannot run the hook says so and sends nothing to the host', async (t) => {
  const f = await localProject(t);
  // This computer's runtime configuration names no FULI it can open.
  writeFileSync(f.fixture.runtimeConfigPath, '{"version": 999, "synthetic": true}');
  const asked = await runHook(f.fixture, 'UserPromptSubmit', prompt(f.fixture.projectPath));
  assert.equal(asked.exitCode, 0, asked.stderr);
  assert.deepEqual(f.hostCalls, []);
  // The hook's own words that it has no context, then which computer it was and what to do.
  const context = JSON.parse(asked.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Fuli context is unavailable/);
  assert.match(context, /project is on this computer, and this computer's FULI entered no task/);
  assert.match(context, /fuli start/);
  assert.match(context, /Nothing was sent to Host A/);
  assert.ok(asked.ms < 10_000);
});

test('a hook this computer\'s FULI could not run at all says which computer, why and what to do', () => {
  const { code, message } = unavailableHere(new Error('synthetic runtime closed'), 'Host A');
  assert.equal(code, 'local_unavailable');
  assert.match(message, /on this computer, and its FULI could not run this hook \(synthetic runtime closed\)/);
  assert.match(message, /fuli start/);
  assert.match(message, /Nothing was sent to Host A/);
  assert.match(message, /这台电脑/);
});

// Every module a hook process loads, by a resolve hook that writes each to a file.
function loadedRunnerModules(t, fixture, event, stdin) {
  const log = join(fixture.root, 'loaded.txt');
  const hook = join(fixture.root, 'record-loads.mjs');
  writeFileSync(hook, `import { registerHooks } from 'node:module';\nimport { appendFileSync } from 'node:fs';\n`
    + `registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); `
    + `if (r.url.includes('/src/runner/')) appendFileSync(${JSON.stringify(log)}, r.url + '\\n'); return r; } });\n`);
  writeFileSync(log, '');
  return async () => {
    const answer = await runHook(fixture, event, stdin, { env: { NODE_OPTIONS: `--import=${hook}` } });
    const loaded = [...new Set(readFileSync(log, 'utf8').split('\n').filter(Boolean)
      .map((url) => url.slice(url.indexOf('/src/runner/') + 1)))].sort();
    return { answer, loaded };
  };
}

test('a FULI that follows no host loads no module of the follower\'s routing, and nothing of src/runner/ through its console', async (t) => {
  const provider = await startSyntheticHookProvider();
  const fixture = syntheticHookDataDirectory(tmpdir(), provider.url);
  t.after(async () => { await provider.close(); fixture.remove(); });
  const routing = ['src/runner/hook-scope.js', 'src/runner/hook-forwarding.js', 'src/runner/routed-calls.js',
    'src/runner/call-routes.js', 'src/runner/follower-local-runtime.js'];

  // Its console takes the call: the entry loads only what it decides with.
  const console = await recordedConsole(t, fixture.dataDir, { ran: true });
  const through = await loadedRunnerModules(t, fixture, 'UserPromptSubmit', prompt(fixture.projectPath))();
  assert.deepEqual([console.hookCalls(), through.answer.stdout], [1, '{}\n']);
  assert.deepEqual(through.loaded, ['src/runner/runner-mode.js']);

  // No console: the hook runs in its own process, as before this change; what of src/runner/ the
  // whole hook imports for itself (its stores) loads then, never the follower's routing.
  forgetConsole(fixture.dataDir);
  const alone = await loadedRunnerModules(t, fixture, 'UserPromptSubmit', prompt(fixture.projectPath))();
  assert.equal(alone.answer.exitCode, 0);
  assert.ok(provider.requests() > 0);
  assert.deepEqual(alone.loaded.filter((path) => routing.includes(path)), []);
});

test('a follower with no project of its own reads its routes once and loads nothing to run a hook here', async (t) => {
  const f = await follower(t);
  f.withRoutes((routes) => routes.followEverything(f.hostOwner));
  const { answer, loaded } = await loadedRunnerModules(t, f.fixture, 'SessionStart', start(f.fixture.projectPath))();
  assert.deepEqual([answer.exitCode, answer.stdout], [0, '']);
  assert.ok(!loaded.includes('src/runner/routed-calls.js') && !loaded.includes('src/runner/follower-local-runtime.js'), loaded.join());
  assert.equal(f.provider.requests(), 0);
});
