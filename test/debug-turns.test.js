import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-hook.js';
import { runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { isDebugPrompt } from '../src/debug-turns/trigger.js';
import { buildDebugRecord, DEBUG_RECORD_MAX_BYTES } from '../src/debug-turns/record.js';
import { recordDebugTurn } from '../src/debug-turns/recorder.js';
import { debugTurnStore } from '../src/debug-turns/store.js';
import { inspectLocalStores } from '../src/data-format/local-stores.js';

// Jevons 11-04: a prompt starting with #debug keeps that turn's full context
// for the person to read and changes nothing else. Synthetic sessions,
// Provider doubles and fixture transcripts in temp directories only.

const TOKEN = 'fuli-task-11111111-2222-4333-8444-555555555555';
const SECRET = 'sk-SYNTHETICabcdefghijklmnop';

async function dataDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-debug-turn-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  return directory;
}

// A Provider double for one session: capture is on and every import saves.
function provider(sourceApplication, sessionId) {
  const state = { cursor: 0 };
  return {
    config: { personal: { spaceId: 'synthetic-space' } }, getCapturePolicy: () => ({ enabled: true }),
    getCapturePolicyVersion: () => 'absent',
    taskContextRegistry: { current: async () => ({ token: TOKEN, sessionId, sourceApplication, checkpoint: { phase: 'complete' } }) },
    personal: {
      currentTaskContext: async () => ({ token: TOKEN, project_agent_id: 'engineer', personal_project_id: 'synthetic-project',
        session_id: sessionId, source_application: sourceApplication, personal_space_id: 'synthetic-space', entry_via: 'hook' }),
      conversation: async (operation, query) => {
        if (query.mode === 'policy') return { enabled: true };
        if (query.mode === 'session') return { initialized: true, cursor: state.cursor };
        if (Number.isSafeInteger(query.cursor)) state.cursor = query.cursor;
        return { status: 'saved', cursor: state.cursor };
      }
    }
  };
}

const callTool = async (_app, name) => {
  if (name === 'begin_task_context') {
    return { taskContextToken: TOKEN, checkpoint_required: false, checkpoint_guidance: { rules: 'fuli://rules/task-entry/checkpoint_guidance' },
      effective_preferences: [{ instruction: 'Synthetic preference.' }] };
  }
  if (name === 'verify_task_checkpoint') return { status: 'checkpointed' };
  return { status: 'saved' };
};

const CLIENTS = {
  claude_code: {
    sessionId: 'synthetic-claude-session',
    header: (sessionId) => ({ type: 'system', sessionId }),
    user: (sessionId, text) => ({ type: 'user', sessionId, message: { content: text } }),
    assistant: (sessionId, text) => ({ type: 'assistant', sessionId, message: { content: [{ type: 'text', text }] } }),
    summary: (sessionId, text) => ({ type: 'user', sessionId, isCompactSummary: true, message: { content: text } }),
    call: (sessionId, id, name, input) => ({ type: 'assistant', sessionId, message: { content: [{ type: 'tool_use', id, name, input }] } }),
    result: (sessionId, id, output) => ({ type: 'user', sessionId, message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } }),
    async hook(event, input, options) {
      return runClaudeLifecycleHook(['--event', event], { ...options, readInput: async () => input });
    }
  },
  codex: {
    sessionId: 'synthetic-codex-session',
    header: (sessionId) => ({ type: 'session_meta', payload: { id: sessionId } }),
    user: (_sessionId, text) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }),
    assistant: (_sessionId, text) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    summary: (_sessionId, text) => ({ type: 'compacted', payload: { message: text } }),
    call: (_sessionId, id, name, input) => ({ type: 'response_item', payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) } }),
    result: (_sessionId, id, output) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } }),
    async hook(event, input, options) {
      return runCodexLifecycleHook(['--event', event], { ...options, readInput: async () => input, write: () => {} });
    }
  }
};

// One synthetic turn through the installed hook: entry, the host's transcript, Stop.
async function hookTurn(t, client, prompt) {
  const directory = await dataDir(t);
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  const spec = CLIENTS[client];
  const { sessionId } = spec;
  const transcript = join(directory, 'transcript.jsonl');
  const line = (record) => `${JSON.stringify(record)}\n`;
  await writeFile(transcript, [spec.header(sessionId), spec.user(sessionId, 'An older question.'),
    spec.assistant(sessionId, 'An older answer.'), spec.summary(sessionId, 'Synthetic compaction summary.'),
    spec.user(sessionId, 'A question after compaction.'), spec.assistant(sessionId, 'An answer after compaction.')].map(line).join(''));
  const app = provider(client, sessionId);
  const options = { resolveRuntimeOptions: () => ({ runtimeConfigPath }), openApplication: () => app,
    createLeases: () => ({ withGraphLease: async (_owner, run) => run() }), captureTimeoutMs: 30_000, callTool };
  const base = { session_id: sessionId, cwd: '/synthetic/project', transcript_path: transcript };
  const entry = await spec.hook('UserPromptSubmit', { ...base, prompt }, options);
  await appendFile(transcript, [spec.user(sessionId, prompt),
    spec.call(sessionId, 'call-fuli', 'mcp__fuli__search_current_project_knowledge', { taskContextToken: TOKEN, queries: ['synthetic'] }),
    spec.result(sessionId, 'call-fuli', 'Synthetic recall.'),
    spec.call(sessionId, 'call-shell', 'Bash', { command: 'echo synthetic' }),
    spec.result(sessionId, 'call-shell', `synthetic output ${SECRET}`),
    spec.assistant(sessionId, 'Synthetic final answer.')].map(line).join(''));
  const stop = await spec.hook('Stop', { ...base, stop_hook_active: false, last_assistant_message: 'Synthetic final answer.' }, options);
  return { directory, entry, stop, store: debugTurnStore(directory) };
}

test('#debug is recognised only at the start, in any case, before a space, a line break or the end', () => {
  for (const prompt of ['#debug', '#debug x', '#DEBUG x', '#Debug\nx', '#debug\tx']) assert.equal(isDebugPrompt(prompt), true, prompt);
  for (const prompt of ['#debugx', ' #debug x', 'x #debug', 'debug x', '#debu', '', null]) assert.equal(isDebugPrompt(prompt), false, String(prompt));
});

for (const client of Object.keys(CLIENTS)) {
  test(`${client}: the hook output for "#debug x" equals the one for "x" apart from the prompt`, async (t) => {
    const plain = await hookTurn(t, client, 'Synthetic ask.');
    const debug = await hookTurn(t, client, '#debug Synthetic ask.');
    const withoutPrompt = (output) => JSON.stringify(output).replaceAll('#debug Synthetic ask.', 'Synthetic ask.');
    assert.equal(withoutPrompt(debug.entry), JSON.stringify(plain.entry));
    assert.equal(withoutPrompt(debug.stop), JSON.stringify(plain.stop));
    assert.deepEqual(plain.store.list(), [], 'an ordinary prompt records nothing');
    assert.equal(debug.store.list().length, 1);
  });

  test(`${client}: the record keeps every part in order with who put it there`, async (t) => {
    const { entry, stop, store } = await hookTurn(t, client, '#debug Synthetic ask.');
    const [summary] = store.list();
    const record = store.read(summary.id);
    assert.equal(record.sourceApplication, client);
    assert.equal(summary.promptLine, '#debug Synthetic ask.');
    assert.equal(record.transcript, 'read');
    const shape = record.parts.map(({ source, kind, label }) => [source, kind, label]);
    assert.deepEqual(shape.filter(([, kind]) => !['mcp_tools'].includes(kind)), [
      ['not_visible', 'system_prompt', ''],
      ['fuli', 'mcp_instructions', ''],
      ['host', 'history', '3'],
      ['person', 'prompt', ''],
      ['fuli', 'hook_frame', 'UserPromptSubmit'],
      ['fuli', 'tool_call', 'mcp__fuli__search_current_project_knowledge'],
      ['fuli', 'tool_result', 'mcp__fuli__search_current_project_knowledge'],
      ['host', 'tool_call', 'Bash'],
      ['host', 'tool_result', 'Bash'],
      ['ai', 'assistant_message', ''],
      ['fuli', 'hook_frame', 'Stop']
    ]);
    const part = (kind, label = '') => record.parts.find((item) => item.kind === kind && item.label === label);
    assert.ok(Number(record.parts.find((item) => item.kind === 'mcp_tools').label) > 0);
    // Masking touches token values only: the listed schemas still parse and name the field.
    const tools = JSON.parse(record.parts.find((item) => item.kind === 'mcp_tools').text);
    assert.equal(tools.find((tool) => tool.name === 'checkpoint_task_knowledge').inputSchema.properties.taskContextToken.type, 'string');
    // History is the window since the last compaction, as one part with its message count.
    assert.equal(part('history', '3').messages, 3);
    assert.match(part('history', '3').text, /Synthetic compaction summary\.[\s\S]*A question after compaction\.[\s\S]*An answer after compaction\./);
    assert.doesNotMatch(part('history', '3').text, /An older/);
    // A frame is the exact text the hook emitted, with the task token masked.
    const masked = (output) => JSON.stringify(output).replaceAll(TOKEN, '[redacted:task_context_token]');
    assert.equal(part('hook_frame', 'UserPromptSubmit').text, masked(entry));
    assert.equal(part('hook_frame', 'Stop').text, masked(stop));
    assert.doesNotMatch(JSON.stringify(record), new RegExp(`${TOKEN}|${SECRET}`));
    assert.match(part('tool_result', 'Bash').text, /\[redacted:api_key\]/);
    for (const item of record.parts) assert.equal(item.bytes, Buffer.byteLength(item.text), `${item.kind} bytes`);
    const sum = (source) => record.parts.filter((item) => item.source === source).reduce((total, item) => total + item.bytes, 0);
    assert.deepEqual(record.totals, { person: sum('person'), fuli: sum('fuli'), ai: sum('ai'), host: sum('host'), not_visible: sum('not_visible') });
    assert.deepEqual(summary.totals, record.totals);
  });
}

test('a host without a transcript gets a record that says so', async (t) => {
  const directory = await dataDir(t);
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  const input = { session_id: 'synthetic-session', prompt: '#debug no transcript' };
  const surface = async () => ({ instructions: 'Synthetic instructions.', tools: [] });
  await recordDebugTurn({ runtimeConfigPath, sourceApplication: 'cursor', event: 'UserPromptSubmit', input, output: { continue: true } }, { surface });
  await recordDebugTurn({ runtimeConfigPath, sourceApplication: 'cursor', event: 'Stop', input: { session_id: 'synthetic-session' }, output: {} }, { surface });
  const store = debugTurnStore(directory);
  const record = store.read(store.list()[0].id);
  assert.equal(record.transcript, 'not_supported');
  assert.match(record.parts.find((part) => part.kind === 'no_transcript').text, /This client gives FULI no transcript/);
  assert.equal(record.parts.find((part) => part.kind === 'no_transcript').source, 'not_visible');
  assert.equal(store.pending.read('cursor', 'synthetic-session'), null, 'the Stop ends the pending turn');
});

test('an ordinary prompt after an unfinished #debug turn drops it', async (t) => {
  const directory = await dataDir(t);
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  const at = (prompt) => ({ runtimeConfigPath, sourceApplication: 'codex', event: 'UserPromptSubmit',
    input: { session_id: 'synthetic-session', prompt }, output: {} });
  await recordDebugTurn(at('#debug first'));
  assert.ok(debugTurnStore(directory).pending.read('codex', 'synthetic-session'));
  await recordDebugTurn(at('second'));
  assert.equal(debugTurnStore(directory).pending.read('codex', 'synthetic-session'), null);
  await recordDebugTurn({ ...at(''), event: 'Stop' });
  assert.deepEqual(debugTurnStore(directory).list(), []);
});

test('redaction masks the shared secret patterns and every task token form', () => {
  const record = buildDebugRecord({ sourceApplication: 'codex', sessionId: 's', surface: null,
    prompt: `#debug password=hunter2-synthetic ${SECRET}`,
    frames: [{ event: 'UserPromptSubmit', text: JSON.stringify({ additionalContext: JSON.stringify({ taskContextToken: 'opaque-synthetic-token' }) }) }],
    transcript: { status: 'unavailable' },
    lastAssistantMessage: `Bearer abcdefghijklmnopqrstuvwxyz ${TOKEN}\n-----BEGIN PRIVATE KEY-----\nSYNTHETICKEYBODY\n-----END PRIVATE KEY-----` });
  const text = JSON.stringify(record);
  for (const leaked of ['hunter2', SECRET, 'opaque-synthetic-token', 'abcdefghijklmnopqrstuvwxyz', TOKEN, 'SYNTHETICKEYBODY']) {
    assert.equal(text.includes(leaked), false, leaked);
  }
  assert.match(text, /\[redacted:credential_assignment\]/);
  assert.match(text, /\[redacted:private_key\]/);
});

test('a record over 2 MB cuts the oldest history first and says how much', () => {
  const history = Array.from({ length: 3000 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', kind: 'message',
    content: `message ${index} ${'历史'.repeat(400)}` }));
  const record = buildDebugRecord({ sourceApplication: 'claude_code', sessionId: 's', surface: null, prompt: '#debug big',
    frames: [{ event: 'UserPromptSubmit', text: '{}' }], lastAssistantMessage: 'Synthetic answer.',
    transcript: { status: 'read', history, historyComplete: true, events: [] } });
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= DEBUG_RECORD_MAX_BYTES);
  const part = record.parts.find((item) => item.kind === 'history');
  assert.ok(record.cut.historyMessages > 0 && record.cut.historyMessages < 3000);
  assert.ok(record.cut.historyBytes > 0);
  assert.match(part.text, new RegExp(`^\\[${record.cut.historyMessages} earlier messages \\(${record.cut.historyBytes} bytes\\) were cut`));
  assert.match(part.text, /message 2999 /, 'the newest message stays');
  assert.doesNotMatch(part.text, /message 0 /);
  assert.equal(part.messages, 3000);
  assert.equal(record.parts.find((item) => item.kind === 'assistant_message').text, 'Synthetic answer.');

  // A turn too big even without history shortens its largest part.
  const huge = buildDebugRecord({ sourceApplication: 'codex', sessionId: 's', surface: null, prompt: '#debug huge',
    frames: [], lastAssistantMessage: '答'.repeat(1_000_000), transcript: { status: 'unavailable' } });
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= DEBUG_RECORD_MAX_BYTES);
  assert.deepEqual(huge.cut.parts, [huge.parts.findIndex((item) => item.kind === 'assistant_message')]);
});

test('the store keeps the newest 20 records within 50 MB, and its directories are registered', async (t) => {
  const directory = await dataDir(t);
  const store = debugTurnStore(directory);
  const at = (index) => new Date(Date.UTC(2026, 10, 4, 0, index));
  const ids = [];
  for (let index = 0; index < 23; index += 1) {
    const record = buildDebugRecord({ sourceApplication: 'codex', sessionId: 's', surface: null, prompt: `#debug ${index}`,
      frames: [], lastAssistantMessage: null, transcript: { status: 'unavailable' } }, { now: () => at(index) });
    ids.push(record.id);
    store.write(record);
  }
  assert.deepEqual(store.list().map(({ id }) => id), ids.slice(3).reverse());
  assert.equal((await readdir(join(directory, 'debug-turns'))).filter((name) => name.endsWith('.json')).length, 20);
  const big = (index) => buildDebugRecord({ sourceApplication: 'codex', sessionId: 's', surface: null, prompt: `#debug big ${index}`,
    frames: [], lastAssistantMessage: 'x'.repeat(1_900_000), transcript: { status: 'unavailable' } }, { now: () => at(100 + index) });
  for (let index = 0; index < 30; index += 1) store.write(big(index));
  const kept = store.list();
  assert.ok(kept.length < 30 && kept.length >= 20 - 1, `${kept.length} big records kept`);
  const bytes = await Promise.all(kept.map(({ id }) => readFile(join(directory, 'debug-turns', `${id}.json`)).then((file) => file.length)));
  assert.ok(bytes.reduce((total, size) => total + size, 0) <= 50 * 1024 * 1024);
  assert.equal(store.remove(kept[0].id), true);
  assert.equal(store.read(kept[0].id), null);
  assert.equal(store.remove('../graph-runtime'), false, 'an id is never a path');
  const labels = inspectLocalStores(directory).map(({ label, state }) => [label, state]);
  assert.deepEqual(labels.filter(([label]) => label.startsWith('debug-turns')), [['debug-turns', 'current'], ['debug-turns/pending', 'absent']]);
});

test('a record that cannot be written never changes or breaks the hook', async (t) => {
  const directory = await dataDir(t);
  // A file where the records' directory should be makes every write fail.
  await writeFile(join(directory, 'debug-turns'), 'not a directory');
  const lines = [];
  const recorded = await recordDebugTurn({ runtimeConfigPath: join(directory, 'graph-runtime.json'), sourceApplication: 'codex',
    event: 'UserPromptSubmit', input: { session_id: 's', prompt: '#debug fails' }, output: {} }, { log: (line) => lines.push(line) });
  assert.equal(recorded, undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^FULI: this #debug turn was not recorded \(/);
  assert.doesNotMatch(lines[0], /fails|debug-turns/);

  // Through the installed hook, the answer is the one an ordinary prompt gets.
  const transcript = join(directory, 'missing.jsonl');
  const run = (prompt) => runCodexLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => ({ session_id: 'synthetic-codex-session', cwd: '/synthetic/project', transcript_path: transcript, prompt }),
    write: () => {}, resolveRuntimeOptions: () => ({ runtimeConfigPath: join(directory, 'graph-runtime.json') }),
    openApplication: () => provider('codex', 'synthetic-codex-session'),
    createLeases: () => ({ withGraphLease: async (_owner, run) => run() }), captureTimeoutMs: 30_000, callTool });
  const original = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const debug = await run('#debug Synthetic ask.');
    const plain = await run('Synthetic ask.');
    assert.equal(JSON.stringify(debug).replaceAll('#debug Synthetic ask.', 'Synthetic ask.'), JSON.stringify(plain));
  } finally {
    process.stderr.write = original;
  }
});
