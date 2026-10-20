// rec#5 C3, C4-3 and C5: "这次别记" pauses automatic recording of one host session.
// Synthetic fixtures only (test/fixtures/capture-project-fixture.js): temporary
// directories, a recording Provider double and the in-memory task registry. No FULI
// data directory, live Provider, port-2727 service or client configuration is used.
import assert from 'node:assert/strict';
import { appendFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { callAgentTool } from '../src/agent-tools.js';
import { captureDecision } from '../src/graphiti/capture-decision.js';
import { captureWindow } from '../src/conversations/capture-window.js';
import { sessionCapturePausePathForRuntime } from '../src/graphiti/capture-session-pause.js';
import { openFederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { normalizeAgentSessionInput } from '../src/mcp/session-id.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { prepareDirectAgentToolCall } from '../src/mcp/direct-call.js';
import { claudeEntry, codexEntry, codexStop, cursorEntry, finishTask, fixture, PRIVATE, receiptOf,
  transcriptRow } from './fixtures/capture-project-fixture.js';

const PAUSED_AT = '2026-10-20T06:32:00.000Z';
const pad = value => String(value).padStart(2, '0');
// The receipt shows the pause in the machine's local time.
const PAUSED = `本会话已暂停记录（自 ${pad(new Date(PAUSED_AT).getHours())}:${pad(new Date(PAUSED_AT).getMinutes())} 起）`;
const UNREADABLE = '记录设置读取失败，本次未自动记录';
const SESSION = 'synthetic-codex-session';

// The Agent's call on "接下来这段别记了" / "好了，继续记吧". The MCP layer names the
// client; the session comes from the task the host bound, never from the model.
function setPaused(f, context, sessionPaused, sourceApplication = 'codex') {
  return callAgentTool(f.app, 'update_capture_policy', { sessionPaused, taskContextToken: context.taskContextToken,
    sourceApplication });
}

const captureShape = value => [value.route, value.reason, value.layer];
const lastNotice = receipt => receipt.split(' · ').at(-1);

// A Codex session whose native transcript the Stop hook imports, as the real hook does.
async function transcriptSession(f, session = 'synthetic-transcript-session') {
  const transcriptPath = join(f.root, `${session}.jsonl`);
  await writeFile(transcriptPath, `${JSON.stringify({ type: 'session_meta', payload: { id: session } })}\n`);
  f.app.personal.currentTaskContext = async query => ({ token: `fuli-task-${query.session_id}`,
    project_agent_id: 'lead-novel', personal_project_id: 'novel' });
  const task = f.app.taskContextRegistry.begin({ sessionId: session, personalProjectId: 'novel',
    projectAgentId: 'lead-novel', sourceApplication: 'codex' });
  const input = { session_id: session, cwd: f.dirs.novel, transcript_path: transcriptPath };
  await codexStop(f, input);
  return { input, context: { taskContextToken: task.token },
    say: text => appendFile(transcriptPath, transcriptRow(text)), stop: () => codexStop(f, input) };
}

const imported = f => f.captureWrites().filter(write => write.kind === 'conversation').map(write => write.content).join(' | ');

test('C3-1 C4-3 C5 one sentence pauses this session at once; later turns record nothing, earlier ones stay', async (t) => {
  const f = await fixture(t);
  const first = await codexEntry(f, f.dirs.novel, { prompt: 'Outline chapter one.' });
  await finishTask(f, first.context);
  const earlier = structuredClone(f.captureWrites());
  assert.ok(earlier.some(write => write.kind === 'knowledge'), 'the session was being recorded');

  f.clock.now = PAUSED_AT;
  const paused = await setPaused(f, first.context, true);
  assert.equal(paused.status, 'session_paused');
  assert.equal(paused.since, PAUSED_AT);
  assert.equal(lastNotice(receiptOf(paused)), `${PAUSED}；你明确提交的修改仍会保存`, 'no confirmation, just the receipt');

  for (let turn = 0; turn < 3; turn += 1) {
    const entry = await codexEntry(f, f.dirs.novel, { prompt: `Turn ${turn}: ${PRIVATE}.` });
    assert.ok(lastNotice(receiptOf(entry.context)).startsWith(PAUSED), `every turn says so (C5-1): ${receiptOf(entry.context)}`);
    assert.ok(entry.output.systemMessage.includes(PAUSED), 'the hook says it at entry too');
    const checkpoint = await finishTask(f, entry.context);
    assert.equal(checkpoint.capture_status, 'capture_disabled', 'no knowledge or preference evidence');
    assert.ok(lastNotice(receiptOf(checkpoint)).startsWith(PAUSED));
    assert.equal(JSON.stringify([entry.context.agent_receipt, checkpoint.agent_receipt]).includes(PRIVATE), false);
  }
  const usage = await callAgentTool(f.app, 'record_knowledge_usage', { sourceApplication: 'codex', sessionId: SESSION,
    personalProjectId: 'novel', items: [] });
  assert.deepEqual([usage.route, usage.reason, usage.layer], ['disabled', 'session_paused', 'session']);
  const policy = await callAgentTool(f.app, 'get_capture_policy', { sourceApplication: 'codex', sessionId: SESSION,
    projectPath: f.dirs.novel });
  assert.deepEqual([policy.current.captured, policy.current.reason, policy.current.pausedSince], [false, 'session_paused', PAUSED_AT]);
  assert.deepEqual(f.captureWrites(), earlier, 'nothing new is written and nothing earlier is removed');
});

test('C3-1 C3-2 paused native turns are never imported, and recording resumes from the resuming turn', async (t) => {
  const f = await fixture(t);
  const s = await transcriptSession(f);
  await s.say('turn-before');
  await s.stop();
  await setPaused(f, s.context, true);
  await s.say(`turn-while-paused ${PRIVATE}`);
  await s.stop();
  assert.match(imported(f), /\[Not recorded: automatic recording was off \(session_paused\)/, 'a content-free marker');

  const resumed = await setPaused(f, s.context, false);
  assert.equal(resumed.status, 'session_resumed');
  assert.doesNotMatch(receiptOf(resumed), /暂停/);
  // The resuming turn's own prompt was written while paused.
  await s.say(`resuming turn ${PRIVATE}`);
  await s.stop();
  await s.say('turn-after');
  await s.stop();
  assert.match(imported(f), /turn-before/);
  assert.match(imported(f), /turn-after/);
  assert.equal(imported(f).includes(PRIVATE), false, 'the paused stretch is never backfilled');
});

test('C3-2 a pause and resume no hook saw still never backfills the paused stretch', async (t) => {
  const f = await fixture(t);
  const s = await transcriptSession(f);
  await setPaused(f, s.context, true);
  await s.say(`turn-while-paused ${PRIVATE}`);
  await setPaused(f, s.context, false);
  await s.stop();
  await s.say('turn-after');
  await s.stop();
  assert.equal(imported(f).includes(PRIVATE), false);
  assert.match(imported(f), /\[Not recorded: automatic recording was off \(session_paused\)/, 'the pause call kept it in the ledger');
  assert.match(imported(f), /turn-after/);
});

test('C3-3 pausing one session leaves another session recording normally', async (t) => {
  const f = await fixture(t);
  const a = await transcriptSession(f, 'synthetic-session-a');
  const b = await transcriptSession(f, 'synthetic-session-b');
  await b.say('b-before');
  await b.stop();
  await setPaused(f, a.context, true);
  await a.say(`a-paused ${PRIVATE}`);
  await a.stop();
  await b.say('b-after');
  await b.stop();
  assert.equal(imported(f).includes(PRIVATE), false);
  assert.match(imported(f), /b-before/);
  assert.match(imported(f), /b-after/);
  assert.doesNotMatch(imported(f), /capture settings changed/, 'the other session is not even unattributable');

  const other = await codexEntry(f, f.dirs.novel, { session: 'synthetic-other-session' });
  assert.doesNotMatch(receiptOf(other.context), /暂停/);
  const before = f.knowledge.length;
  await finishTask(f, other.context);
  assert.ok(f.knowledge.length > before, 'the other session still records knowledge');
});

test('C3-4 a session closed while paused leaves the next session recording without a pause', async (t) => {
  const f = await fixture(t);
  const yesterday = await codexEntry(f, f.dirs.novel, { session: 'synthetic-yesterday' });
  await setPaused(f, yesterday.context, true);
  f.clock.now = '2026-10-21T09:00:00.000Z';
  const today = await codexEntry(f, f.dirs.novel, { session: 'synthetic-today' });
  assert.doesNotMatch(receiptOf(today.context), /暂停/);
  const before = f.knowledge.length;
  await finishTask(f, today.context);
  assert.ok(f.knowledge.length > before);
});

async function pauseRecord(f) {
  const directory = sessionCapturePausePathForRuntime(f.runtimeConfigPath);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  return join(directory, files[0]);
}

test('C3-5 a removed pause record means the latest readable state, and its stretch is still not imported', async (t) => {
  const f = await fixture(t);
  const s = await transcriptSession(f);
  await setPaused(f, s.context, true);
  // The paused turn ends: its Stop hook keeps the denial for this session.
  await s.say(`turn-while-paused ${PRIVATE}`);
  await s.stop();
  await s.say(`turn-after-removal ${PRIVATE}`);
  await rm(await pauseRecord(f));
  await s.stop();
  await s.say('turn-after');
  await s.stop();
  assert.equal(imported(f).includes(PRIVATE), false, 'an uncertain stretch is skipped');
  assert.match(imported(f), /turn-after/, 'then the session records per its settings again');
});

test('C3-5 a pause record that cannot be read records nothing and says why', async (t) => {
  const f = await fixture(t);
  const s = await transcriptSession(f);
  await setPaused(f, s.context, true);
  await writeFile(await pauseRecord(f), '{ not json');
  await s.say(`turn-unknown ${PRIVATE}`);
  await s.stop();
  assert.equal(imported(f).includes(PRIVATE), false);
  assert.deepEqual(await captureDecision(f.app, { sourceApplication: 'codex', sessionId: s.input.session_id }),
    { allowed: false, reason: 'policy_unavailable', layer: 'session' });
  const entry = await codexEntry(f, f.dirs.novel, { session: s.input.session_id });
  assert.ok(lastNotice(receiptOf(entry.context)).startsWith(UNREADABLE), receiptOf(entry.context));
  const before = f.knowledge.length;
  assert.equal((await finishTask(f, entry.context)).capture_status, 'capture_disabled');
  assert.equal(f.knowledge.length, before);
});

test('C3-6 a worker session started by a paused session records nothing, whenever the pause came', async (t) => {
  const f = await fixture(t);
  const parent = await codexEntry(f, f.dirs.novel, { session: 'synthetic-parent' });
  const decide = session => captureDecision(f.app, { sourceApplication: 'codex', sessionId: session });
  // The worker host links each worker session to the session that started it.
  f.sessionPauses.link('synthetic-worker-1', 'synthetic-parent');
  assert.equal((await decide('synthetic-worker-1')).allowed, true);
  await setPaused(f, parent.context, true);
  f.sessionPauses.link('synthetic-worker-2', 'synthetic-parent');
  f.sessionPauses.link('synthetic-worker-2-child', 'synthetic-worker-2');
  for (const worker of ['synthetic-worker-1', 'synthetic-worker-2', 'synthetic-worker-2-child']) {
    assert.deepEqual(await decide(worker), { allowed: false, reason: 'session_paused', layer: 'session', since: '2026-10-20T08:00:00.000Z' },
      worker);
  }
  // A worker's own task cannot resume what its parent paused.
  const worker = f.app.taskContextRegistry.begin({ sessionId: 'synthetic-worker-1', personalProjectId: 'novel',
    projectAgentId: 'lead-novel', sourceApplication: 'codex' });
  await setPaused(f, { taskContextToken: worker.token }, false);
  assert.equal((await decide('synthetic-worker-1')).reason, 'session_paused');
  await setPaused(f, parent.context, false);
  assert.equal((await decide('synthetic-worker-2-child')).allowed, true);
});

test('a capture that started before the pause and writes after it writes nothing', async (t) => {
  const f = await fixture(t);
  const s = await transcriptSession(f);
  await s.say(`turn-in-flight ${PRIVATE}`);
  // Hold the Stop hook's sync at its session read, after the hook decided to
  // capture and before it writes; the person pauses meanwhile.
  const conversation = f.app.personal.conversation;
  let held = false;
  f.app.personal.conversation = async (operation, input, options) => {
    if (!held && operation === 'query' && input.mode === 'session') {
      held = true;
      await setPaused(f, s.context, true);
    }
    return conversation(operation, input, options);
  };
  await s.stop();
  assert.equal(held, true, 'the capture was in flight when the pause landed');
  assert.equal(imported(f).includes(PRIVATE), false, 'its write was refused');
  f.app.personal.conversation = conversation;
  await setPaused(f, s.context, false);
  await s.stop();
  await s.say('turn-after');
  await s.stop();
  assert.equal(imported(f).includes(PRIVATE), false, 'and it is not imported after the resume either');
  assert.match(imported(f), /turn-after/);
});

test('C4-5 Claude Code, Codex and Cursor pause the same way and say the same thing', async (t) => {
  const f = await fixture(t);
  const entries = { claude_code: await claudeEntry(f, f.dirs.novel), codex: await codexEntry(f, f.dirs.novel),
    cursor: await cursorEntry(f, f.dirs.novel) };
  for (const [client, entry] of Object.entries(entries)) {
    assert.equal(lastNotice(receiptOf(await setPaused(f, entry.context, true, client))).startsWith('本会话已暂停记录'), true, client);
  }
  const again = { claude_code: await claudeEntry(f, f.dirs.novel), codex: await codexEntry(f, f.dirs.novel),
    cursor: await cursorEntry(f, f.dirs.novel) };
  const notices = Object.entries(again).map(([client, entry]) => [client, lastNotice(receiptOf(entry.context))]);
  assert.equal(new Set(notices.map(([, notice]) => notice)).size, 1, JSON.stringify(notices));
  for (const [client, entry] of Object.entries(again)) await finishTask(f, entry.context, client);
  assert.equal(f.knowledge.length, 0);
});

test('a pause changes only the session and never rides along with a long-term change', async (t) => {
  const f = await fixture(t);
  const entry = await codexEntry(f, f.dirs.novel);
  await assert.rejects(callAgentTool(f.app, 'update_capture_policy', { sessionPaused: true, enabled: false,
    taskContextToken: entry.context.taskContextToken, sourceApplication: 'codex' }), /long-term settings/);
  await assert.rejects(callAgentTool(f.app, 'update_capture_policy', { sessionPaused: true, sourceApplication: 'codex' }),
    /taskContextToken/);
  await assert.rejects(setPaused(f, entry.context, true, 'cursor'), /unknown|superseded/i,
    'a token of another client does not pause this session');
  assert.equal(f.app.getCapturePolicy().enabled, true);
  assert.equal((await captureDecision(f.app, { sourceApplication: 'codex', sessionId: SESSION })).allowed, true);
  // The client is the MCP process's, never the payload's.
  assert.equal(normalizeAgentSessionInput('update_capture_policy', { sessionPaused: true, sourceApplication: 'cursor' },
    null, 'host-session', () => new Date(), 'codex').sourceApplication, 'codex');
});

test('C3-5 a pause record removed before any hook ran still keeps the paused stretch out', async (t) => {
  const f = await fixture(t);
  const s = await transcriptSession(f);
  await s.say('turn-before');
  await s.stop();
  await setPaused(f, s.context, true);
  await s.say(`turn-while-paused ${PRIVATE}`);
  await rm(await pauseRecord(f));
  await s.stop();
  await s.say('turn-after');
  await s.stop();
  assert.equal(imported(f).includes(PRIVATE), false, 'the pause call kept the stretch out in the session ledger first');
  assert.match(imported(f), /\[Not recorded: automatic recording was off \(session_paused\)/);
  assert.match(imported(f), /turn-after/);
});

test('C3-5 pause, removed record and resume with no hook in between never import the paused stretch', async (t) => {
  const f = await fixture(t);
  const s = await transcriptSession(f);
  await setPaused(f, s.context, true);
  await s.say(`turn-while-paused ${PRIVATE}`);
  await rm(await pauseRecord(f));
  assert.equal((await setPaused(f, s.context, false)).status, 'session_resumed');
  await s.stop();
  await s.say('turn-after');
  await s.stop();
  assert.equal(imported(f).includes(PRIVATE), false);
  assert.match(imported(f), /turn-after/);
});

test('a pause whose ledger entry cannot be kept does not pause and does not say it did', async (t) => {
  const f = await fixture(t);
  const entry = await codexEntry(f, f.dirs.novel);
  // The session ledgers' directory cannot be created.
  await writeFile(join(f.root, 'runtime', 'transcript-capture'), 'not a directory');
  const result = await setPaused(f, entry.context, true);
  assert.deepEqual([result.status, result.paused], ['unsaved', false]);
  assert.doesNotMatch(receiptOf(result), /暂停/);
  assert.match(result.guidance, /did not change/);
  const written = await readdir(sessionCapturePausePathForRuntime(f.runtimeConfigPath))
    .catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(written, [], 'the pause record was never written');
  assert.equal((await captureDecision(f.app, { sourceApplication: 'codex', sessionId: SESSION })).allowed, true);
});

test('both production compositions carry the session layer, so only test doubles lack it', async (t) => {
  const f = await fixture(t);
  const runtimeConfigPath = join(f.root, 'runtime', 'graph-runtime.json');
  await writeFile(runtimeConfigPath, JSON.stringify({ version: 1, workspaces: [], personal: {
    providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-token', principalId: 'synthetic-person',
    spaceId: 'synthetic-space' } }));
  const paused = await codexEntry(f, f.dirs.novel);
  assert.equal((await setPaused(f, paused.context, true)).status, 'session_paused');
  const opened = openFederatedGraphApplication({ runtimeConfigPath, env: {} });
  try {
    assert.equal(typeof opened.getSessionCapturePause, 'function');
    assert.equal(typeof opened.sessionTranscriptLedger('codex', SESSION)?.deny, 'function');
    // It reads the same runtime directory the fixture paused in.
    assert.equal(opened.getSessionCapturePause(SESSION).paused, true);
  } finally {
    await opened.close();
  }
  const port = await captureWindow(f.app, null, async window => window, { timeoutMs: 30_000 });
  assert.equal(typeof port.getSessionCapturePause, 'function');
  assert.equal(port.getSessionCapturePause(SESSION).paused, true);
});

test('C3-2 the resuming turn keeps its checkpoint, skips its own transcript and the next turn imports', async (t) => {
  const f = await fixture(t);
  const s = await transcriptSession(f);
  const entry = await codexEntry(f, f.dirs.novel, { session: s.input.session_id });
  await setPaused(f, entry.context, true);
  await s.say(`turn-while-paused ${PRIVATE}`);
  await s.stop();
  // "好了，继续记吧": the prompt is written while still paused, then the Agent resumes.
  const resuming = await codexEntry(f, f.dirs.novel, { session: s.input.session_id, prompt: 'Resume recording.' });
  await s.say('resuming-turn-words');
  await setPaused(f, resuming.context, false);
  const before = f.knowledge.length;
  const checkpoint = await finishTask(f, resuming.context);
  assert.notEqual(checkpoint.capture_status, 'capture_disabled');
  assert.ok(f.knowledge.length > before, 'the resuming turn records its knowledge');
  await s.stop();
  assert.doesNotMatch(imported(f), /resuming-turn-words/, 'its transcript was written while paused');
  await s.say('turn-after');
  await s.stop();
  assert.match(imported(f), /turn-after/);
  // The checkpoint's own work log is recorded; nothing from the paused transcript is.
  assert.doesNotMatch(imported(f), /turn-while-paused/);
});

// The MCP server an Agent's client starts, with the host session its environment names.
async function mcpCall(f, { env = {}, sourceApplication }, name, args) {
  const server = createMcpServer(f.app, { env, sourceApplication, registerResources: false });
  const client = new Client({ name: 'synthetic-session-pause', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result.structuredContent;
  } finally {
    await client.close();
    await server.close();
  }
}

const NATIVE = '0b4a0b9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const usage = (sessionId, taskContextToken) => ({ personalSpaceId: 'synthetic-space', taskId: 'synthetic-task',
  items: [{ itemId: 'synthetic-item', itemKind: 'entity', useKind: 'applied' }],
  ...(sessionId === undefined ? {} : { sessionId }), ...(taskContextToken ? { taskContextToken } : {}) });
const feedback = (sessionId, taskContextToken) => ({ personalSpaceId: 'synthetic-space', taskId: 'synthetic-task',
  items: [{ itemId: 'synthetic-item', itemKind: 'entity', feedbackKind: 'outdated', reason: `Stale ${PRIVATE}.`,
    evidenceSummary: `The ${PRIVATE} note changed.`, reportedByKind: 'agent' }],
  ...(sessionId === undefined ? {} : { sessionId }), ...(taskContextToken ? { taskContextToken } : {}) });

test('automatic evidence from a paused host session is refused whatever sessionId the model sends', async (t) => {
  const f = await fixture(t);
  const recorded = [];
  f.app.recordKnowledgeUsage = async input => { recorded.push(input); return { status: 'recorded' }; };
  f.app.recordKnowledgeFeedback = async input => { recorded.push(input); return { status: 'recorded' }; };
  const entry = await codexEntry(f, f.dirs.novel, { session: NATIVE });
  await setPaused(f, entry.context, true);
  const host = { env: { CODEX_THREAD_ID: NATIVE }, sourceApplication: 'codex' };
  for (const sessionId of [undefined, null, 'synthetic-other-session']) {
    for (const [name, args] of [['record_knowledge_usage', usage(sessionId)], ['record_knowledge_feedback', feedback(sessionId)]]) {
      const result = await mcpCall(f, host, name, args);
      assert.deepEqual([result.route, result.reason, result.layer], ['disabled', 'session_paused', 'session'],
        `${name} with sessionId ${String(sessionId)}`);
    }
  }
  // The CLI path an Agent's shell uses binds the same host session.
  const direct = await prepareDirectAgentToolCall({ toolName: 'record_knowledge_usage', input: usage(),
    sourceApplication: 'codex', env: { CODEX_THREAD_ID: NATIVE } });
  assert.equal((await callAgentTool(f.app, 'record_knowledge_usage', direct.input, direct.requestContext)).reason,
    'session_paused');
  assert.deepEqual(recorded, []);
  await setPaused(f, entry.context, false);
  assert.equal((await mcpCall(f, host, 'record_knowledge_usage', usage())).status, 'recorded');
});

test('get_capture_policy in a paused session says so without the model passing a session', async (t) => {
  const f = await fixture(t);
  const entry = await codexEntry(f, f.dirs.novel, { session: NATIVE });
  f.clock.now = PAUSED_AT;
  await setPaused(f, entry.context, true);
  const policy = await mcpCall(f, { env: { CODEX_THREAD_ID: NATIVE }, sourceApplication: 'codex' }, 'get_capture_policy',
    { projectPath: f.dirs.novel });
  assert.deepEqual([policy.current.captured, policy.current.reason, policy.current.layer, policy.current.pausedSince],
    [false, 'session_paused', 'session', PAUSED_AT]);
  assert.ok(policy.current.notice.startsWith(PAUSED));
});

// rec#5 C3 review: only the session bound to a task token and the MCP host session can
// allow a write; a session the model names can only refuse one.
const SESSION_A = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const SESSION_B = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';
const SESSION_C = '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b';

// Window 1 started its MCP process in session A, then /clear moved it to B; window 2
// runs session C. After B pauses, hooks run again in the given order.
async function clearedWindow(t, hookOrder) {
  const f = await fixture(t);
  const recorded = [];
  f.app.recordKnowledgeUsage = async input => { recorded.push(input); return { status: 'recorded' }; };
  f.app.recordKnowledgeFeedback = async input => { recorded.push(input); return { status: 'recorded' }; };
  const tokens = {};
  for (const session of [SESSION_A, SESSION_B, SESSION_C]) {
    tokens[session] = (await codexEntry(f, f.dirs.novel, { session })).context.taskContextToken;
  }
  f.clock.now = PAUSED_AT;
  await setPaused(f, { taskContextToken: tokens[SESSION_B] }, true);
  for (const session of hookOrder) {
    tokens[session] = (await codexEntry(f, f.dirs.novel, { session, prompt: 'Another turn.' })).context.taskContextToken;
  }
  return { f, recorded, tokens, oldProcess: { env: { CODEX_THREAD_ID: SESSION_A }, sourceApplication: 'codex' } };
}

for (const [label, hookOrder] of [['window C last', [SESSION_C]], ['B then C', [SESSION_B, SESSION_C]],
  ['C then A', [SESSION_C, SESSION_A]]]) {
  test(`after /clear the old MCP process records no evidence without a token (${label})`, async (t) => {
    const { f, recorded, oldProcess } = await clearedWindow(t, hookOrder);
    for (const sessionId of [undefined, null, SESSION_A, SESSION_C, 'synthetic-random-session']) {
      for (const [name, args] of [['record_knowledge_usage', usage(sessionId)], ['record_knowledge_feedback', feedback(sessionId)]]) {
        const result = await mcpCall(f, oldProcess, name, args);
        assert.equal(result.route, 'disabled', `${name} with sessionId ${String(sessionId)}`);
      }
    }
    assert.deepEqual(recorded, []);
  });
}

test('after /clear the paused session token is refused in the old MCP process', async (t) => {
  const { f, recorded, tokens, oldProcess } = await clearedWindow(t, [SESSION_C]);
  for (const [name, args] of [['record_knowledge_usage', usage(null, tokens[SESSION_B])],
    ['record_knowledge_feedback', feedback(SESSION_A, tokens[SESSION_B])]]) {
    assert.deepEqual(captureShape(await mcpCall(f, oldProcess, name, args)), ['disabled', 'session_paused', 'session'], name);
  }
  const policy = await mcpCall(f, oldProcess, 'get_capture_policy', { projectPath: f.dirs.novel, taskContextToken: tokens[SESSION_B] });
  assert.deepEqual([policy.current.reason, policy.current.pausedSince], ['session_paused', PAUSED_AT]);
  assert.deepEqual(recorded, []);
});

test('C3-3 an unpaused session token records while another session is paused, and says it is not paused', async (t) => {
  const { f, recorded, tokens, oldProcess } = await clearedWindow(t, [SESSION_C]);
  assert.equal((await mcpCall(f, oldProcess, 'record_knowledge_usage', usage(undefined, tokens[SESSION_A]))).status, 'recorded');
  const policy = await mcpCall(f, oldProcess, 'get_capture_policy', { projectPath: f.dirs.novel, taskContextToken: tokens[SESSION_A] });
  assert.deepEqual([policy.current.captured, policy.current.reason, policy.current.pausedSince], [true, null, undefined]);
  const windowC = { env: { CODEX_THREAD_ID: SESSION_C }, sourceApplication: 'codex' };
  assert.equal((await mcpCall(f, windowC, 'record_knowledge_feedback', feedback(undefined, tokens[SESSION_C]))).status, 'recorded');
  assert.equal(recorded.length, 2);
});

test('a client without a native session: while one of its sessions is paused only a task token records, and a named session never allows', async (t) => {
  const f = await fixture(t);
  const recorded = [];
  f.app.recordKnowledgeUsage = async input => { recorded.push(input); return { status: 'recorded' }; };
  const cursor = { sourceApplication: 'cursor' };
  const mine = await cursorEntry(f, f.dirs.novel, { session: 'synthetic-cursor-mine' });
  const paused = await cursorEntry(f, f.dirs.novel, { session: 'synthetic-cursor-paused' });
  assert.equal((await mcpCall(f, cursor, 'record_knowledge_usage', usage())).status, 'recorded', 'nothing is paused yet');
  await setPaused(f, paused.context, true, 'cursor');
  for (const sessionId of [undefined, null, 'synthetic-random-session']) {
    assert.deepEqual(captureShape(await mcpCall(f, cursor, 'record_knowledge_usage', usage(sessionId))),
      ['disabled', 'policy_unavailable', 'session'], String(sessionId));
  }
  assert.deepEqual(captureShape(await mcpCall(f, cursor, 'record_knowledge_usage',
    usage('synthetic-cursor-paused', mine.context.taskContextToken))), ['disabled', 'session_paused', 'session'],
  'a named paused session still refuses');
  assert.deepEqual(captureShape(await mcpCall(f, cursor, 'record_knowledge_usage', usage(undefined, paused.context.taskContextToken))),
    ['disabled', 'session_paused', 'session']);
  assert.equal((await mcpCall(f, cursor, 'record_knowledge_usage', usage(undefined, mine.context.taskContextToken))).status,
    'recorded', 'its own token keeps another session recording (C3-3)');
  assert.equal(recorded.length, 2);
});
