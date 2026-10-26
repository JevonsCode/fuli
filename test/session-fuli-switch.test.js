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

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-hook.js';
import { runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { runCursorLifecycleHook } from '../src/agents/cursor/lifecycle-hook.js';
import { agentHostRequestContext } from '../src/app/agent-request-context.js';
import { parseSessionArguments, runSessionCommand } from '../src/cli/session-command.js';
import { captureDecision } from '../src/graphiti/capture-decision.js';
import { SessionCapturePauseStore, sessionCapturePausePathForRuntime } from '../src/graphiti/capture-session-pause.js';
import { writeJsonFileAtomic } from '../src/storage/json-file.js';
import { createSessionPreferenceDelivery } from '../src/conversations/preference-session.js';
import { requestSessionFuliDefault } from '../src/graphiti/session-fuli-switch.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { createToolInputValidator } from '../src/mcp/tool-input-budget.js';
import { GRAPH_TOOL_DEFINITIONS } from '../src/agent-tools/graph-definitions.js';
import { ROUNDTABLE_TOOL_DEFINITIONS } from '../src/agent-roundtable/tools.js';
import { fuliHostTools } from '../src/agent-apps/host-tools/fuli-tools.js';
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

async function mcpCall(f, { env = {}, sourceApplication, toolProfile = 'full' }, name, args) {
  const server = createMcpServer(f.app, { env, sourceApplication, toolProfile, registerResources: false });
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
  assert.match(fresh.output.hookSpecificOutput.additionalContext, /not on for this session, by the default it started under/);
  assert.ok(fresh.output.systemMessage.includes('本会话未启用 FULI（按本会话开始时的默认设置）'), fresh.output.systemMessage);
  const policy = await mcpCall(f, host(SESSION_B), 'get_capture_policy', { projectPath: f.dirs.novel });
  assert.deepEqual([policy.current.captured, policy.current.reason], [false, 'session_not_started']);
  assert.match(await codexLine(f, SESSION_B, 'fuli status'), /本会话未启用（按本会话开始时的默认设置）；新会话默认不启用/);

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
  // A session Codex says begins now (SessionStart, source startup) starts under the new default.
  await codexSessionStart(f, SESSION_C, 'startup');
  assert.ok((await codexEntry(f, f.dirs.novel, { session: SESSION_C })).context.taskContextToken);
  assert.equal((await codexEntry(f, f.dirs.novel, { session: SESSION_D })).context, undefined);
  assert.equal((await mcpCall(f, host(SESSION_D), 'get_collaboration_preferences', { projectPath: f.dirs.novel,
    taskPrompt: 'Next task.' })).reason, 'session_not_started');
  assert.equal(f.app.hasStoppedSession(), true);
  // A call without a task token is refused for the client while one of its sessions is off,
  // since it cannot be shown not to come from that session.
  f.app.recordKnowledgeUsage = async () => ({ status: 'recorded' });
  const usage = () => mcpCall(f, host(SESSION_C), 'record_knowledge_usage', { personalSpaceId: 'synthetic-space',
    taskId: 'synthetic-task', items: [{ itemId: 'synthetic-item', itemKind: 'entity', useKind: 'applied' }] });
  assert.equal((await usage()).reason, 'session_unattributed');
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
  // Another window of the same client cannot show without a task token that it is not the stopped
  // one (Dot's review of #251), so its token-less read is refused as unattributed, not as its stop.
  const read = { query: 'chapter', sourceApplication: 'codex' };
  const other = await callAgentTool(f.app, 'search_knowledge_graph', read, agentHostRequestContext(null, SESSION_B, 'codex'));
  assert.deepEqual([other.status, other.reason], ['fuli_off', 'session_unattributed']);
  // The person's own read from a terminal (another client) or the console still searches.
  for (const [context, input] of [[agentHostRequestContext(null, 'fuli-host-synthetic-terminal', 'other'), { ...read, sourceApplication: 'other' }],
    [null, read]]) {
    assert.ok(Array.isArray((await callAgentTool(f.app, 'search_knowledge_graph', input, context)).facts));
  }
});

// Codex's SessionStart hook through its real lifecycle (codex-rs/hooks/src/schema.rs input shape).
function codexSessionStart(f, session, source) {
  return runCodexLifecycleHook(['--event', 'SessionStart'], {
    readInput: async () => ({ session_id: session, cwd: f.dirs.novel, hook_event_name: 'SessionStart', model: 'synthetic-model',
      permission_mode: 'default', source, transcript_path: null }), write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases });
}

function claudeSessionStart(f, session, source) {
  return runClaudeLifecycleHook(['--event', 'SessionStart'], {
    readInput: async () => ({ session_id: session, cwd: f.dirs.novel, hook_event_name: 'SessionStart', source,
      transcript_path: join(f.root, `${session}.jsonl`) }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases });
}

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
  // B's own task token keeps it served; a call without one cannot show it is not A's.
  assert.equal((await mcpCall(f, host(SESSION_B), 'get_collaboration_preferences', { projectPath: f.dirs.novel,
    taskPrompt: 'B task.' })).reason, 'session_unattributed');

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
  // While new sessions start off, a call without a token may come from one FULI could not record.
  assert.equal((await entry('synthetic-cursor-started')).reason, 'session_unattributed');
  // Another conversation starts under the default (off): now a call without a token could be from it.
  await runCursorLifecycleHook(['--event', 'beforeSubmitPrompt'], {
    readInput: async () => ({ conversation_id: 'synthetic-cursor-other', workspace_roots: [f.dirs.novel], prompt: 'Plan.' }),
    write: () => {}, resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases });
  assert.equal((await entry('synthetic-cursor-started')).reason, 'session_unattributed');
  assert.deepEqual(await cursorLine('Plan.'), { continue: true });
  // The token its last entry returned (here the hook's) attributes the next entry (option Y).
  const attributed = await callAgentTool(f.app, 'get_collaboration_preferences', { projectPath: f.dirs.novel, taskPrompt: 'Plan.',
    sessionId: 'synthetic-cursor-started', sourceSessionId: 'synthetic-cursor-started', sourceApplication: 'cursor',
    taskContextToken: task.taskContextToken }, process);
  assert.ok(attributed.taskContextToken, 'served with its token');
  const served = await callAgentTool(f.app, 'checkpoint_task_knowledge', { taskContextToken: attributed.taskContextToken,
    sourceApplication: 'cursor', disposition: 'retain_nothing', reason: 'Nothing to keep.',
    workLog: { status: 'completed', summary: 'Planned.' } }, process);
  assert.notEqual(served.status, 'fuli_off', 'and so is its checkpoint with the fresh token');
});

// Dot's review of #251, P1a: Claude Code keeps its MCP process, and so its native session, across
// /clear. With A's process serving B after /clear and B stopped, a call without a task token cannot
// show it is A's, so it is refused even though A itself is on.
test('after /clear a native host session that is on does not let token-less calls through for the stopped session', async (t) => {
  const f = await fixture(t);
  await claudeEntry(f, f.dirs.novel, { session: SESSION_A });
  await claudeEntry(f, f.dirs.novel, { session: SESSION_B, prompt: '/fuli stop' });
  const oldProcess = { env: { CLAUDE_CODE_SESSION_ID: SESSION_A }, sourceApplication: 'claude_code' };
  for (const [name, args] of [['search_knowledge_graph', { personalSpaceId: 'synthetic-space', query: 'chapter' }],
    ['get_collaboration_preferences', { projectPath: f.dirs.novel, taskPrompt: 'Next.' }]]) {
    const refused = await mcpCall(f, oldProcess, name, args);
    assert.deepEqual([refused.status, refused.reason], ['fuli_off', 'session_unattributed'], name);
  }
  await claudeEntry(f, f.dirs.novel, { session: SESSION_B, prompt: '/fuli start' });
  assert.ok(Array.isArray((await mcpCall(f, oldProcess, 'search_knowledge_graph',
    { personalSpaceId: 'synthetic-space', query: 'chapter' })).facts));
});

// P1b: the client is the one the process was started for, for every tool, whatever the payload
// names or leaves out.
const OPEN_WHILE_OFF = new Set(['get_capture_policy', 'explain_settings', 'list_agent_interfaces', 'get_graphiti_status',
  'update_capture_policy', 'verify_task_checkpoint', 'cancel_agent_message', 'cancel_agent_attention',
  'acquire_runtime_lease', 'refresh_runtime_lease', 'release_runtime_lease']);

test('every tool of the catalog is refused for a client with a stopped session when the payload omits or misnames the client', async (t) => {
  const f = await fixture(t);
  await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  await codexLine(f, SESSION_A, 'fuli stop');
  const process = agentHostRequestContext(null, 'fuli-host-synthetic-codex-process', 'codex');
  const tools = listAgentTools().map(({ name }) => name).filter(name => !OPEN_WHILE_OFF.has(name));
  assert.ok(tools.length > 100, String(tools.length));
  for (const name of tools) {
    for (const input of [{}, { sourceApplication: 'other' }, { sourceApplication: 'cursor' }]) {
      const refused = await callAgentTool(f.app, name, input, process);
      assert.deepEqual([refused?.status, refused?.reason], ['fuli_off', 'session_unattributed'],
        `${name} ${JSON.stringify(input)}`);
    }
  }
  // Through the real MCP server too, for tools that never named their client before.
  for (const [name, args] of [['list_personal_projects', {}], ['list_preference_conflicts', { personalSpaceId: 'synthetic-space' }],
    ['get_agent_handoff', { personalSpaceId: 'synthetic-space', agentId: 'lead-novel' }]]) {
    const refused = await mcpCall(f, { env: {}, sourceApplication: 'codex' }, name, args);
    assert.deepEqual([refused.status, refused.reason], ['fuli_off', 'session_unattributed'], name);
  }
});

// Dot's review of #251, P1c: a session whose starting default cannot be saved stays off until the
// person starts it, so a later change of the default never turns it on.
test('a session whose starting default cannot be saved stays off until the person starts it', async (t) => {
  const f = await fixture(t);
  const failPins = (path, value) => {
    if (path.split(/[\\/]/).includes('pins')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return writeJsonFileAtomic(path, value);
  };
  f.app.sessionCapturePauseStore = f.sessionPauses = new SessionCapturePauseStore(
    sessionCapturePausePathForRuntime(f.runtimeConfigPath), { now: () => f.clock.now, writeJson: failPins });
  requestSessionFuliDefault(f.app, { newSessions: 'off' });
  const entry = await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  assert.equal(entry.context, undefined);
  assert.match(entry.output.hookSpecificOutput.additionalContext, /could not save how this session started, so it stays off/);
  requestSessionFuliDefault(f.app, { newSessions: 'on' });
  assert.equal((await codexEntry(f, f.dirs.novel, { session: SESSION_A })).context, undefined, 'the default turning on changes nothing');
  assert.match(await codexLine(f, SESSION_A, 'fuli status'), /保持停用（未能保存本会话开始时的设置）/);
  assert.equal((await captureDecision(f.app, { sourceApplication: 'codex', sessionId: SESSION_A })).reason, 'session_start_unsaved');
  await codexLine(f, SESSION_A, 'fuli start');
  assert.ok((await codexEntry(f, f.dirs.novel, { session: SESSION_A })).context.taskContextToken);
  // With nothing writable at all the entry is refused for that turn, and says why.
  f.app.sessionCapturePauseStore = new SessionCapturePauseStore(sessionCapturePausePathForRuntime(f.runtimeConfigPath),
    { writeJson: () => { throw new Error('read-only'); } });
  const none = await codexEntry(f, f.dirs.novel, { session: SESSION_B });
  assert.equal(none.context, undefined);
  assert.match(none.output.hookSpecificOutput.additionalContext, /could not save how this session started/);
});

// P2: restart promises a full context next turn only when the delivery was reset.
test('a restart whose context reset fails says so instead of promising a full context', async (t) => {
  const f = await fixture(t);
  await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  f.app.preferenceDelivery = { reset: async () => false, deliver: async (value, _origin, format) => format(value) };
  const reply = await codexLine(f, SESSION_A, 'fuli restart');
  assert.match(reply, /重新启用，但未能重置上下文投递，下一轮可能只提供变化的部分而不是完整上下文/);
  assert.doesNotMatch(reply, /下一轮重新提供完整上下文/);
  assert.equal(record(f)(SESSION_A).stopped, false, 'FULI is on all the same');
  f.app.close = async () => {};
  const lines = [];
  assert.deepEqual(await runSessionCommand(['restart'], { env: { CLAUDE_CODE_SESSION_ID: SESSION_B }, cwd: f.dirs.novel,
    write: line => lines.push(line), openApplication: () => f.app, createLeases: leases }), { exitCode: 1 });
  // The real delivery cache reports a reset it could not save.
  const blocked = join(f.root, 'not-a-directory');
  await writeFile(blocked, 'x');
  const delivery = createSessionPreferenceDelivery({ directory: join(blocked, 'cache'), env: {} });
  assert.equal(await delivery.reset({ sourceApplication: 'codex', nativeSessionId: SESSION_A }), false);
  assert.equal(await createSessionPreferenceDelivery({ directory: join(f.root, 'delivery'), env: {} })
    .reset({ sourceApplication: 'codex', nativeSessionId: SESSION_A }), true);
});

// Option Y (#251): tools an Agent calls without a task of their own take the task token it already
// has, so a window whose session is on is served while another window of the client is stopped.
test('the task token a call carries decides it: the stopped window stays refused, a sibling window is served', async (t) => {
  const f = await fixture(t);
  const seen = [];
  const search = f.app.searchKnowledge;
  f.app.searchKnowledge = async input => { seen.push(input); return search(input); };
  const a = await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  const b = await codexEntry(f, f.dirs.novel, { session: SESSION_B });
  await codexLine(f, SESSION_A, 'fuli stop');
  const process = { env: {}, sourceApplication: 'codex' };
  const searchWith = token => mcpCall(f, process, 'search_knowledge_graph', { personalSpaceId: 'synthetic-space', query: 'chapter',
    ...(token === undefined ? {} : { taskContextToken: token }) });
  const entryWith = token => mcpCall(f, process, 'get_collaboration_preferences', { projectPath: f.dirs.novel, taskPrompt: 'Next.',
    ...(token === undefined ? {} : { taskContextToken: token }) });

  // A sibling window with its own token searches and enters; the tool never sees the token.
  assert.ok(Array.isArray((await searchWith(b.context.taskContextToken)).facts));
  assert.equal(Object.hasOwn(seen.at(-1), 'taskContextToken'), false);
  const next = await mcpCall(f, process, 'get_collaboration_preferences', { projectPath: f.dirs.novel, taskPrompt: 'Next.',
    sessionId: SESSION_B, taskContextToken: b.context.taskContextToken });
  assert.ok(next.taskContextToken, 'served, with a fresh token for its next calls');
  assert.ok(Array.isArray((await searchWith(next.taskContextToken)).facts));
  // The stopped window is refused even with its own token.
  for (const call of [searchWith, entryWith]) {
    assert.deepEqual([(await call(a.context.taskContextToken)).reason], ['session_stopped']);
  }
  // Without a token, or with one that proves nothing, the strict rule stays. A token that is not
  // its session's current task says so: the registry answers a superseded, forged and foreign one alike.
  const claudeTask = f.app.taskContextRegistry.begin({ sessionId: SESSION_C, personalProjectId: 'novel', projectAgentId: 'lead-novel',
    sourceApplication: 'claude_code' });
  for (const [label, token, reason] of [['none', undefined, 'session_unattributed'],
    ['forged', 'fuli-task-synthetic-forged', 'task_token_not_current'], ['superseded', b.context.taskContextToken, 'task_token_not_current'],
    ['another client', claudeTask.token, 'task_token_not_current'], ['oversized', `fuli-task-${'x'.repeat(300)}`, 'session_unattributed']]) {
    for (const call of [searchWith, entryWith]) {
      const refused = await call(token);
      assert.deepEqual([refused.status, refused.reason], ['fuli_off', reason], `${label} ${call === searchWith ? 'search' : 'entry'}`);
    }
  }
});

// rec#47 F2: a refusal says why the call's token did not count. A token a newer prompt replaced is
// not "an unknown session", and a registry that cannot answer is not either. None of them is served.
test('a superseded token or a failed registry read is refused with its own reason while a session is stopped', async (t) => {
  const f = await fixture(t);
  await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  const first = await codexEntry(f, f.dirs.novel, { session: SESSION_B, prompt: 'First task.' });
  await codexLine(f, SESSION_A, 'fuli stop');
  const process = agentHostRequestContext(null, 'fuli-host-synthetic-codex-process', 'codex');
  const recorded = [];
  f.app.recordDecisionTrace = async input => { recorded.push(input); return { status: 'recorded' }; };
  const call = (name, token) => callAgentTool(f.app, name, { personalSpaceId: 'synthetic-space', query: 'chapter',
    ...(token === undefined ? {} : { taskContextToken: token }) }, process);
  // "continue" after an interruption is a new prompt: it begins a new task with a new token.
  const current = (await codexEntry(f, f.dirs.novel, { session: SESSION_B, prompt: 'continue' })).context.taskContextToken;
  assert.notEqual(current, first.context.taskContextToken);

  for (const name of ['search_knowledge_graph', 'record_decision_trace']) {
    const stale = await call(name, first.context.taskContextToken);
    assert.deepEqual([stale.status, stale.reason], ['fuli_off', 'task_token_not_current'], name);
    assert.match(stale.guidance, /taskContextToken from this turn's FULI context/);
    assert.match(stale.guidance, /Do not try to checkpoint or record the earlier task/);
    assert.doesNotMatch(stale.guidance, /could not tell which session/);
    assert.equal(stale.notice, '这次调用带的任务 token 已不是会话当前的任务（每次新的提问都会换新 token），而本客户端有会话已停用 FULI，所以没有提供；你明确提交的修改仍会保存');
    assert.equal((await call(name)).reason, 'session_unattributed', `${name} without a token`);
  }
  // The earlier task really cannot be checkpointed any more (the Provider checkpoints only a
  // session's current task; this double follows it).
  await assert.rejects(async () => f.app.taskContextRegistry.checkpoint(first.context.taskContextToken,
    { disposition: 'retain_nothing', reason: 'Late close.', fingerprint: 'synthetic-late' }, 'codex'), { code: 'not_found' });
  assert.deepEqual(recorded, [], 'nothing refused reached the tool');

  // A registry that cannot answer is the fail-closed reason, not an unknown session.
  const registry = f.app.taskContextRegistry;
  f.app.taskContextRegistry = { currentTaskSession: async () => { throw new Error('synthetic provider outage'); } };
  for (const name of ['search_knowledge_graph', 'record_decision_trace']) {
    const failed = await call(name, current);
    assert.deepEqual([failed.status, failed.reason], ['fuli_off', 'policy_unavailable'], name);
    assert.equal(failed.notice, '记录设置读取失败，本次未自动记录；你明确提交的修改仍会保存');
    assert.match(failed.guidance, /This is not the person stopping FULI/);
  }
  f.app.taskContextRegistry = registry;

  // The current token is served, and the tool never sees it.
  assert.ok(Array.isArray((await call('search_knowledge_graph', current)).facts));
  assert.deepEqual(await call('record_decision_trace', current), { status: 'recorded' });
  assert.equal(Object.hasOwn(recorded.at(-1), 'taskContextToken'), false);
});

// rec#11 D-62: no list decides which tools take the token. Every gated tool lists it, through every
// path a model reads a schema from (the MCP list, list_agent_interfaces, the schema fuli_call validates
// against), while an open tool and a tool naming its own task token are listed exactly as defined.
test('every gated tool lists the task token and accepts a call carrying it; open and own-token tools are unchanged', async (t) => {
  const f = await fixture(t);
  const defined = new Map([...GRAPH_TOOL_DEFINITIONS, ...ROUNDTABLE_TOOL_DEFINITIONS].map(item => [item.name, item]));
  const ownToken = ({ inputSchema }) => ['taskContextToken', 'task_context_token'].some(field => Object.hasOwn(inputSchema.properties, field));
  const server = createMcpServer(f.app, { env: { FULI_ENABLE_TEST_TOOLS: '1' }, sourceApplication: 'codex', registerResources: false });
  const client = new Client({ name: 'synthetic-session-schemas', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(() => Promise.all([client.close(), server.close()]));
  const mcpListed = new Map((await client.listTools()).tools.map(item => [item.name, item.inputSchema]));
  const catalog = async name => JSON.parse((await client.callTool({ name: 'list_agent_interfaces', arguments: { toolName: name } }))
    .content[0].text).tools[0].inputSchema;

  const gated = listAgentTools().filter(({ name }) => !OPEN_WHILE_OFF.has(name));
  assert.ok(gated.length > 140, String(gated.length));
  for (const definition of gated) {
    const { name, inputSchema } = definition;
    const own = ownToken(defined.get(name));
    // A tool that names its own token keeps that field, its limits and whether it is required.
    assert.deepEqual(inputSchema, own ? defined.get(name).inputSchema : { ...defined.get(name).inputSchema,
      properties: { ...defined.get(name).inputSchema.properties, taskContextToken: { type: 'string' } } }, name);
    assert.ok(Object.hasOwn(mcpListed.get(name).properties, 'taskContextToken'), `${name} in tools/list`);
    assert.deepEqual(await catalog(name), inputSchema, `${name} in list_agent_interfaces`);
    const parsed = await createToolInputValidator(inputSchema).parse({ taskContextToken: 'fuli-task-synthetic' });
    assert.deepEqual((parsed.error?.issues ?? []).filter(issue => issue.code === 'unrecognized_keys'), [], name);
  }
  for (const name of OPEN_WHILE_OFF) {
    assert.deepEqual(listAgentTools().find(item => item.name === name).inputSchema, defined.get(name).inputSchema, name);
  }
});

// The macOS tester's 0.20.1 run (rec#47): list_judgments, reached through fuli_call in the chat
// profile, had no field for the token, so it was always refused while a sibling session was stopped.
test('list_judgments through fuli_call is served with the current token while another session is stopped', async (t) => {
  const f = await fixture(t);
  const seen = [];
  f.app.judgment = { agent: { records: async input => { seen.push(input); return { records: [] }; } } };
  await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  const stale = (await codexEntry(f, f.dirs.novel, { session: SESSION_B, prompt: 'First task.' })).context.taskContextToken;
  const current = (await codexEntry(f, f.dirs.novel, { session: SESSION_B, prompt: 'continue' })).context.taskContextToken;
  await codexLine(f, SESSION_A, 'fuli stop');
  const judgments = token => mcpCall(f, { env: {}, sourceApplication: 'codex', toolProfile: 'chat' }, 'fuli_call',
    { toolName: 'list_judgments', input: { personalSpaceId: 'synthetic-space', limit: 1,
      ...(token === undefined ? {} : { taskContextToken: token }) } });

  assert.deepEqual(await judgments(current), { records: [] });
  assert.deepEqual(seen, [{ personalSpaceId: 'synthetic-space', limit: 1 }], 'the tool never sees the token');
  for (const [token, reason] of [[undefined, 'session_unattributed'], [stale, 'task_token_not_current'],
    ['fuli-task-synthetic-forged', 'task_token_not_current']]) {
    const refused = await judgments(token);
    assert.deepEqual([refused.status, refused.reason], ['fuli_off', reason], String(token));
  }
  // The stopped session stays refused with its own token.
  const own = (await codexEntry(f, f.dirs.novel, { session: SESSION_B, prompt: 'Again.' })).context.taskContextToken;
  await codexLine(f, SESSION_B, 'fuli stop');
  assert.equal((await judgments(own)).reason, 'session_stopped');
  assert.equal(seen.length, 1, 'nothing refused reached the tool');
});

// Only the token the gate added is removed: a tool that names its own token receives it, and an app's
// granted FULI tool (agent-apps host tools) passes the token through the same gate.
test('the gate removes only the token it added, for Agent and app calls alike', async (t) => {
  const f = await fixture(t);
  const seen = [];
  const stopped = (await codexEntry(f, f.dirs.novel, { session: SESSION_A })).context.taskContextToken;
  const current = (await codexEntry(f, f.dirs.novel, { session: SESSION_B })).context.taskContextToken;
  f.app.planAgentCollaboration = async input => { seen.push(['plan', input]); return { plan: [] }; };
  await callAgentTool(f.app, 'plan_agent_collaboration', { taskContextToken: current, sourceApplication: 'codex' });
  assert.deepEqual(seen.pop(), ['plan', { taskContextToken: current, sourceApplication: 'codex' }]);

  await codexLine(f, SESSION_A, 'fuli stop');
  f.app.listPersonalProjects = async input => { seen.push(['projects', input]); return { projects: [] }; };
  const hostTools = fuliHostTools({ toolNames: () => listAgentTools().map(({ name }) => name),
    callFuliTool: (name, input) => callAgentTool(f.app, name, input) });
  const projects = hostTools.get('list_personal_projects');
  assert.deepEqual(await projects.run({ personalSpaceId: 'synthetic-space', taskContextToken: current, sourceApplication: 'codex' }),
    { projects: [] });
  assert.deepEqual(seen.pop(), ['projects', { personalSpaceId: 'synthetic-space', sourceApplication: 'codex' }]);
  const refused = await projects.run({ personalSpaceId: 'synthetic-space', taskContextToken: stopped, sourceApplication: 'codex' });
  assert.deepEqual([refused.status, refused.reason], ['fuli_off', 'session_stopped']);
  assert.deepEqual(seen, []);
});

// rec#47 F2 (dot's P2 on #349): the records a task writes as it goes or closes take the token too.
// Their schemas reject unknown fields, so before this they were always refused while any session of
// the client was stopped. The token's session then authorizes their capture decision as a task's
// would: real handlers and the real capture gate, only the Provider is a double.
const MEMORY_CHECKPOINT = { personalSpaceId: 'synthetic-space', personalProjectId: 'novel', agentId: 'lead-novel',
  expectedRevision: 0, memory: { summary: 'Synthetic working summary.' } };
const KNOWLEDGE_CAPTURE = { targetKind: 'personal', spaceId: 'synthetic-space', personalProjectId: 'novel', sourceKind: 'conversation',
  name: 'Synthetic capture', sourceDescription: 'Synthetic session evidence', referenceTime: '2026-10-20T00:00:00.000Z',
  sensitivity: 'normal', relationships: [], entities: [{ key: 'preference:synthetic', name: 'Synthetic preference', type: 'Preference',
    originQuadrant: 'known_known', confirmationStatus: 'pending', confirmationBasis: { existenceReason: 'The user stated it.',
      quadrantReason: 'The user stated it explicitly.', proposedBy: { kind: 'agent', label: 'Codex' } } }] };
const CLOSING = ['checkpoint_project_agent_memory', 'capture_session_knowledge'];

async function closingRecords(t) {
  const f = await fixture(t);
  const memoryWrites = [];
  f.app.personal.writeProjectAgentMemory = async request => {
    memoryWrites.push(request);
    return { checkpoint_id: `synthetic-checkpoint-${memoryWrites.length}`, personal_space_id: request.personal_space_id,
      personal_project_id: request.personal_project_id, agent_id: request.agent_id, revision: memoryWrites.length,
      created_at: '2026-10-20T08:00:00.000Z', memory: request.memory };
  };
  let call = 0;
  // Every attempt is a new write, so an idempotent retry never hides a refusal.
  const write = (session, name, token) => mcpCall(f, { env: {}, sourceApplication: 'codex' }, name, {
    ...(name === 'capture_session_knowledge' ? { ...KNOWLEDGE_CAPTURE, sessionId: session } : MEMORY_CHECKPOINT),
    idempotencyKey: `synthetic-closing-${++call}`, ...(token === undefined ? {} : { taskContextToken: token }) });
  const written = name => name === 'capture_session_knowledge' ? f.knowledge.length : memoryWrites.length;
  return { f, write, written };
}

test('closing records with the current token are written while another session of the client is stopped', async (t) => {
  const { f, write, written } = await closingRecords(t);
  await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  const stale = (await codexEntry(f, f.dirs.novel, { session: SESSION_B, prompt: 'First task.' })).context.taskContextToken;
  const current = (await codexEntry(f, f.dirs.novel, { session: SESSION_B, prompt: 'continue' })).context.taskContextToken;
  await codexLine(f, SESSION_A, 'fuli stop');
  for (const name of CLOSING) {
    for (const [token, reason] of [[undefined, 'session_unattributed'], [stale, 'task_token_not_current']]) {
      const refused = await write(SESSION_B, name, token);
      assert.deepEqual([refused.status, refused.reason], ['fuli_off', reason], `${name} ${reason}`);
    }
    // A payload that names the stopped session is refused even with a current token.
    if (name === 'capture_session_knowledge') assert.equal((await write(SESSION_A, name, current)).reason, 'session_stopped');
    assert.equal(written(name), 0, `${name}: nothing refused was written`);
    const served = await write(SESSION_B, name, current);
    assert.ok(['checkpointed', 'committed'].includes(served.status), `${name} ${JSON.stringify(served)}`);
    assert.equal(written(name), 1, `${name} written once`);
  }

  // The token's own session is held to its pause and its stop like a task's.
  await callAgentTool(f.app, 'update_capture_policy', { sessionPaused: true, taskContextToken: current, sourceApplication: 'codex' });
  for (const name of CLOSING) {
    const paused = await write(SESSION_B, name, current);
    assert.deepEqual([paused.status, paused.reason], ['capture_disabled', 'session_paused'], `${name} paused`);
  }
  await codexLine(f, SESSION_B, 'fuli stop');
  for (const name of CLOSING) {
    const stopped = await write(SESSION_B, name, current);
    assert.deepEqual([stopped.status, stopped.reason], ['fuli_off', 'session_stopped'], `${name} stopped`);
    assert.equal(written(name), 1, `${name}: nothing more was written`);
  }
});

// No session is stopped, so the use gate does not refuse; a paused sibling still made every
// token-less write of the client unattributable. The current token binds the write to its session.
test('closing records with the current token are written while another session of the client is paused', async (t) => {
  const { f, write, written } = await closingRecords(t);
  const a = (await codexEntry(f, f.dirs.novel, { session: SESSION_A })).context.taskContextToken;
  const stale = (await codexEntry(f, f.dirs.novel, { session: SESSION_B, prompt: 'First task.' })).context.taskContextToken;
  const current = (await codexEntry(f, f.dirs.novel, { session: SESSION_B, prompt: 'continue' })).context.taskContextToken;
  await callAgentTool(f.app, 'update_capture_policy', { sessionPaused: true, taskContextToken: a, sourceApplication: 'codex' });
  for (const name of CLOSING) {
    for (const [token, reason] of [[undefined, 'policy_unavailable'], [stale, 'policy_unavailable'], [a, 'session_paused']]) {
      const refused = await write(SESSION_B, name, token);
      assert.deepEqual([refused.status, refused.reason], ['capture_disabled', reason], `${name} ${token}`);
    }
    assert.equal(written(name), 0, `${name}: nothing refused was written`);
    assert.ok(['checkpointed', 'committed'].includes((await write(SESSION_B, name, current)).status), name);
    assert.equal(written(name), 1, name);
  }
});

test('the attribution token is an optional field of the tools whose schema names no task, and only of them', () => {
  const byName = new Map(listAgentTools().map(tool => [tool.name, tool.inputSchema]));
  for (const name of ['get_collaboration_preferences', 'get_user_taste_skill', 'search_current_project_knowledge', 'search_knowledge_graph',
    'search_connected_knowledge', 'list_project_agents', 'get_project_agent_context', 'get_project_agent_memory',
    'list_preference_conflicts', 'resolve_deferred_preference_conflict', 'request_agent_attention', 'assess_agent_action',
    'review_with_tonborg', 'get_agent_quality_gate', 'get_project_team', 'recommend_next_workflow_steps', 'find_agents',
    'capture_session_knowledge', 'record_decision_trace', 'record_workflow_transition_observation',
    'checkpoint_project_agent_memory', 'record_project_agent_task_activity', 'record_project_agent_executor_actual',
    'record_project_agent_task_outcome']) {
    assert.deepEqual(byName.get(name).properties.taskContextToken, { type: 'string' }, name);
    assert.equal((byName.get(name).required ?? []).includes('taskContextToken'), false, name);
  }
  assert.equal(Object.hasOwn(byName.get('get_capture_policy').properties, 'taskContextToken'), true, 'tools that had one keep theirs');
  assert.equal(Object.hasOwn(byName.get('list_agent_interfaces').properties ?? {}, 'taskContextToken'), false);
});

// Dot's review of #251 at dd2dbe1: when neither the pin nor the session's own record can be saved,
// nothing on disk says the session is off. While the default is off a call FULI cannot attribute
// is refused anyway, and a session that began before the default turned on cannot pin on later:
// only a session that shows it is new (no transcript yet) or began after the switch starts on.
test('after a double write failure the session stays off, in the same turn and after the default turns on', async (t) => {
  const f = await fixture(t);
  requestSessionFuliDefault(f.app, { newSessions: 'off' });
  const transcriptPath = join(f.root, 'synthetic-old-session.jsonl');
  await writeFile(transcriptPath, `${JSON.stringify({ type: 'session_meta', payload: { id: SESSION_A } })}\n`);
  const directory = sessionCapturePausePathForRuntime(f.runtimeConfigPath);
  f.app.sessionCapturePauseStore = new SessionCapturePauseStore(directory, { now: () => f.clock.now,
    writeJson: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); } });
  const entry = await codexEntry(f, f.dirs.novel, { session: SESSION_A, transcriptPath });
  assert.equal(entry.context, undefined, 'no task and no token');
  const sameTurn = await mcpCall(f, { env: {}, sourceApplication: 'codex' }, 'search_knowledge_graph',
    { personalSpaceId: 'synthetic-space', query: 'chapter' });
  assert.deepEqual([sameTurn.status, sameTurn.reason], ['fuli_off', 'session_unattributed']);

  // Writes recover and the person turns the default on later.
  f.app.sessionCapturePauseStore = f.sessionPauses = new SessionCapturePauseStore(directory, { now: () => f.clock.now });
  f.clock.now = '2099-01-01T00:00:00.000Z';
  assert.equal(requestSessionFuliDefault(f.app, { newSessions: 'on' }).newSessions, 'on');
  const later = await codexEntry(f, f.dirs.novel, { session: SESSION_A, transcriptPath });
  assert.equal(later.context, undefined, 'it began before the default turned on, so it does not turn on with it');
  assert.equal(record(f)(SESSION_A).stopped, true);
  await codexSessionStart(f, SESSION_B, 'startup');
  const fresh = await codexEntry(f, f.dirs.novel, { session: SESSION_B });
  assert.ok(fresh.context.taskContextToken, 'a session Codex says begins now starts under the new default');
  await codexLine(f, SESSION_A, 'fuli start');
  assert.ok((await codexEntry(f, f.dirs.novel, { session: SESSION_A, transcriptPath })).context.taskContextToken,
    'only the person\'s start turns it on');
});

test('while new sessions start off, calls FULI cannot attribute are refused even with no session stopped', async (t) => {
  const f = await fixture(t);
  await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  requestSessionFuliDefault(f.app, { newSessions: 'off' });
  assert.equal(f.app.hasStoppedSession('codex'), false, 'no session FULI saw is off');
  const process = agentHostRequestContext(null, 'fuli-host-synthetic-codex-process', 'codex');
  const tokenless = await callAgentTool(f.app, 'search_knowledge_graph', { query: 'chapter' }, process);
  assert.deepEqual([tokenless.status, tokenless.reason], ['fuli_off', 'session_unattributed']);
  // A token proves the session: A started under on and stays on; one without a durable record does not.
  const a = await codexEntry(f, f.dirs.novel, { session: SESSION_A });
  assert.ok(Array.isArray((await callAgentTool(f.app, 'search_knowledge_graph', { query: 'chapter',
    taskContextToken: a.context.taskContextToken }, process)).facts));
  const unrecorded = f.app.taskContextRegistry.begin({ sessionId: SESSION_C, personalProjectId: 'novel',
    projectAgentId: 'lead-novel', sourceApplication: 'codex' });
  assert.equal((await callAgentTool(f.app, 'search_knowledge_graph', { query: 'chapter', taskContextToken: unrecorded.token },
    process)).reason, 'session_not_started');
});

// Dot's review of #251 at e45d879: a transcript that does not exist proves nothing (an old session's
// may simply not be there), so only the host's own session-start event counts as a new session.
test('only a host session-start event shows a session is new; a missing transcript does not', async (t) => {
  const f = await fixture(t);
  requestSessionFuliDefault(f.app, { newSessions: 'off' });
  const directory = sessionCapturePausePathForRuntime(f.runtimeConfigPath);
  f.app.sessionCapturePauseStore = new SessionCapturePauseStore(directory, { now: () => f.clock.now,
    writeJson: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); } });
  const missing = join(f.root, 'synthetic-not-yet-visible.jsonl');
  assert.equal((await codexEntry(f, f.dirs.novel, { session: SESSION_A, transcriptPath: missing })).context, undefined);
  f.app.sessionCapturePauseStore = f.sessionPauses = new SessionCapturePauseStore(directory, { now: () => f.clock.now });
  f.clock.now = '2099-01-01T00:00:00.000Z';
  requestSessionFuliDefault(f.app, { newSessions: 'on' });
  assert.equal((await codexEntry(f, f.dirs.novel, { session: SESSION_A, transcriptPath: missing })).context, undefined,
    'still no transcript, still off');
  assert.equal(record(f)(SESSION_A).stopped, true);
  // Resumed, cleared, compacted or forked sessions are not proof either.
  for (const [session, source] of [[SESSION_B, 'resume'], [SESSION_C, 'clear']]) {
    await codexSessionStart(f, session, source);
    assert.equal((await codexEntry(f, f.dirs.novel, { session })).context, undefined, source);
  }
  await claudeSessionStart(f, SESSION_D, 'compact');
  assert.equal((await claudeEntry(f, f.dirs.novel, { session: SESSION_D })).context, undefined, 'compact');
  // Genuine new-session evidence from each client starts on.
  const NEW_CLAUDE = '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b';
  const NEW_CODEX = '9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c';
  await claudeSessionStart(f, NEW_CLAUDE, 'startup');
  assert.ok((await claudeEntry(f, f.dirs.novel, { session: NEW_CLAUDE })).context.taskContextToken, 'claude startup');
  await codexSessionStart(f, NEW_CODEX, 'startup');
  assert.ok((await codexEntry(f, f.dirs.novel, { session: NEW_CODEX })).context.taskContextToken, 'codex startup');
  const cursorHook = (event, prompt) => runCursorLifecycleHook(['--event', event], {
    readInput: async () => ({ conversation_id: 'synthetic-cursor-new', workspace_roots: [f.dirs.novel], prompt }), write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app, createLeases: leases });
  await cursorHook('sessionStart');
  await cursorHook('beforeSubmitPrompt', 'Plan.');
  assert.equal(record(f)('synthetic-cursor-new').stopped, false, 'cursor sessionStart');
  // A session that was never seen at all and only shows up at a prompt stays off until started.
  assert.equal((await codexEntry(f, f.dirs.novel, { session: 'synthetic-unseen' })).context, undefined);
  await codexLine(f, SESSION_A, 'fuli start');
  assert.ok((await codexEntry(f, f.dirs.novel, { session: SESSION_A })).context.taskContextToken);
});
