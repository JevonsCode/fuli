// The DeepSeek Harness plugin against a fake Cordis context: the listeners it
// registers are driven by hand with DSH-shaped payloads (agent/pre-step,
// session/event). No DSH, FULI data directory or Provider is used.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { dshBundleFiles } from '../../../src/agents/dsh/bundle.js';
import { fuliDshPlugin } from '../../../src/agents/dsh/plugin.js';

const CONFIG = Object.freeze({ nodePath: '/runtime/node', hookPath: '/pkg/src/agents/dsh/lifecycle-hook.js',
  runtimeConfigPath: '/data/graph-runtime.json', timeoutMs: 10_000 });

// A fake Cordis context: the plugin's listeners and effects, called by hand.
function dsh() {
  const listeners = {};
  const effects = [];
  const ctx = {
    on: (name, listener, options) => { listeners[name] = { listener, options }; },
    effect: (setup) => { effects.push(setup()); }
  };
  const session = (id, header = {}) => ({ id, header: { id, cwd: '/synthetic/project', ...header } });
  const userMessage = (text, id = 'msg-1') => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const preStep = async ({ agentSession = session('session-1'), messages = [userMessage('Outline chapter four.')], turn = 1, step = 1,
    decision, signal = new AbortController().signal } = {}) => {
    const entered = decision ?? { kind: 'enter', messages, startsRequestSeries: true };
    return listeners['agent/pre-step'].listener({ agent: { session: agentSession }, messages, turn, step, signal },
      async () => entered);
  };
  const turnEnd = (agentSession, turn, kind = 'completed') => listeners['session/event'].listener(agentSession,
    { type: 'turn/end', seq: 9, data: { turn, reason: { kind } } });
  const dispose = () => Promise.all(effects.map((dispose) => dispose()));
  return { ctx, listeners, session, userMessage, preStep, turnEnd, dispose };
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

const eventOf = (call) => call.args[call.args.indexOf('--event') + 1];
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('a turn\'s first step begins FULI\'s task and appends its entry after the person\'s unchanged message', async () => {
  const hook = recordingHook({ prompt: { context: 'Fuli task context (DeepSeek Harness plugin). {"taskContextToken":"fuli-task-x"}' } });
  const host = dsh();
  const plugin = fuliDshPlugin(CONFIG, hook);
  assert.equal(plugin.name, 'fuli');
  assert.deepEqual(plugin.inject, ['agents']);
  plugin.apply(host.ctx);
  assert.deepEqual(host.listeners['agent/pre-step'].options, { prepend: true });

  const own = host.userMessage('Outline chapter four.', 'msg-42');
  const decision = await host.preStep({ messages: [own] });
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.startsRequestSeries, true, 'the rest of the decision is kept');
  assert.equal(decision.messages[0], own, 'the person\'s message is unchanged and first');
  const [, entry] = decision.messages;
  assert.equal(entry.role, 'user');
  assert.deepEqual(entry.source, { kind: 'fuli-context', form: 'instructions' });
  assert.deepEqual(entry.content, [{ type: 'text', text: 'Fuli task context (DeepSeek Harness plugin). {"taskContextToken":"fuli-task-x"}' }]);
  assert.equal(typeof entry.id, 'string');

  const [run] = hook.runs;
  assert.equal(run.command, '/runtime/node');
  assert.deepEqual(run.args, ['/pkg/src/agents/dsh/lifecycle-hook.js', '--fuli-dsh-lifecycle', '--runtime-config',
    '/data/graph-runtime.json', '--event', 'prompt', '--timeout-ms', '10000']);
  assert.deepEqual(run.input, { session_id: 'session-1', message_id: 'msg-42', cwd: '/synthetic/project',
    prompt: 'Outline chapter four.' });
  assert.equal(run.killAfterMs, 11_500);
});

test('later steps, rejected steps, subagent sessions and steps without the person\'s words get no entry', async () => {
  const hook = recordingHook({ prompt: { context: 'entry' } });
  const host = dsh();
  fuliDshPlugin(CONFIG, hook).apply(host.ctx);
  const later = await host.preStep({ step: 2 });
  assert.equal(later.messages.length, 1);
  assert.deepEqual(await host.preStep({ decision: { kind: 'reject' } }), { kind: 'reject' });
  const child = await host.preStep({ agentSession: host.session('session-child', { origin: 'subagent' }) });
  assert.equal(child.messages.length, 1);
  const injected = { id: 'ctx', role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'clock' }] };
  const noPrompt = await host.preStep({ messages: [injected] });
  assert.deepEqual(noPrompt.messages, [injected]);
  assert.equal(hook.runs.length, 0);
});

test('a completed turn closes its task once, detached; an error or a cancellation closes nothing', async () => {
  const hook = recordingHook({ prompt: { context: 'entry' } });
  const host = dsh();
  fuliDshPlugin(CONFIG, hook).apply(host.ctx);
  const first = host.session('session-1');
  await host.preStep({ agentSession: first, turn: 1 });
  host.turnEnd(first, 1);
  host.turnEnd(first, 1);
  await settle();
  const stops = hook.runs.filter((call) => eventOf(call) === 'stop');
  assert.equal(stops.length, 1, 'each turn closes once');
  assert.deepEqual(stops[0].input, { session_id: 'session-1' });
  assert.equal(stops[0].detached, true);
  assert.deepEqual(stops[0].args.slice(-2), ['--timeout-ms', '5000']);

  await host.preStep({ agentSession: first, turn: 2 });
  host.turnEnd(first, 2, 'error');
  await host.preStep({ agentSession: first, turn: 3 });
  host.turnEnd(first, 2);
  host.turnEnd(first, 3, 'cancelled');
  await settle();
  assert.equal(hook.runs.filter((call) => eventOf(call) === 'stop').length, 1);
  await host.dispose();
});

test('FULI not answering adds one line for the turn; a broken hook or host never breaks the step', async () => {
  const silent = dsh();
  fuliDshPlugin(CONFIG, recordingHook({ prompt: { cause: 'no answer within 11500 ms' } })).apply(silent.ctx);
  const decision = await silent.preStep();
  assert.match(decision.messages[1].content[0].text, /^Fuli context is unavailable \(no answer within 11500 ms\)\./);

  const broken = dsh();
  fuliDshPlugin(CONFIG, { runHook: async () => { throw new Error('boom'); } }).apply(broken.ctx);
  assert.match((await broken.preStep()).messages[1].content[0].text, /^Fuli context is unavailable/);
  broken.listeners['session/event'].listener(null, null);

  const aborted = dsh();
  const controller = new AbortController();
  fuliDshPlugin(CONFIG, recordingHook({ prompt: () => { controller.abort(); return { context: 'late' }; } })).apply(aborted.ctx);
  assert.equal((await aborted.preStep({ signal: controller.signal })).messages.length, 1, 'a cancelled step gets nothing');
});

test('the bundle binds this installation to the packaged plugin and starts FULI\'s MCP server as `dsh`', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = { nodePath: process.execPath, mcpServerPath: fileURLToPath(new URL('../../../src/mcp-server.js', import.meta.url)),
    runtimeConfigPath: '/data/graph-runtime.json' };
  const files = dshBundleFiles(context);
  assert.deepEqual(Object.keys(files).sort(), ['cordis.patch.yml', 'index.js', 'package.json']);

  const manifest = JSON.parse(files['package.json']);
  assert.equal(manifest.name, 'fuli-dsh');
  assert.equal(manifest.main, 'index.js');
  assert.deepEqual(manifest.dsh, { bundle: { patch: './cordis.patch.yml' } });

  const patch = files['cordis.patch.yml'].split('\n').filter((line) => line.startsWith('    - '))
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(patch[0], { id: 'fuli', name: 'fuli-dsh' });
  assert.deepEqual(patch[1], { id: 'fuli-mcp', name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'stdio',
    serverName: 'fuli', command: process.execPath, args: [context.mcpServerPath, '--runtime-config', '/data/graph-runtime.json',
      '--source-application', 'dsh', '--tool-profile', 'chat'] } });

  const directory = path.join(root, 'bundle');
  mkdirSync(directory);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(directory, name), text);
  const loaded = await import(pathToFileURL(path.join(directory, 'index.js')).href);
  assert.equal(loaded.name, 'fuli');
  assert.deepEqual(loaded.inject, ['agents']);
  assert.equal(typeof loaded.apply, 'function');
  assert.match(readFileSync(path.join(directory, 'index.js'), 'utf8'), /"hookPath": ".*lifecycle-hook\.js"/);
});
