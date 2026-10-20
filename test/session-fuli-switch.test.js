// rec#5 C3b: the person's own /fuli start|stop|restart for one host session, and the
// default for new sessions. Synthetic fixtures only (test/fixtures/capture-project-fixture.js):
// temporary directories, a recording Provider double and the in-memory task registry. No FULI
// data directory, live Provider, port-2727 service or client configuration is used.
import assert from 'node:assert/strict';
import { appendFile, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { callAgentTool } from '../src/agent-tools.js';
import { runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { runCursorLifecycleHook } from '../src/agents/cursor/lifecycle-hook.js';
import { agentHostRequestContext } from '../src/app/agent-request-context.js';
import { parseSessionArguments, runSessionCommand } from '../src/cli/session-command.js';
import { captureDecision } from '../src/graphiti/capture-decision.js';
import { sessionCapturePausePathForRuntime } from '../src/graphiti/capture-session-pause.js';
import { requestSessionFuliDefault } from '../src/graphiti/session-fuli-switch.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { claudeEntry, codexEntry, codexStop, finishTask, fixture, PRIVATE, transcriptRow } from './fixtures/capture-project-fixture.js';

const STOPPED_AT = '2026-10-21T01:31:00.000Z';
const pad = value => String(value).padStart(2, '0');
const AT = `（自 ${pad(new Date(STOPPED_AT).getHours())}:${pad(new Date(STOPPED_AT).getMinutes())} 起）`;
const SESSION_A = '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d';
const SESSION_B = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
const SESSION_C = '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f';
const SESSION_D = '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const leases = () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => {} });

// The person types a FULI line in Codex; its prompt hook answers it.
async function codexLine(f, session, line) {
  const { output, context } = await codexEntry(f, f.dirs.novel, { session, prompt: line });
  assert.equal(context, undefined, 'a command line never starts a task');
  assert.equal(output.decision, 'block', 'and never reaches the model');
  return output.reason;
}

const host = session => ({ env: { CODEX_THREAD_ID: session }, sourceApplication: 'codex' });
const record = f => f.sessionPauses.state.bind(f.sessionPauses);

async function mcpCall(f, { env = {}, sourceApplication }, name, args) {
  const server = createMcpServer(f.app, { env, sourceApplication, registerResources: false });
  const client = new Client({ name: 'synthetic-session-switch', version: '1' });
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

test('C3b-1 sessions start with FULI on; with the default off a new session stays off until the person starts it', async (t) => {
  const f = await fixture(t);
  const open = await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  assert.ok(open.context.taskContextToken, 'on by default');
  assert.deepEqual(requestSessionFuliDefault(f.app, { newSessions: 'off' }).newSessions, 'off');

  // The window already open keeps the default it started under.
  assert.ok((await codexEntry(f, f.dirs.novel, { session: SESSION_A })).context.taskContextToken);
  const fresh = await codexEntry(f, f.dirs.novel, { session: SESSION_B });
  assert.equal(fresh.context, undefined, 'no memory, preferences or task token');
  assert.match(fresh.output.hookSpecificOutput.additionalContext, /not on for this session/);
  assert.ok(fresh.output.systemMessage.includes('本会话未启用 FULI（新会话默认不启用）'), fresh.output.systemMessage);
  const policy = await mcpCall(f, host(SESSION_B), 'get_capture_policy', { projectPath: f.dirs.novel });
  assert.deepEqual([policy.current.captured, policy.current.reason], [false, 'session_not_started']);
  assert.match(await codexLine(f, SESSION_B, 'fuli status'), /本会话未启用（新会话默认不启用）；新会话默认不启用/);

  assert.match(await codexLine(f, SESSION_B, 'fuli start'), /FULI 已在本会话启用/);
  const started = await codexEntry(f, f.dirs.novel, { session: SESSION_B });
  assert.ok(started.context.taskContextToken);
  // Both the default and this session's own switch can be read back.
  const described = await mcpCall(f, host(SESSION_B), 'get_capture_policy', { projectPath: f.dirs.novel,
    taskContextToken: started.context.taskContextToken });
  assert.deepEqual(described.current.fuli, { enabled: true, basis: 'session', since: '2026-10-20T08:00:00.000Z',
    recordingPaused: false, newSessions: 'off' });
  assert.equal(requestSessionFuliDefault(f.app, { newSessions: 'status' }).newSessions, 'off');
  // A session that started while the default was off stays off when the default turns on.
  assert.equal((await codexEntry(f, f.dirs.novel, { session: SESSION_D })).context, undefined);
  assert.equal(requestSessionFuliDefault(f.app, { newSessions: 'on' }).newSessions, 'on');
  assert.ok((await codexEntry(f, f.dirs.novel, { session: SESSION_C })).context.taskContextToken);
  assert.equal((await codexEntry(f, f.dirs.novel, { session: SESSION_D })).context, undefined);
  assert.equal((await mcpCall(f, host(SESSION_D), 'get_collaboration_preferences', { projectPath: f.dirs.novel,
    taskPrompt: 'Next task.' })).reason, 'session_not_started');
  assert.equal(f.app.hasStoppedSession(), true);
  // As with a pause (#245), evidence without a task token is refused for the client while one of
  // its sessions is off, since the call cannot be shown not to come from it.
  f.app.recordKnowledgeUsage = async () => ({ status: 'recorded' });
  const usage = () => mcpCall(f, host(SESSION_C), 'record_knowledge_usage', { personalSpaceId: 'synthetic-space',
    taskId: 'synthetic-task', items: [{ itemId: 'synthetic-item', itemKind: 'entity', useKind: 'applied' }] });
  assert.equal((await usage()).reason, 'policy_unavailable');
  await codexLine(f, SESSION_D, 'fuli start');
  assert.equal(f.app.hasStoppedSession(), false, 'no session is off any more, so calls skip the session check again');
  assert.equal((await usage()).status, 'recorded');
});

test('C3b-2 start, stop and restart answer the state they leave, never claim a failed change and repeat nothing', async (t) => {
  const f = await fixture(t);
  await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  f.clock.now = STOPPED_AT;
  assert.match(await codexLine(f, SESSION_A, 'fuli stop'), new RegExp(`^FULI: FULI 已在本会话停用${AT}：之后不再注入记忆`));
  const records = sessionCapturePausePathForRuntime(f.runtimeConfigPath);
  const recordPath = join(records, (await readdir(records)).find(name => /^[0-9a-f]{64}[.]json$/.test(name)));
  const stoppedRecord = await readFile(recordPath, 'utf8');
  assert.match(await codexLine(f, SESSION_A, 'fuli stop'), /已是停用状态.*未重复执行/);
  assert.equal(await readFile(recordPath, 'utf8'), stoppedRecord, 'a repeated stop writes nothing');

  assert.match(await codexLine(f, SESSION_A, 'fuli start'), /FULI 已在本会话启用.*停用期间的对话不会补录/);
  const startedRecord = await readFile(recordPath, 'utf8');
  assert.match(await codexLine(f, SESSION_A, 'fuli start'), /已是启用状态，未重复执行/);
  assert.equal(await readFile(recordPath, 'utf8'), startedRecord, 'a repeated start writes nothing');

  // restart also gives the next entry the full context again.
  const resets = [];
  f.app.preferenceDelivery = { reset: async origin => { resets.push(origin); },
    deliver: async (value, _origin, format) => format(value) };
  assert.match(await codexLine(f, SESSION_A, 'fuli restart'), /重新启用，下一轮重新提供完整上下文/);
  assert.deepEqual(resets, [{ sourceApplication: 'codex', nativeSessionId: SESSION_A }]);

  // A change that cannot be kept is not made and not claimed: the session ledgers' directory is gone for a file.
  await rm(join(f.root, 'runtime', 'transcript-capture'), { recursive: true, force: true });
  await writeFile(join(f.root, 'runtime', 'transcript-capture'), 'not a directory');
  assert.match(await codexLine(f, SESSION_A, 'fuli stop'), /未能保存本会话的启停状态，状态未改变（当前启用）/);
  assert.equal(record(f)(SESSION_A).stopped, false);
});

test('C3b-2 a model can neither start nor stop FULI: only the person\'s own line does', async (t) => {
  const f = await fixture(t);
  await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  await codexLine(f, SESSION_A, 'fuli stop');
  // The entry tools take the line as an ordinary prompt, and refuse the stopped session.
  const viaTool = await callAgentTool(f.app, 'begin_task_context', { sessionId: SESSION_A, projectPath: f.dirs.novel,
    taskPrompt: 'fuli start', sourceApplication: 'codex', sourceSessionId: SESSION_A });
  assert.deepEqual([viaTool.status, viaTool.reason], ['fuli_off', 'session_stopped']);
  const viaMcp = await mcpCall(f, host(SESSION_A), 'get_collaboration_preferences', { projectPath: f.dirs.novel,
    taskPrompt: '/fuli start' });
  assert.deepEqual([viaMcp.status, viaMcp.reason], ['fuli_off', 'session_stopped']);
  assert.equal(record(f)(SESSION_A).stopped, true);
  // A sentence that mentions the command is not the command.
  const sentence = await codexEntry(f, f.dirs.novel, { session: SESSION_B, prompt: 'Explain what fuli stop does.' });
  assert.ok(sentence.context.taskContextToken);
  assert.equal(record(f)(SESSION_B).stopped, false);
});

test('C3b-3 after stop the host session blocks new injection, automatic writes and collaboration, and children follow', async (t) => {
  const f = await fixture(t);
  const recorded = [];
  f.app.recordKnowledgeUsage = async input => { recorded.push(input); return { status: 'recorded' }; };
  const before = await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  const token = before.context.taskContextToken;
  f.clock.now = STOPPED_AT;
  await codexLine(f, SESSION_A, 'fuli stop');

  const entry = await codexEntry(f, f.dirs.novel, { session: SESSION_A, prompt: `Plan ${PRIVATE}.` });
  assert.equal(entry.context, undefined);
  assert.match(entry.output.hookSpecificOutput.additionalContext, /stopped for this session by the person/);
  assert.doesNotMatch(JSON.stringify(entry.output), new RegExp(PRIVATE));
  assert.ok(entry.output.systemMessage.includes(`本会话已停用 FULI${AT}，输入 /fuli start 可重新启用`), entry.output.systemMessage);

  // The host session decides, whatever session the model names.
  for (const sessionId of [undefined, 'synthetic-other-session']) {
    const preferences = await mcpCall(f, host(SESSION_A), 'get_collaboration_preferences', { projectPath: f.dirs.novel,
      taskPrompt: 'Next task.', ...(sessionId ? { sessionId } : {}) });
    assert.deepEqual([preferences.status, preferences.reason], ['fuli_off', 'session_stopped'], String(sessionId));
    assert.equal(preferences.effective_preferences, undefined);
  }
  // A session a model names can only refuse: another window naming this one is refused too.
  const named = await callAgentTool(f.app, 'get_collaboration_preferences', { projectPath: f.dirs.novel,
    taskPrompt: 'Next task.', sessionId: SESSION_A, sourceApplication: 'codex' }, agentHostRequestContext(null, SESSION_B));
  assert.equal(named.status, 'fuli_off');

  // The task token from before the stop records nothing and starts no collaboration.
  const checkpoint = await finishTask(f, { taskContextToken: token, context: before.context.context });
  assert.deepEqual([checkpoint.status, checkpoint.reason], ['fuli_off', 'session_stopped']);
  const usage = await mcpCall(f, host(SESSION_A), 'record_knowledge_usage', { personalSpaceId: 'synthetic-space',
    taskId: 'synthetic-task', items: [{ itemId: 'synthetic-item', itemKind: 'entity', useKind: 'applied' }] });
  assert.deepEqual([usage.status, usage.reason], ['fuli_off', 'session_stopped']);
  // Recording refuses on its own too, whatever path a write takes.
  assert.equal((await captureDecision(f.app, { sourceApplication: 'codex', boundSessionId: SESSION_A })).reason, 'session_stopped');
  for (const [name, input] of [['message_agent', { taskContextToken: token, sourceApplication: 'codex', to: 'project:novel', body: 'Help.' }],
    ['role_work', { action: 'claim', taskContextToken: token, sourceApplication: 'codex' }],
    ['coordinate_project_agent_task', { taskContextToken: token, sourceApplication: 'codex' }],
    ['plan_agent_collaboration', { sourceApplication: 'codex' }]]) {
    const refused = await callAgentTool(f.app, name, input, agentHostRequestContext(null, SESSION_A));
    assert.deepEqual([refused.status, refused.reason], ['fuli_off', 'session_stopped'], name);
  }
  assert.deepEqual(recorded, []);

  // A worker started by the stopped session is off too, and cannot be started on its own.
  f.sessionPauses.link('synthetic-worker', SESSION_A);
  assert.equal((await captureDecision(f.app, { sourceApplication: 'codex', sessionId: 'synthetic-worker' })).reason, 'session_stopped');
  const worker = await callAgentTool(f.app, 'get_collaboration_preferences', { projectPath: f.dirs.novel,
    taskPrompt: 'Worker task.', sessionId: 'synthetic-worker', sourceApplication: 'codex' });
  assert.equal(worker.status, 'fuli_off');
  const workerStart = await codexEntry(f, f.dirs.novel, { session: 'synthetic-worker', prompt: 'fuli start' });
  assert.match(workerStart.output.reason, /由已停用 FULI 的会话发起.*状态未改变/);
  assert.equal(record(f)('synthetic-worker').stopped, true);
});

// Fable review of #251: a read the model starts is injection too, so every tool that returns
// stored memory or preferences is refused for a stopped session, while another session and the
// person's own reads outside the session keep working.
const MEMORY_READS = [['search_knowledge_graph', { query: 'chapter' }], ['search_current_project_knowledge', { queries: ['chapter'] }],
  ['search_connected_knowledge', { query: 'chapter' }], ['get_knowledge_graph', {}], ['search_human_knowledge_changes', {}],
  ['get_project_agent_context', {}], ['get_project_agent_memory', {}], ['export_project_agent_memory', {}],
  ['read_agent_conversation', {}], ['list_agent_conversations', {}], ['list_preference_conflicts', {}],
  ['discover_personal_global_preference_candidates', {}], ['list_knowledge_review_candidates', {}],
  ['recommend_next_workflow_steps', {}], ['get_agent_handoff', {}], ['read_agent_messages', {}], ['list_personal_projects', {}]];

test('C3b-3 every memory read a model starts is refused for a stopped session, and only for it', async (t) => {
  const f = await fixture(t);
  await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  await codexEntry(f, f.dirs.novel, { session: SESSION_B });
  await codexLine(f, SESSION_A, 'fuli stop');
  for (const [name, input] of MEMORY_READS) {
    for (const context of [agentHostRequestContext(null, SESSION_A), null]) {
      const refused = await callAgentTool(f.app, name, { ...input, sourceApplication: 'codex', ...(context ? {} : { sessionId: SESSION_A }) },
        context);
      assert.deepEqual([refused?.status, refused?.reason], ['fuli_off', 'session_stopped'], `${name} ${context ? 'host' : 'named'}`);
    }
  }
  // Settings and the session's own lifecycle stay open, so the Agent can say why.
  const policy = await callAgentTool(f.app, 'get_capture_policy', { sourceApplication: 'codex' }, agentHostRequestContext(null, SESSION_A));
  assert.equal(policy.current.reason, 'session_stopped');
  // Another window, and the person's own read from the console or a terminal, still search.
  const read = { query: 'chapter', sourceApplication: 'codex' };
  for (const [context, input] of [[agentHostRequestContext(null, SESSION_B), read],
    [agentHostRequestContext(null, 'fuli-host-synthetic-terminal'), { ...read, sourceApplication: 'other' }], [null, read]]) {
    assert.ok(Array.isArray((await callAgentTool(f.app, 'search_knowledge_graph', input, context)).facts));
  }
});

// A Codex session whose native transcript the Stop hook imports, as the real hook does.
async function transcriptSession(f, session = SESSION_A) {
  const transcriptPath = join(f.root, `${session}.jsonl`);
  await writeFile(transcriptPath, `${JSON.stringify({ type: 'session_meta', payload: { id: session } })}\n`);
  f.app.personal.currentTaskContext = async query => ({ token: `fuli-task-${query.session_id}`,
    project_agent_id: 'lead-novel', personal_project_id: 'novel' });
  f.app.taskContextRegistry.begin({ sessionId: session, personalProjectId: 'novel', projectAgentId: 'lead-novel',
    sourceApplication: 'codex' });
  const input = { session_id: session, cwd: f.dirs.novel, transcript_path: transcriptPath };
  await codexStop(f, input);
  return { say: text => appendFile(transcriptPath, transcriptRow(text)), stop: () => codexStop(f, input) };
}

const imported = f => f.captureWrites().filter(write => write.kind === 'conversation').map(write => write.content).join(' | ');

test('C3b-4 restart imports nothing from the stopped stretch, and a capture in flight at the stop writes nothing after it', async (t) => {
  const f = await fixture(t);
  const s = await transcriptSession(f);
  await s.say('turn-before');
  await s.stop();
  await codexLine(f, SESSION_A, 'fuli stop');
  await s.say(`turn-while-stopped ${PRIVATE}`);
  await s.stop();
  await codexLine(f, SESSION_A, 'fuli restart');
  await s.stop();
  await s.say('turn-after');
  await s.stop();
  assert.match(imported(f), /turn-before/);
  assert.equal(imported(f).includes(PRIVATE), false, 'never backfilled');
  assert.match(imported(f), /\[Not recorded: automatic recording was off \(session_stopped\)/);
  assert.match(imported(f), /turn-after/);

  // Hold a Stop hook's sync after it decided to capture; the person stops FULI meanwhile.
  await s.say(`turn-in-flight ${PRIVATE}`);
  const conversation = f.app.personal.conversation;
  let held = false;
  f.app.personal.conversation = async (operation, input, options) => {
    if (!held && operation === 'query' && input.mode === 'session') {
      held = true;
      await codexLine(f, SESSION_A, 'fuli stop');
    }
    return conversation(operation, input, options);
  };
  await s.stop();
  assert.equal(held, true);
  assert.equal(imported(f).includes(PRIVATE), false, 'the late write was refused');
});

test('C3b-4 the switch answers say what a stop cannot undo and who else can turn it', async (t) => {
  const f = await fixture(t);
  const answer = await codexLine(f, SESSION_A, 'fuli stop');
  assert.match(answer, /已在运行的动作不会被撤回，它之后的结果不再自动记录或触发协作/);
  assert.match(answer, /其他会话、全局服务和已有记忆不受影响/);
  for (const line of ['fuli stop', 'fuli status', 'fuli start', 'fuli start', 'fuli restart', 'fuli status']) {
    const reply = await codexLine(f, SESSION_A, line);
    assert.match(reply, /停用不会撤回已发给模型的上下文，需要完全隔离请新开会话/, line);
    assert.match(reply, /能运行 shell 的 Agent 也能执行 `fuli session …` 改变这个开关，与它能读写本地文件属同等信任/, line);
  }
  assert.match(answer, /能运行 shell 的 Agent 也能执行/);
});

test('C3b-5 one session stopping leaves another alone, a new session neither inherits nor loses state', async (t) => {
  const f = await fixture(t);
  await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  await codexEntry(f, f.dirs.novel, { session: SESSION_B });
  await codexLine(f, SESSION_A, 'fuli stop');
  const other = await codexEntry(f, f.dirs.novel, { session: SESSION_B });
  assert.ok(other.context.taskContextToken, 'B keeps its memory');
  assert.notEqual((await finishTask(f, other.context)).capture_status, 'capture_disabled', 'and keeps recording');
  assert.notEqual((await mcpCall(f, host(SESSION_B), 'get_collaboration_preferences', { projectPath: f.dirs.novel,
    taskPrompt: 'B task.' })).status, 'fuli_off');

  // /clear gives the window a new session: it starts under the default and A stays stopped.
  const cleared = await codexEntry(f, f.dirs.novel, { session: SESSION_C });
  assert.ok(cleared.context.taskContextToken);
  assert.equal((await codexEntry(f, f.dirs.novel, { session: SESSION_A })).context, undefined);
  // An MCP process still bound to the stopped A refuses C's writes as a stale binding, not as C's stop.
  const usage = await mcpCall(f, host(SESSION_A), 'record_knowledge_usage', { personalSpaceId: 'synthetic-space',
    taskId: 'synthetic-task', items: [{ itemId: 'synthetic-item', itemKind: 'entity', useKind: 'applied' }],
    taskContextToken: cleared.context.taskContextToken });
  assert.deepEqual([usage.status, usage.reason], ['fuli_off', 'session_binding_stale']);
});

test('C3b-5 a switch state that cannot be read records nothing and serves nothing', async (t) => {
  const f = await fixture(t);
  await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  requestSessionFuliDefault(f.app, { newSessions: 'on' });
  await writeFile(join(sessionCapturePausePathForRuntime(f.runtimeConfigPath), 'default.json'), '{ not json');
  assert.deepEqual(await captureDecision(f.app, { sourceApplication: 'codex', sessionId: SESSION_B }),
    { allowed: false, reason: 'policy_unavailable', layer: 'session' });
  const entry = await codexEntry(f, f.dirs.novel, { session: SESSION_B });
  assert.equal(entry.context, undefined);
  assert.match(entry.output.hookSpecificOutput.additionalContext, /could not confirm it is on/);
  assert.match(await codexLine(f, SESSION_B, 'fuli start'), /无法读取本会话的启停状态，本会话不会自动记录/);
  assert.equal(requestSessionFuliDefault(f.app, { newSessions: 'status' }).status, 'unavailable');
});

test('C3b-6 start never lifts a stricter pause, client, project or global setting', async (t) => {
  const f = await fixture(t);
  const entry = await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  await callAgentTool(f.app, 'update_capture_policy', { sessionPaused: true, taskContextToken: entry.context.taskContextToken,
    sourceApplication: 'codex' });
  await codexLine(f, SESSION_A, 'fuli stop');
  assert.match(await codexLine(f, SESSION_A, 'fuli start'), /FULI 已在本会话启用.*自动记录仍未开启：本会话已暂停记录/);
  assert.equal(record(f)(SESSION_A).paused, true, 'the pause stays until the person resumes it');

  f.app.updateCapturePolicy({ enabled: false });
  assert.match(await codexLine(f, SESSION_A, 'fuli restart'), /自动记录仍未开启：自动记录已关闭/);
  const next = await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  assert.ok(next.context.taskContextToken, 'FULI serves the session');
  assert.equal((await finishTask(f, next.context)).capture_status, 'capture_disabled', 'and still records nothing');
  assert.equal(f.app.getCapturePolicy().enabled, false);
});

test('Claude Code, Codex and Cursor take the same line and answer it in their own format', async (t) => {
  const f = await fixture(t);
  const claude = await claudeEntry(f, f.dirs.novel, { session: SESSION_A, prompt: '/fuli stop' });
  assert.deepEqual([claude.context, claude.output.decision], [undefined, 'block']);
  assert.match(claude.output.reason, /FULI 已在本会话停用/);
  assert.match(await codexLine(f, SESSION_B, '$fuli stop'), /FULI 已在本会话停用/);
  const cursor = await runCursorLifecycleHook(['--event', 'beforeSubmitPrompt'], {
    readInput: async () => ({ conversation_id: 'synthetic-cursor', workspace_roots: [f.dirs.novel], prompt: '  /FULI Stop ' }),
    write: () => {}, resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases });
  assert.equal(cursor.continue, false);
  assert.match(cursor.user_message, /^FULI: FULI 已在本会话停用/);
  for (const [session, client] of [[SESSION_A, 'claude_code'], [SESSION_B, 'codex'], ['synthetic-cursor', 'cursor']]) {
    assert.equal((await captureDecision(f.app, { sourceApplication: client, sessionId: session })).reason, 'session_stopped', client);
  }
  // Cursor's own entry call is refused for that conversation.
  const cursorEntry = await callAgentTool(f.app, 'get_collaboration_preferences', { projectPath: f.dirs.novel,
    taskPrompt: 'Next.', sessionId: 'synthetic-cursor', sourceApplication: 'cursor' });
  assert.equal(cursorEntry.status, 'fuli_off');
});

test('fuli session acts only for the client session it runs in', async (t) => {
  const f = await fixture(t);
  f.app.close = async () => {};
  const lines = [];
  const run = (args, env) => runSessionCommand(args, { env, cwd: f.dirs.novel, write: line => lines.push(line),
    openApplication: () => f.app, createLeases: leases });
  assert.deepEqual(await run(['stop'], { CLAUDE_CODE_SESSION_ID: SESSION_A }), { exitCode: 0 });
  assert.match(lines.at(-1), /FULI 已在本会话停用/);
  assert.equal((await captureDecision(f.app, { sourceApplication: 'claude_code', sessionId: SESSION_A })).reason, 'session_stopped');
  assert.deepEqual(await run(['status', '--json'], { CLAUDE_CODE_SESSION_ID: SESSION_A }), { exitCode: 0 });
  assert.deepEqual(JSON.parse(lines.at(-1)).fuli.enabled, false);
  // Codex names the conversation (CODEX_SESSION_ID, its hooks' session_id) and the shell's thread.
  assert.deepEqual(await run(['stop', '--client', 'codex'], { CLAUDE_CODE_SESSION_ID: SESSION_A, CODEX_SESSION_ID: SESSION_B,
    CODEX_THREAD_ID: SESSION_B }), { exitCode: 0 });
  assert.equal((await captureDecision(f.app, { sourceApplication: 'codex', sessionId: SESSION_B })).reason, 'session_stopped',
    'the named client\'s own session');
  assert.deepEqual(await run(['start'], { CODEX_SESSION_ID: SESSION_B, CODEX_THREAD_ID: SESSION_C }), { exitCode: 1 });
  assert.match(lines.at(-1), /sub-Agent thread.*nothing changed/);
  assert.deepEqual(await run(['start'], { CODEX_THREAD_ID: SESSION_B }), { exitCode: 1 });
  assert.match(lines.at(-1), /cannot show which conversation it is; nothing changed/);
  assert.equal((await captureDecision(f.app, { sourceApplication: 'codex', sessionId: SESSION_B })).reason, 'session_stopped');
  assert.deepEqual(await run(['stop'], {}), { exitCode: 1 });
  assert.match(lines.at(-1), /No client session here/);
  assert.deepEqual(await run(['default', 'off'], {}), { exitCode: 0 });
  assert.match(lines.at(-1), /新会话默认不启用 FULI；已打开的会话不受影响/);

  assert.deepEqual(parseSessionArguments(['restart', '--json', '--runtime-config', 'x.json']),
    { action: 'restart', value: null, client: null, json: true, runtimeArgs: ['--runtime-config', 'x.json'] });
  for (const args of [[], ['pause'], ['default'], ['default', 'maybe'], ['stop', '--session', SESSION_C],
    ['stop', '--client', 'cursor'], ['default', 'on', '--client', 'codex']]) {
    assert.throws(() => parseSessionArguments(args), /Usage: fuli session/, args.join(' '));
  }
});

// Fable review of #251: Codex gives its MCP processes no session (openai/codex 87f3c3284e16:
// codex-rs/rmcp-client/src/utils.rs 16-58 builds their environment from an allowlist), so their
// calls carry an identity FULI gave the process, like Cursor's. Without a task token such a call
// cannot be shown not to come from a stopped session, so it is refused while any session of the
// client is off, instead of a stop that says stopped while the session still gets memory. The
// hook payload is the UserPromptSubmit shape of codex-rs/hooks/src/schema.rs 568-584.
const codexPrompt = (session, cwd, prompt) => ({ session_id: session, turn_id: 'synthetic-turn', transcript_path: null,
  cwd, hook_event_name: 'UserPromptSubmit', model: 'synthetic-model', permission_mode: 'default', prompt });
const codexProcess = { env: {}, sourceApplication: 'codex' };

test('Codex: a stop through the real hook payload is not undone by MCP calls Codex cannot attribute', async (t) => {
  const f = await fixture(t);
  const hook = async (session, prompt) => {
    let context;
    const output = await runCodexLifecycleHook(['--event', 'UserPromptSubmit'], {
      readInput: async () => codexPrompt(session, f.dirs.novel, prompt), write: () => {},
      resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
      createLeases: leases, captureTimeoutMs: 30_000,
      callTool: async (app, name, input, request) => {
        const result = await callAgentTool(app, name, input, request);
        if (name === 'begin_task_context') context = result;
        return result;
      } });
    return { output, context };
  };
  await hook(SESSION_A, 'Plan.');
  const other = await hook(SESSION_B, 'Plan.');
  assert.match((await hook(SESSION_A, 'fuli stop')).output.reason, /FULI 已在本会话停用/);
  const search = { personalSpaceId: 'synthetic-space', query: 'chapter' };
  for (const [name, args] of [['search_knowledge_graph', search],
    ['get_collaboration_preferences', { projectPath: f.dirs.novel, taskPrompt: 'Next.' }],
    ['record_knowledge_usage', { personalSpaceId: 'synthetic-space', taskId: 'synthetic-task',
      items: [{ itemId: 'synthetic-item', itemKind: 'entity', useKind: 'applied' }] }]]) {
    const refused = await mcpCall(f, codexProcess, name, args);
    assert.deepEqual([refused.status, refused.reason], ['fuli_off', 'session_unattributed'], name);
    assert.match(refused.guidance, /could not tell which session/);
  }
  // Another Codex thread keeps what its hook token carries.
  const kept = await callAgentTool(f.app, 'checkpoint_task_knowledge', { taskContextToken: other.context.taskContextToken,
    sourceApplication: 'codex', disposition: 'retain_nothing', reason: 'Nothing to keep.',
    workLog: { status: 'completed', summary: 'Planned.' } }, agentHostRequestContext(null, 'fuli-host-synthetic-codex-thread-b'));
  assert.notEqual(kept.status, 'fuli_off');
  assert.equal(kept.checkpoint_required ?? false, false);
  await hook(SESSION_A, 'fuli start');
  assert.ok(Array.isArray((await mcpCall(f, codexProcess, 'search_knowledge_graph', search)).facts),
    'served again once no session is off');
});

test('with the default off, a client without a native session is served only with a task token', async (t) => {
  const f = await fixture(t);
  requestSessionFuliDefault(f.app, { newSessions: 'off' });
  const cursorLine = prompt => runCursorLifecycleHook(['--event', 'beforeSubmitPrompt'], {
    readInput: async () => ({ conversation_id: 'synthetic-cursor-started', workspace_roots: [f.dirs.novel], prompt }),
    write: () => {}, resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases, callTool: async (app, name, input, request) => {
      const result = await callAgentTool(app, name, input, request);
      if (name === 'begin_task_context') task = result;
      return result;
    } });
  let task;
  assert.deepEqual(await cursorLine('Plan.'), { continue: true });
  const process = agentHostRequestContext(null, 'fuli-host-synthetic-cursor-process');
  const entry = sessionId => callAgentTool(f.app, 'get_collaboration_preferences', { projectPath: f.dirs.novel,
    taskPrompt: 'Plan.', sessionId, sourceSessionId: sessionId, sourceApplication: 'cursor' }, process);
  assert.equal((await entry('synthetic-cursor-started')).reason, 'session_not_started');
  assert.equal((await cursorLine('/fuli start')).continue, false);
  assert.deepEqual(await cursorLine('Plan.'), { continue: true });
  // The conversation is on, but a call without a token could come from one that is not.
  assert.equal((await entry('synthetic-cursor-started')).reason, 'session_unattributed');
  const served = await callAgentTool(f.app, 'checkpoint_task_knowledge', { taskContextToken: task.taskContextToken,
    sourceApplication: 'cursor', disposition: 'retain_nothing', reason: 'Nothing to keep.',
    workLog: { status: 'completed', summary: 'Planned.' } }, process);
  assert.notEqual(served.status, 'fuli_off', 'its hook task token is served');
});
