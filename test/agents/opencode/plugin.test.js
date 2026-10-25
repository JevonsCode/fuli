// The OpenCode V2 plugin (rec#11 D-63) against a fake OpenCode plugin
// context: the hooks and event stream it registers are driven by hand. The
// real-process cases start only FULI's own Node with synthetic scripts in a
// temporary directory; no OpenCode, FULI data directory or Provider is used.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { fuliOpenCodePlugin } from '../../../src/agents/opencode/plugin.js';
import { openCodePluginSource } from '../../../src/agents/opencode/plugin-file.js';
import { loadClientDescriptorPacks } from '../../../src/setup/agents/descriptor-packs.js';

const CONFIG = Object.freeze({ nodePath: '/runtime/node', hookPath: '/pkg/src/agents/opencode/lifecycle-hook.js',
  runtimeConfigPath: '/data/graph-runtime.json', events: ['prompt', 'execution.succeeded'], timeoutMs: 10_000 });

// A fake OpenCode V2 plugin context: session hooks, session lookup and an event stream.
function openCode({ sessions = {}, getSession } = {}) {
  const hooks = {};
  const queued = [];
  let wake = null;
  let closed = false;
  const ctx = {
    location: { directory: '/synthetic/project' },
    session: {
      hook: async (name, callback) => { hooks[name] = callback; return { dispose: async () => {} }; },
      get: getSession ?? (async ({ sessionID }) => sessions[sessionID] ?? { id: sessionID, location: { directory: '/synthetic/project' } })
    },
    event: {
      subscribe: ({ signal }) => ({
        async *[Symbol.asyncIterator]() {
          signal.addEventListener('abort', () => { closed = true; wake?.(); });
          while (!closed) {
            if (queued.length) yield queued.shift();
            else await new Promise((resolve) => { wake = resolve; });
          }
        }
      })
    }
  };
  const emitData = async (type, data) => {
    queued.push({ type, data });
    wake?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const emit = (type, sessionID) => emitData(type, { sessionID });
  const prompt = (sessionID, text) => {
    const event = { sessionID, messageID: `msg-${sessionID}`, prompt: { text }, delivery: 'steer' };
    return hooks.prompt(event).then(() => event);
  };
  const request = async (sessionID) => {
    const event = { sessionID, system: [{ type: 'text', text: 'OpenCode system prompt' }], messages: [] };
    await hooks.context(event);
    return event.system;
  };
  return { ctx, hooks, emit, emitData, prompt, request };
}

function recordingHook(answers = {}) {
  const runs = [];
  return { runs, runHook: async (call) => {
    runs.push(call);
    call.onSent?.();
    const event = call.args[call.args.indexOf('--event') + 1];
    return typeof answers[event] === 'function' ? answers[event](call) : answers[event] ?? {};
  } };
}

test('the prompt hook starts FULI\'s entry and the context hook adds it as system text, the prompt unchanged', async (t) => {
  const hook = recordingHook({ prompt: { context: 'Fuli task context (OpenCode plugin). {"taskContextToken":"fuli-task-x"}' } });
  const host = openCode({ sessions: { child: { id: 'child', parentID: 'ses-1' },
    'ses-1': { id: 'ses-1', location: { directory: '/synthetic/project' }, subpath: 'packages/app' } } });
  const cleanup = await fuliOpenCodePlugin(CONFIG, { ...hook, now: () => 0 }).setup(host.ctx);
  t.after(cleanup);
  const event = await host.prompt('ses-1', 'Fix the login bug.');
  assert.deepEqual(event.prompt, { text: 'Fix the login bug.' }, 'the person\'s prompt is never changed');
  assert.equal(hook.runs.length, 1);
  const [run] = hook.runs;
  assert.equal(run.command, CONFIG.nodePath);
  assert.deepEqual(run.args, [CONFIG.hookPath, '--fuli-opencode-lifecycle', '--runtime-config', CONFIG.runtimeConfigPath,
    '--event', 'prompt', '--timeout-ms', '10000']);
  assert.deepEqual(run.input, { session_id: 'ses-1', message_id: 'msg-ses-1',
    cwd: path.join('/synthetic/project', 'packages/app'), prompt: 'Fix the login bug.' });
  assert.equal(run.killAfterMs, 11_500);
  const system = (await host.request('ses-1'));
  assert.deepEqual(system.at(-1), { type: 'text', text: 'Fuli task context (OpenCode plugin). {"taskContextToken":"fuli-task-x"}' });
  assert.equal((await host.request('ses-1')).length, 2, 'each model request of the turn gets the entry once');
  assert.equal((await host.request('ses-other')).length, 1, 'another session gets nothing');

  await host.prompt('child', 'Search the codebase.');
  assert.equal(hook.runs.length, 1, 'a subagent child session starts no task of its own');
});

test('a successful execution runs the stop; a failed or interrupted one closes nothing', async (t) => {
  const hook = recordingHook({ prompt: { context: 'entry' } });
  const host = openCode();
  t.after(await fuliOpenCodePlugin(CONFIG, hook).setup(host.ctx));
  await host.prompt('ses-1', 'one');
  await host.emit('session.execution.succeeded', 'ses-1');
  assert.deepEqual(hook.runs.map((run) => [run.args[5], run.input]), [['prompt', hook.runs[0].input],
    ['stop', { session_id: 'ses-1' }]]);
  assert.deepEqual([hook.runs[1].args.slice(-2), hook.runs[1].killAfterMs], [['--timeout-ms', '5000'], 6500],
    'a close gets a shorter deadline than an entry');
  assert.equal((await host.request('ses-1')).length, 1, 'the entry ends with its execution');

  for (const ending of ['session.execution.failed', 'session.execution.interrupted']) {
    await host.prompt('ses-1', 'again');
    await host.emit(ending, 'ses-1');
    assert.equal(hook.runs.at(-1).args[5], 'prompt', `${ending} runs no stop`);
    assert.equal((await host.request('ses-1')).length, 1);
  }
  await host.emit('session.execution.succeeded', 'ses-unknown');
  assert.equal(hook.runs.at(-1).args[5], 'prompt', 'a session the plugin never entered is not stopped');
});

const stops = (hook) => hook.runs.filter((run) => run.args[5] === 'stop');

// `opencode run` exits on the succeeded event and its server unloads plugins
// right after, so the close must also come from unload, and still only once.
test('unload closes an open turn that succeeded once, and a later succeeded event does not close it again', async () => {
  const sessions = {};
  const hook = recordingHook({ prompt: { context: 'entry' } });
  const host = openCode({ sessions });
  const cleanup = await fuliOpenCodePlugin(CONFIG, { ...hook, now: () => 1_000_000 }).setup(host.ctx);
  await host.prompt('ses-1', 'one');
  sessions['ses-1'] = { id: 'ses-1', outcome: 'succeeded', time: { idle: 1_002_000 } };
  await cleanup();
  assert.deepEqual(stops(hook).map((run) => [run.input, run.detached, run.args.slice(-2)]),
    [[{ session_id: 'ses-1' }, true, ['--timeout-ms', '5000']]], 'a detached close with the short deadline');
  await host.emit('session.execution.succeeded', 'ses-1');
  assert.equal(stops(hook).length, 1);
});

test('a succeeded event closes the turn once, and unload after it closes nothing more', async () => {
  const hook = recordingHook({ prompt: { context: 'entry' } });
  const host = openCode();
  const cleanup = await fuliOpenCodePlugin(CONFIG, hook).setup(host.ctx);
  await host.prompt('ses-1', 'one');
  await host.emit('session.execution.succeeded', 'ses-1');
  await host.emit('session.execution.succeeded', 'ses-1');
  await cleanup();
  assert.equal(stops(hook).length, 1);
  assert.equal(stops(hook)[0].detached, true);
});

test('unload leaves a failed, interrupted or still running turn open, and closes one OpenCode can no longer describe', async () => {
  for (const [session, expected] of [
    [{ outcome: 'failed', time: { idle: 1_002_000 } }, 0],
    [{ outcome: 'interrupted', time: { idle: 1_002_000 } }, 0],
    [{ outcome: 'succeeded', time: { idle: 900_000 } }, 0],
    [{ time: {} }, 0]
  ]) {
    const sessions = {};
    const hook = recordingHook({ prompt: { context: 'entry' } });
    const host = openCode({ sessions });
    const cleanup = await fuliOpenCodePlugin(CONFIG, { ...hook, now: () => 1_000_000 }).setup(host.ctx);
    await host.prompt('ses-1', 'one');
    sessions['ses-1'] = { id: 'ses-1', ...session };
    await cleanup();
    assert.equal(stops(hook).length, expected, JSON.stringify(session));
  }
  let shuttingDown = false;
  const hook = recordingHook({ prompt: { context: 'entry' } });
  const host = openCode({ getSession: async ({ sessionID }) => {
    if (shuttingDown) throw new Error('server closing');
    return { id: sessionID };
  } });
  const cleanup = await fuliOpenCodePlugin(CONFIG, hook).setup(host.ctx);
  await host.prompt('ses-1', 'one');
  shuttingDown = true;
  await cleanup();
  assert.equal(stops(hook).length, 1);
});

test('unload hands a real close its input and returns without waiting for it to finish', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'p63-opencode-hook-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'stop.json');
  const hookPath = path.join(directory, 'hook.js');
  writeFileSync(hookPath, `const { writeFileSync } = require('node:fs');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const event = process.argv[process.argv.indexOf('--event') + 1];
  if (event === 'prompt') return process.stdout.write(JSON.stringify({ context: 'entry' }) + '\\n');
  setTimeout(() => writeFileSync(${JSON.stringify(marker)}, input), 300);
});
`);
  const host = openCode({ getSession: async () => null });
  const cleanup = await fuliOpenCodePlugin({ ...CONFIG, nodePath: process.execPath, hookPath }).setup(host.ctx);
  await host.prompt('ses-1', 'one');
  const started = Date.now();
  await cleanup();
  assert.ok(Date.now() - started < 1_000, 'unload waits only for the handoff');
  const deadline = Date.now() + 5_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { session_id: 'ses-1' });
});

test('a stop and the next prompt of a session never overlap', async (t) => {
  const order = [];
  let releaseStop;
  const hook = recordingHook({ prompt: () => { order.push('prompt'); return { context: 'entry' }; },
    stop: () => new Promise((resolve) => { order.push('stop started'); releaseStop = () => { order.push('stop done'); resolve({}); }; }) });
  const host = openCode();
  t.after(await fuliOpenCodePlugin(CONFIG, hook).setup(host.ctx));
  await host.prompt('ses-1', 'one');
  await host.emit('session.execution.succeeded', 'ses-1');
  const next = host.prompt('ses-1', 'two');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ['prompt', 'stop started']);
  releaseStop();
  await next;
  assert.deepEqual(order, ['prompt', 'stop started', 'stop done', 'prompt']);
});

test('FULI slow, down or broken: the prompt proceeds with at most one line', async (t) => {
  const answers = [{ cause: 'no answer within 11500 ms' }, { cause: 'FULI could not be started' }, {}];
  const hook = recordingHook({ prompt: () => answers.shift() });
  const host = openCode();
  t.after(await fuliOpenCodePlugin(CONFIG, hook).setup(host.ctx));
  for (const cause of ['no answer within 11500 ms', 'FULI could not be started', 'no answer']) {
    await host.prompt('ses-1', 'go');
    const [line] = (await host.request('ses-1')).slice(1);
    assert.equal(line.text, `Fuli context is unavailable (${cause}). Continue with the user request; FULI memory and preferences were not loaded for this turn.`);
    assert.equal(line.text.includes('\n'), false);
  }
  const throwing = openCode();
  t.after(await fuliOpenCodePlugin(CONFIG, { runHook: async () => { throw new Error('boom'); } }).setup(throwing.ctx));
  await assert.doesNotReject(throwing.prompt('ses-1', 'go'));
  assert.deepEqual((await throwing.request('ses-1')).slice(1).map(({ text }) => text),
    ['Fuli context is unavailable (no answer). Continue with the user request; FULI memory and preferences were not loaded for this turn.']);
});

test('an OpenCode without V2 session hooks gets nothing and no error', async () => {
  assert.equal(await fuliOpenCodePlugin(CONFIG).setup({ event: {} }), undefined);
});

test('a hook process that never answers is killed at the timeout and the prompt proceeds', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'p63-opencode-hook-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const hang = path.join(directory, 'hang.js');
  writeFileSync(hang, 'process.stdin.resume(); setInterval(() => {}, 1000);\n');
  const host = openCode();
  t.after(await fuliOpenCodePlugin({ ...CONFIG, nodePath: process.execPath, hookPath: hang, timeoutMs: 1_100 }).setup(host.ctx));
  const started = Date.now();
  await host.prompt('ses-1', 'go');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 2_000 && elapsed < 2_600 + 2_000, `admission is bounded by the pack budget (${elapsed} ms)`);
  assert.match((await host.request('ses-1'))[1].text, /^Fuli context is unavailable \(no answer within 2[56]\d\d ms\)\./);
});

test('admission spends no more than its budget: a lookup that hangs is cut short, and too little time left starts no entry', async (t) => {
  const hook = recordingHook({ prompt: { context: 'entry' } });
  let clock = 0;
  const host = openCode({ getSession: () => { clock += 9_500; return new Promise(() => {}); } });
  t.after(await fuliOpenCodePlugin(CONFIG, { ...hook, now: () => clock }).setup(host.ctx));
  const started = Date.now();
  await host.prompt('ses-1', 'go');
  assert.ok(Date.now() - started < 1_000, 'the session lookup is bounded');
  assert.equal(hook.runs.length, 0, 'half a second left of the 10 s entry budget starts no hook');
  assert.match((await host.request('ses-1'))[1].text, /^Fuli context is unavailable \(no answer within 10000 ms\)\./);
});

test('a queued prompt begins when delivered, after the running turn closed, and each turn keeps its own entry', async (t) => {
  let entries = 0;
  const hook = recordingHook({ prompt: (call) => ({ context: `entry ${++entries} for ${call.input.message_id}` }) });
  const host = openCode();
  t.after(await fuliOpenCodePlugin(CONFIG, hook).setup(host.ctx));
  await host.prompt('ses-1', 'A');
  assert.equal((await host.request('ses-1')).at(-1).text, 'entry 1 for msg-ses-1');
  // B arrives while A runs: queued, no task yet, and A's requests keep A's entry.
  const queued = { sessionID: 'ses-1', messageID: 'msg-B', prompt: { text: 'B' }, delivery: 'queue' };
  await host.hooks.prompt(queued);
  assert.deepEqual(queued.prompt, { text: 'B' });
  assert.equal(hook.runs.length, 1);
  assert.equal((await host.request('ses-1')).at(-1).text, 'entry 1 for msg-ses-1');
  await host.emit('session.execution.succeeded', 'ses-1');
  assert.deepEqual(hook.runs.map((run) => [run.args[5], run.input.message_id]), [['prompt', 'msg-ses-1'], ['stop', undefined]],
    'A closes on its success; B has not begun');
  await host.emitData('session.inbox.delivered', { sessionID: 'ses-1', inboxID: 'msg-B' });
  assert.equal((await host.request('ses-1')).at(-1).text, 'entry 2 for msg-B', 'B runs with its own entry');
  await host.emit('session.execution.succeeded', 'ses-1');
  assert.deepEqual(hook.runs.map((run) => [run.args[5], run.input.message_id]),
    [['prompt', 'msg-ses-1'], ['stop', undefined], ['prompt', 'msg-B'], ['stop', undefined]], 'B\'s success closes B');
});

test('a queued prompt delivered inside the running execution closes the turn before it and begins its own', async (t) => {
  const order = [];
  const hook = recordingHook({ prompt: (call) => { order.push(`prompt ${call.input.message_id}`); return { context: call.input.message_id }; },
    stop: () => { order.push('stop'); return {}; } });
  const host = openCode();
  t.after(await fuliOpenCodePlugin(CONFIG, hook).setup(host.ctx));
  await host.prompt('ses-1', 'A');
  await host.hooks.prompt({ sessionID: 'ses-1', messageID: 'msg-B', prompt: { text: 'B' }, delivery: 'queue' });
  await host.emitData('session.inbox.delivered', { sessionID: 'ses-1', inboxID: 'msg-B' });
  assert.equal((await host.request('ses-1')).at(-1).text, 'msg-B');
  await host.emit('session.execution.succeeded', 'ses-1');
  assert.deepEqual(order, ['prompt msg-ses-1', 'stop', 'prompt msg-B', 'stop'], 'A, then B, each closed once');
});

test('without a delivery event, the queued prompt\'s turn begins with the next execution\'s first request', async (t) => {
  const hook = recordingHook({ prompt: (call) => ({ context: call.input.message_id }) });
  const host = openCode();
  t.after(await fuliOpenCodePlugin(CONFIG, hook).setup(host.ctx));
  await host.prompt('ses-1', 'A');
  await host.hooks.prompt({ sessionID: 'ses-1', messageID: 'msg-B', prompt: { text: 'B' }, delivery: 'queue' });
  await host.emit('session.execution.succeeded', 'ses-1');
  assert.equal((await host.request('ses-1')).at(-1).text, 'msg-B');
});

test('unload waits, within its bound, for a close a success event already handed off', async () => {
  let sent = false;
  const host = openCode();
  const cleanup = await fuliOpenCodePlugin(CONFIG, { runHook: async (call) => {
    if (call.args[5] === 'prompt') return { context: 'entry' };
    await new Promise((resolve) => setTimeout(resolve, 200));
    sent = true;
    call.onSent();
    return {};
  } }).setup(host.ctx);
  await host.prompt('ses-1', 'A');
  await host.emit('session.execution.succeeded', 'ses-1');
  assert.equal(sent, false);
  await cleanup();
  assert.equal(sent, true);
});

test('a hook registration OpenCode refuses leaves the plugin inactive and loaded', async () => {
  const disposed = [];
  const ctx = { session: { hook: async (name) => {
    if (name === 'context') throw new Error('refused');
    return { dispose: async () => disposed.push(name) };
  } }, event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) } };
  assert.equal(await fuliOpenCodePlugin(CONFIG, recordingHook()).setup(ctx), undefined);
  assert.deepEqual(disposed, ['prompt']);
});

test('a hook process answer reaches the model as written', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'p63-opencode-hook-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const echo = path.join(directory, 'echo.js');
  writeFileSync(echo, `let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const { prompt } = JSON.parse(input);
  process.stdout.write(JSON.stringify({ context: 'entry for ' + prompt + ' ' + process.argv.slice(2).join(' ') }) + '\\n');
});
`);
  const host = openCode();
  t.after(await fuliOpenCodePlugin({ ...CONFIG, nodePath: process.execPath, hookPath: echo }, { now: () => 0 }).setup(host.ctx));
  await host.prompt('ses-1', 'Fix it.');
  assert.equal((await host.request('ses-1'))[1].text, 'entry for Fix it. --fuli-opencode-lifecycle --runtime-config /data/graph-runtime.json --event prompt --timeout-ms 10000');
});

test('the file setup writes loads as an OpenCode V2 plugin: a default export with an id and a setup function', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'p63-opencode-plugin-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pack = loadClientDescriptorPacks().find(({ id }) => id === 'opencode');
  const file = path.join(directory, 'index.js');
  writeFileSync(file, openCodePluginSource({ nodePath: process.execPath, runtimeConfigPath: '/data/graph-runtime.json',
    mcpServerPath: path.resolve('src/mcp-server.js') }, pack.lifecycleHooks));
  const { default: plugin } = await import(pathToFileURL(file).href);
  assert.equal(plugin.id, 'fuli');
  assert.equal(typeof plugin.setup, 'function');
});
