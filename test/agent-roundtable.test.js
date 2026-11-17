import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { createWakeClaimRelease, processGroupAlive } from '../packages/roundtable/src/roundtable/wake-claim-release.js';
import { createProcessInspector } from '../src/agent-services/process-identity.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isolatedWakeClients, parseFinalAnswer, runProcess, sessionWorkingDirectory, wakeArguments, wakeAgent } from '../packages/roundtable/src/roundtable/wake.js';
import { runAsRunnerCall } from '../src/app/agent-request-context.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';

const agent = (agentId, name, allowedClients = ['claude_code', 'codex']) => ({ agentId,
  employeeNumber: agentId === 'lead-1' ? '000001' : '000002',
  profile: { name, displayName: name, status: 'active', responsibility: `${name} 的职责`, capabilities: [], allowedClients } });

function fixture({ wake, sessions = {}, redeemed = true, env = {}, openStore = () => createRoundtableStore(), idFactory = null, peer = undefined,
  clientAvailable = () => true, now = undefined, inspectProcess = undefined, groupAlive = () => false, platform = undefined } = {}) {
  const agents = [agent('lead-1', 'Milo Reed'), agent('reviewer-1', 'Nova Lane', ['codex'])];
  const tasks = {
    'token-milo': { token: 'token-milo', projectAgentId: 'lead-1', personalProjectId: 'app', sessionId: 'cc-1', sourceApplication: 'claude_code' },
    'token-nova': { token: 'token-nova', projectAgentId: 'reviewer-1', personalProjectId: 'app', sessionId: 'cx-9', sourceApplication: 'codex' },
    'token-foreign': { token: 'token-foreign', projectAgentId: 'lead-1', personalProjectId: 'other-app', sessionId: 'cc-2', sourceApplication: 'claude_code' },
    'token-global': { token: 'token-global', projectAgentId: 'lead-1', personalProjectId: null, sessionId: 'cc-3', sourceApplication: 'claude_code' },
    'token-nova-global': { token: 'token-nova-global', projectAgentId: 'reviewer-1', personalProjectId: null, sessionId: 'cx-3', sourceApplication: 'codex' }
  };
  const woken = [];
  const grants = [], revoked = [], verified = [];
  const app = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => agents,
    // Like the Provider, a token resolves only for the client that began it.
    taskContextRegistry: { context: async (token, client) => {
      if (tasks[token] && client && client !== tasks[token].sourceApplication) throw new Error('Task context not found for this client');
      return tasks[token];
    } },
    standingAssignments: createStandingAssignments(),
    personal: { recentAgentSessions: async ({ agentId }) => sessions[agentId] ?? [],
      listPersonalProjects: async () => [],
      issueAgentDelegation: async input => { grants.push(input); return { token: `synthetic-grant-${grants.length}` }; },
      verifyAgentDelegation: async input => { verified.push(input); return { redeemed }; },
      revokeAgentDelegation: async input => { revoked.push(input); }
    }
  };
  let id = 0;
  if (peer) app.peer = peer;
  const roundtable = createAgentRoundtable({ host: createFuliRoundtableHost(app), peer: app.peer, env, openStore, idFactory: idFactory ?? (() => `id-${++id}`),
    locateCwd: (client, sessionId) => `/work/${client}/${sessionId}`, clientAvailable, now, inspectProcess, groupAlive, platform,
    wake: async (input) => { woken.push(input); return wake ? wake(input) : { body: 'Nova 的回答', sessionId: 'fork-1' }; } });
  return { app, roundtable, woken, grants, revoked, verified };
}

test('an Agent asks another Agent, which answers from its latest conversation', async () => {
  const { roundtable, woken } = fixture({ sessions: { 'reviewer-1': [
    { source_application: 'codex', session_id: 'cx-9', personal_project_id: 'app', last_active: '2026-10-10T00:00:00Z' }] } });
  const result = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'Nova Lane', body: '登录重构评审过了吗？' });
  assert.equal(result.status, 'answered');
  assert.equal(result.reply, 'Nova 的回答');
  assert.equal(result.via, 'codex:resume');
  assert.equal(woken[0].client, 'codex');
  assert.equal(woken[0].sessionId, 'cx-9');
  assert.equal(woken[0].cwd, '/work/codex/cx-9');
  assert.match(woken[0].prompt, /^#FLA \{reviewer-1\} \[FULI 圆桌 · id-1\]/);
  assert.match(woken[0].prompt, /Milo Reed（Claude Code）发来消息/);
  const thread = roundtable.thread({ threadId: result.threadId });
  assert.deepEqual(thread.messages.map(({ kind, status, from, to }) => [kind, status, from.name, to.name]), [
    ['ask', 'answered', 'Milo Reed', 'Nova Lane'], ['reply', 'sent', 'Nova Lane', 'Milo Reed']]);
  const [summary] = roundtable.threads().threads;
  assert.equal(summary.subject, '登录重构评审过了吗？');
  assert.deepEqual(summary.participants.map((person) => person.name), ['Milo Reed', 'Nova Lane']);
  assert.equal(summary.waiting, false);
  assert.deepEqual(summary.waitingFor, []);
  // Agents' own threads have no delivery mode of the person's; the answered ask is not running.
  assert.deepEqual([summary.mode, summary.replying], [null, false]);
});

test('an ordinary ask keeps the person’s own MCP servers even when FULI can name its entry', async () => {
  const { app, roundtable, woken } = fixture({ sessions: { 'reviewer-1': [
    { source_application: 'codex', session_id: 'cx-9', personal_project_id: 'app', last_active: '2026-10-10T00:00:00Z' }] } });
  app.fuliMcpServer = () => ({ command: '/synthetic/node', args: ['/synthetic/mcp-server.js'] });
  const result = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'reviewer-1', body: 'Synthetic question' });
  assert.equal(result.status, 'answered');
  assert.equal(woken.length, 1);
  assert.equal('mcpServers' in woken[0], false);
});

test('a woken answer keeps the model and tokens its client reported; wake usage counts answers by client and model', async () => {
  const answers = [{ body: 'a', sessionId: 'fork-1', model: 'synthetic-model-a', usage: { inputTokens: 120, outputTokens: 30 } },
    { body: 'b', sessionId: 'fork-2', model: 'synthetic-model-a', usage: { inputTokens: null, outputTokens: 5 } },
    { body: 'c', sessionId: 'fork-3' }];
  const { roundtable } = fixture({ wake: async () => answers.shift() });
  for (const body of ['one', 'two', 'three']) {
    assert.equal((await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
      to: 'Nova Lane', body })).status, 'answered');
  }
  // A wake that failed counts as failed, with what its client reported before failing;
  // the inbox reply that answered the ask afterwards is not a wake.
  const queued = fixture({ wake: async () => { throw Object.assign(new Error('no answer'), { code: 'wake_failed',
    reported: { model: 'synthetic-model-b', usage: { inputTokens: 40, outputTokens: 2 } } }); } });
  const sent = await queued.roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', to: 'Nova Lane', body: 'x' });
  await queued.roundtable.replyMessage({ taskContextToken: 'token-nova', sourceApplication: 'codex', messageId: sent.messageId, body: 'y' });
  const window = { from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' };
  assert.deepEqual(queued.roundtable.wakeUsage(window),
    [{ client: 'codex', model: 'synthetic-model-b', wakes: 0, failedWakes: 1, inputTokens: 40, outputTokens: 2, tokenWakes: 1 }]);
  assert.deepEqual(roundtable.wakeUsage(window), [
    { client: 'codex', model: 'synthetic-model-a', wakes: 2, failedWakes: 0, inputTokens: 120, outputTokens: 35, tokenWakes: 2 },
    { client: 'codex', model: null, wakes: 1, failedWakes: 0, inputTokens: null, outputTokens: null, tokenWakes: 0 }]);
  assert.deepEqual(roundtable.wakeUsage({ from: '2999-01-01T00:00:00.000Z', to: '2999-01-02T00:00:00.000Z' }), []);
});

test('employee numbers find and address the same identity across clients', async () => {
  const { roundtable, woken } = fixture();
  const result = await roundtable.findAgents({ query: '000002' });
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].employeeNumber, '000002');
  assert.equal(result.agents[0].agentId, 'reviewer-1');
  await roundtable.messageAgent({ taskContextToken: 'token-milo', to: 'FLA 000002', body: 'Synthetic review', sourceApplication: 'claude_code' });
  assert.match(woken[0].prompt, /^#FLA \{reviewer-1\}/);
});

test('a public in-flight thread header never authorizes member delegation', async () => {
  let roundtable;
  ({ roundtable } = fixture({ wake: async (input) => {
    const context = { taskPrompt: input.prompt, agentId: 'reviewer-1', personalProjectId: 'app', sourceApplication: 'codex' };
    assert.equal(roundtable.taskEntryDelegation(context), null);
    assert.equal(roundtable.taskEntryDelegation({ ...context, personalProjectId: 'elsewhere' }), null);
    assert.equal(roundtable.taskEntryDelegation({ ...context, sourceApplication: 'claude_code' }), null);
    assert.equal(roundtable.taskEntryDelegation({ ...context, sessionId: 'unrelated-user-session' }), null);
    assert.equal(roundtable.taskEntryDelegation({ ...context, taskPrompt: '#FLA {reviewer-1} [FULI 圆桌 · invented]' }), null);
    return { body: 'Member report', sessionId: 'member-run' };
  } }));
  const result = await roundtable.messageAgent({ taskContextToken: 'token-milo', to: 'reviewer-1', body: 'Review this work' });
  assert.equal(result.status, 'answered');
  assert.equal(roundtable.taskEntryDelegation({ taskPrompt: '#FLA {reviewer-1} [FULI 圆桌 · id-1]',
    agentId: 'reviewer-1', personalProjectId: 'app', sourceApplication: 'codex' }), null);
});

test('grants are per-attempt, verified against the answering session, and always revoked', async () => {
  const { roundtable, grants, woken, revoked, verified } = fixture({
    sessions: { 'reviewer-1': [{ source_application: 'codex', session_id: 'cx-9', personal_project_id: 'app' }] },
    wake: async ({ sessionId }) => {
      if (sessionId) throw new Error('Busy session');
      return { body: 'Synthetic answer', sessionId: 'fresh-session' };
    }
  });
  const result = await roundtable.messageAgent({ taskContextToken: 'token-milo', to: 'reviewer-1', body: 'Review' });
  assert.equal(result.status, 'answered');
  assert.deepEqual(grants.map(x => x.target_session_id), ['cx-9', null]);
  assert.deepEqual(revoked.map(x => x.token), ['synthetic-grant-1', 'synthetic-grant-2']);
  assert.equal(verified[0].session_id, 'fresh-session');
  assert.equal(woken[1].delegationToken, 'synthetic-grant-2');
  assert.ok(woken.every(x => !x.prompt.includes('synthetic-grant')));
});

test('a missing redemption cannot be attributed to the intended member', async () => {
  const { roundtable, revoked } = fixture({ redeemed: false });
  const result = await roundtable.messageAgent({ taskContextToken: 'token-milo', to: 'reviewer-1', body: 'Review' });
  assert.equal(result.status, 'stand_in');
  assert.equal(result.reason, 'delegation_not_redeemed');
  assert.equal(roundtable.thread({ threadId: result.threadId }).messages.length, 1);
  assert.equal(revoked.length, 1);
});

test('Claude fork delegation is claimed by the new session, not the resumed source', async () => {
  const { roundtable, grants, verified } = fixture({ sessions: {
    'lead-1': [{ source_application: 'claude_code', session_id: 'original-session', personal_project_id: 'app' }]
  } });
  await roundtable.messageAgent({ taskContextToken: 'token-nova', to: 'lead-1', body: 'Report' });
  assert.equal(grants[0].target_session_id, null);
  assert.equal(verified[0].session_id, 'fork-1');
});

test('wake passes only its new grant in the child environment, never the prompt', async () => {
  await wakeAgent({ client: 'codex', cwd: '/synthetic', prompt: 'Review', delegationToken: 'new-grant',
    env: { FULI_CODEX_BIN: '/synthetic/codex', FULI_ROUNDTABLE_DELEGATION: 'inherited-grant' },
    run: async (_command, _args, input) => {
      assert.equal(input.env.FULI_ROUNDTABLE_DELEGATION, 'new-grant');
      assert.equal(input.input, 'Review');
      return { code: 0, stdout: [
        { type: 'thread.started', thread_id: 'synthetic-session' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'Answer' } },
        { type: 'turn.completed' }
      ].map(JSON.stringify).join('\n') };
    }
  });
});

test('a message that cannot be delivered waits in the inbox until the Agent replies', async () => {
  const { roundtable } = fixture({ wake: async () => { throw Object.assign(new Error('offline'), { code: 'client_unavailable' }); } });
  const sent = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'reviewer-1', body: '请看一下 PR' });
  assert.equal(sent.status, 'stand_in');
  assert.equal(sent.reason, 'client_unavailable');
  const inbox = await roundtable.readMessages({ taskContextToken: 'token-nova', sourceApplication: 'codex' });
  assert.deepEqual(inbox.messages.map(({ from, body }) => [from, body]), [['Milo Reed', '请看一下 PR']]);
  assert.deepEqual(roundtable.pending('reviewer-1').map(({ messageId }) => messageId), [sent.messageId]);
  await roundtable.replyMessage({ taskContextToken: 'token-nova', sourceApplication: 'codex', messageId: sent.messageId, body: '已看，可以合并' });
  assert.deepEqual(roundtable.pending('reviewer-1'), []);
  await assert.rejects(roundtable.replyMessage({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    messageId: sent.messageId, body: 'not mine' }), /No such message/);
  assert.equal(roundtable.thread({ threadId: sent.threadId }).messages[1].body, '已看，可以合并');
});

test('an ask refused by an earlier wake says no client has it and which ask holds the Agent (rec#97)', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { roundtable, woken } = fixture({ wake: async () => { await gate; return { body: 'done', sessionId: 'fork-1' }; } });
  const first = roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', to: 'reviewer-1', body: 'first' });
  while (!woken.length) await new Promise((resolve) => setImmediate(resolve));
  const second = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', to: 'reviewer-1', body: 'second' });
  assert.deepEqual([second.status, second.reason, second.delivery], ['queued', 'execution_claimed', 'not_delivered']);
  assert.match(second.guidance, /^No client has received this message\. FULI started no session: an earlier message to Nova Lane \(id-2, since /);
  assert.match(second.guidance, /cannot push a message into a client chat that is already running/);
  assert.equal(woken.length, 1, 'the refused ask started nothing');
  // The status and the thread say the same while the earlier wake still runs.
  const status = await roundtable.messageStatus({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', messageId: second.messageId });
  assert.deepEqual([status.reason, status.delivery], ['execution_claimed', 'not_delivered']);
  assert.match(status.guidance, /\(id-2, since /);
  assert.equal(roundtable.thread({ threadId: second.threadId }).messages[0].error, 'execution_claimed');
  release();
  assert.equal((await first).status, 'answered');
});

// A console that stopped mid-wake leaves its claim active; the woken process may
// still run (rec#97). The fixture's wake never settles, like a lost console.
function lostWake({ spawn = 4242, inspect, group = () => false }) {
  let time = Date.parse('2026-11-09T10:00:00Z');
  const store = createRoundtableStore(':memory:', { clock: () => new Date(time) });
  const lost = fixture({ openStore: () => store, now: () => time, inspectProcess: inspect, groupAlive: group,
    wake: (input) => { if (spawn) input.onSpawn?.(spawn); return new Promise(() => {}); } });
  void lost.roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', to: 'reviewer-1', body: 'first' });
  let n = 0;
  const restarted = fixture({ openStore: () => store, now: () => time, inspectProcess: inspect, groupAlive: group, idFactory: () => `after-${++n}` });
  const ask = body => restarted.roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', to: 'reviewer-1', body });
  return { lost, restarted, ask, store, advance: minutes => { time += minutes * 60 * 1000; } };
}
const settle = async (woken) => { while (!woken.length) await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };

test('a lost wake whose process still runs keeps holding the Agent, past an hour too (rec#97)', async () => {
  const running = new Map([[4242, { identity: 'start-1' }]]);
  const { lost, restarted, ask, advance } = lostWake({ inspect: async pids => new Map(pids.filter(pid => running.has(pid)).map(pid => [pid, running.get(pid)])) });
  await settle(lost.woken);
  advance(30);
  assert.equal((await ask('too soon')).reason, 'execution_claimed');
  advance(150);
  assert.equal((await ask('still running')).reason, 'execution_claimed', 'a live woken process is never joined by a second wake');
  running.delete(4242);
  advance(2);
  assert.equal((await restarted.roundtable.ownerCancelMessage({ messageId: 'id-2' })).status, 'cancelled',
    'once it ended, the stuck ask is back in the inbox');
  const answered = await ask('now');
  assert.deepEqual([answered.status, restarted.woken.length], ['answered', 1]);
});

test('a lost wake whose PID now belongs to another process is released (rec#97)', async () => {
  let identity = 'start-1';
  const { lost, ask, advance } = lostWake({ inspect: async pids => new Map(pids.map(pid => [pid, { identity }])) });
  await settle(lost.woken);
  identity = 'start-2';
  advance(61);
  assert.equal((await ask('now')).status, 'answered');
});

test('a lost wake is held while the OS cannot be asked, and one with no PID only for a day (rec#97)', async () => {
  const unknown = lostWake({ inspect: async () => null });
  await settle(unknown.lost.woken);
  unknown.advance(24 * 60);
  assert.equal((await unknown.ask('cannot tell')).reason, 'execution_claimed');
  // The console was lost between the claim and the spawn: a process may exist unrecorded.
  const never = lostWake({ spawn: null, inspect: async () => new Map() });
  await settle(never.lost.woken);
  never.advance(90);
  assert.equal((await never.ask('no pid yet')).reason, 'execution_claimed', 'no PID is no proof');
  never.advance(23 * 60);
  assert.equal((await never.ask('a day on')).status, 'answered');
});

// DOT 11-10: the leader closing does not end its group (wake.js processGroupExited).
test('a lost wake whose leader ended is held while its process group still answers (rec#97)', async () => {
  let members = true;
  const asked = [];
  const { lost, restarted, ask, advance } = lostWake({ inspect: async () => new Map(),
    group: pgid => { asked.push(pgid); return members; } });
  await settle(lost.woken);
  advance(90);
  assert.equal((await ask('descendants still run')).reason, 'execution_claimed');
  assert.deepEqual(asked, [4242], 'the group is the one the woken client leads');
  members = null;
  advance(2);
  assert.equal((await ask('cannot tell')).reason, 'execution_claimed');
  members = false;
  advance(2);
  assert.equal((await restarted.roundtable.ownerCancelMessage({ messageId: 'id-2' })).status, 'cancelled');
  assert.equal((await ask('group gone')).status, 'answered');
});

test('a reused PID whose group answers is held for a day, not forever (rec#97)', async () => {
  let identity = 'start-1';
  const { lost, ask, advance } = lostWake({ inspect: async pids => new Map(pids.map(pid => [pid, { identity }])),
    group: () => true });
  await settle(lost.woken);
  identity = 'start-2';
  advance(90);
  assert.equal((await ask('reused, group answers')).reason, 'execution_claimed');
  advance(23 * 60);
  assert.equal((await ask('a day on')).status, 'answered');
});

test('an Agent with no client this computer can start is named plainly (rec#97)', async () => {
  const { roundtable, woken } = fixture({ clientAvailable: () => false });
  const sent = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', to: 'reviewer-1', body: 'hello' });
  assert.deepEqual([sent.status, sent.reason, woken.length], ['stand_in', 'no_client', 0]);
  assert.deepEqual(sent.ladder.steps.map(({ tier, client, reason }) => [tier, client, reason]), [
    ['resume', null, 'no_previous_session'], ['new_session', 'claude_code', 'client_not_allowed']]);
  const status = await roundtable.messageStatus({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', messageId: sent.messageId });
  assert.deepEqual([status.reason, status.delivery], ['no_client', 'stand_in']);
});

test('a message sent without waiting says no session was started (rec#97)', async () => {
  const { roundtable } = fixture();
  const sent = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', to: 'reviewer-1', body: 'later', wait: false });
  assert.deepEqual([sent.reason, sent.delivery], ['not_waiting', 'not_delivered']);
  const status = await roundtable.messageStatus({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', messageId: sent.messageId });
  assert.equal(status.delivery, 'not_delivered');
  assert.match(status.guidance, /FULI has not started a session for it\. Nova Lane sees it in its inbox when its next task starts/);
});

test('status and cancel work from each client’s own task and reject another project’s task', async () => {
  const { roundtable } = fixture({ wake: async () => { throw Object.assign(new Error('offline'), { code: 'client_unavailable' }); } });
  const sent = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'reviewer-1', body: '请复核测试' });
  // Recipient on Codex and sender on Claude Code both read the status.
  assert.equal((await roundtable.messageStatus({ taskContextToken: 'token-nova', sourceApplication: 'codex', messageId: sent.messageId })).status, 'stand_in');
  assert.equal((await roundtable.messageStatus({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', messageId: sent.messageId })).status, 'stand_in');
  await assert.rejects(roundtable.cancelMessage({ taskContextToken: 'token-nova', sourceApplication: 'codex', messageId: sent.messageId }), /No such message sent/);
  await assert.rejects(roundtable.messageStatus({ taskContextToken: 'token-foreign', sourceApplication: 'claude_code', messageId: sent.messageId }), /current project/);
  await assert.rejects(roundtable.cancelMessage({ taskContextToken: 'token-foreign', sourceApplication: 'claude_code', messageId: sent.messageId }), /current project/);
  const cancelled = await roundtable.cancelMessage({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', messageId: sent.messageId });
  assert.equal(cancelled.status, 'cancelled');
});

test('a busy conversation falls back to a new session of the same Agent', async () => {
  const { roundtable, woken } = fixture({
    sessions: { 'reviewer-1': [{ source_application: 'codex', session_id: 'cx-9', personal_project_id: 'app', last_active: 'now' }] },
    wake: async ({ sessionId }) => {
      if (sessionId) throw Object.assign(new Error('active writer'), { code: 'wake_failed' });
      return { body: '新会话的回答', sessionId: 'cx-new' };
    }
  });
  const result = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', to: 'Nova Lane', body: '在吗' });
  assert.equal(result.status, 'answered');
  assert.equal(result.via, 'codex:new');
  assert.deepEqual(woken.map(({ sessionId, cwd }) => [sessionId, cwd]), [['cx-9', '/work/codex/cx-9'], [null, '/work/codex/cx-9']]);
});

test('a client that is not logged in hands the message to the Agent\'s next client', async () => {
  const { roundtable, woken } = fixture({
    sessions: { 'lead-1': [{ source_application: 'claude_code', session_id: 'cc-7', personal_project_id: 'app', last_active: '2026-10-10T00:00:00Z' }] },
    wake: ({ client }) => {
      if (client === 'claude_code') throw Object.assign(new Error('not logged in'), { code: 'client_login_required' });
      return { body: 'Milo 用 Codex 回答', sessionId: 'cx-new' };
    }
  });
  const result = await roundtable.messageAgent({ taskContextToken: 'token-nova', sourceApplication: 'codex', to: 'Milo Reed', body: '看一下这个 PR？' });
  assert.equal(result.status, 'answered');
  assert.equal(result.via, 'codex:new');
  assert.deepEqual(woken.map(({ client, sessionId }) => `${client}:${sessionId}`), ['claude_code:cc-7', 'codex:null']);
});

test('a timed-out wake does not start another client', async () => {
  const { roundtable, woken } = fixture({
    wake: () => { throw Object.assign(new Error('slow'), { code: 'wake_timeout' }); }
  });
  const result = await roundtable.messageAgent({ taskContextToken: 'token-nova', sourceApplication: 'codex', to: 'Milo Reed', body: '在吗？' });
  assert.equal(result.status, 'queued');
  assert.equal(result.reason, 'wake_timeout');
  assert.equal(woken.length, 1);
});

test('a fresh run is used when the recipient has no resumable conversation, in the sender\'s own client first', async () => {
  const { roundtable, woken } = fixture();
  const result = await roundtable.messageAgent({ taskContextToken: 'token-nova', sourceApplication: 'codex',
    to: 'Milo Reed', body: 'hello', projectPath: '/work/app' });
  assert.equal(result.via, 'codex:new');
  assert.deepEqual([woken[0].client, woken[0].sessionId, woken[0].cwd], ['codex', null, '/work/app']);
});

test('names must be unambiguous and threads have a message limit', async () => {
  const { roundtable } = fixture();
  await assert.rejects(roundtable.messageAgent({ to: 'Nobody', body: 'x', sourceApplication: 'codex' }), /No active Agent/);
  const first = await roundtable.messageAgent({ to: 'Milo Reed', body: 'start', sourceApplication: 'codex', wait: false });
  assert.equal(first.status, 'queued');
  // An unanswered ask names who the thread is waiting for.
  const [summary] = roundtable.threads().threads;
  assert.equal(summary.waiting, true);
  assert.deepEqual(summary.waitingFor, ['Milo Reed']);
  for (let index = 1; index < 24; index += 1) {
    await roundtable.messageAgent({ to: 'Milo Reed', body: `more ${index}`, threadId: first.threadId, sourceApplication: 'codex', wait: false });
  }
  await assert.rejects(roundtable.messageAgent({ to: 'Milo Reed', body: 'too many', threadId: first.threadId,
    sourceApplication: 'codex', wait: false }), /message limit/);
});

test('waking validates the session id and the client, and reports a client that is not logged in', () => {
  assert.throws(() => wakeArguments('codex', { sessionId: '--last; rm' }), /Invalid client session id/);
  assert.throws(() => wakeArguments('cursor', {}), /Unsupported client/);
  assert.equal(sessionWorkingDirectory('codex', '../escape', { home: tmpdir(), env: {} }), null);
  assert.throws(() => parseFinalAnswer('codex', { code: 1, stdout: JSON.stringify({ error: 'authentication_failed' }) }),
    (error) => error.code === 'client_login_required');
  assert.throws(() => parseFinalAnswer('claude_code', { code: 2, stdout: JSON.stringify({ type: 'result', result: 'ok' }) }),
    (error) => error.code === 'wake_failed');
});

test('a Codex wake keeps the tokens its turn.completed reported and names no model', () => {
  const stdout = usage => [{ type: 'thread.started', thread_id: 'synthetic-thread' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Answer' } },
    { type: 'turn.completed', ...(usage ? { usage } : {}) }].map(JSON.stringify).join('\n');
  assert.deepEqual(parseFinalAnswer('codex', { code: 0, stdout: stdout({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }) }),
    { body: 'Answer', sessionId: 'synthetic-thread', usage: { inputTokens: 100, outputTokens: 10 } });
  assert.deepEqual(parseFinalAnswer('codex', { code: 0, stdout: stdout(null) }), { body: 'Answer', sessionId: 'synthetic-thread' });
});

test('task entry hands the selected Agent the questions waiting for it', async () => {
  const { taskEntryPreferences } = await import('../src/graphiti/task-entry-preferences.js');
  const waiting = [{ messageId: 'm-1', threadId: 't-1', from: 'Milo Reed', body: '请看一下 PR' }];
  const application = {
    config: { personal: { spaceId: 'space' } }, consoleUrl: 'http://127.0.0.1:2727',
    roundtable: { pending: (agentId) => agentId === 'reviewer-1' ? waiting : [] },
    personal: {
      resolveProjectAgentContext: async () => ({ status: 'ready', agent: { agent_id: 'reviewer-1',
        profile: { name: 'Nova Lane', status: 'active', allowed_clients: ['codex'], work_kinds: ['code_review'] } } }),
      getProjectAgentMemory: async () => null, getPersonalProject: async () => null,
      listProjectAgentTasks: async () => [], getProjectAgentCoordinationPolicy: async () => ({}),
      collaborationPreferences: async () => ({ effective_preferences: [] }), listPreferenceConflicts: async () => []
    },
    searchKnowledge: async () => ({ facts: [], entities: [] })
  };
  const result = await taskEntryPreferences(application, { status: 'matched', personalProjectId: 'app' }, {
    projectPath: '/work/app', taskPrompt: '评审一下', sourceApplication: 'codex', agentInvocation: true,
    agentToolName: 'begin_task_context', sessionId: 's', turnId: 't'
  }, async () => {});
  assert.deepEqual(result.agent_messages, waiting);
  assert.match(result.agent_messages_guidance, /reply_agent_message/);
});

test('task entry delivers the unstaffed execution decision beside the lead context', async () => {
  const { taskEntryPreferences } = await import('../src/graphiti/task-entry-preferences.js');
  const guidance = 'Execution is not staffed: no team member fits this work. Use coordinate_project_agent_task to open HR recruitment for the missing role; the project recruitment confirmation policy applies.';
  const application = {
    config: { personal: { spaceId: 'space' } }, consoleUrl: 'http://127.0.0.1:2727',
    personal: {
      resolveProjectAgentContext: async () => ({ status: 'ready', reason: 'project_team_lead',
        execution_reason: 'project_team_gap', execution_agent_id: null,
        match_basis: ['project team lead is the stable conversation owner', guidance],
        agent: { agent_id: 'lead-1', profile: { name: 'Synthetic Lead', status: 'active',
          allowed_clients: ['codex'], work_kinds: ['planning'] } } }),
      staffDefaultProjectLead: async () => { throw new Error('must not staff a replacement lead'); },
      getProjectAgentMemory: async () => null, getPersonalProject: async () => null,
      listProjectAgentTasks: async () => [], getProjectAgentCoordinationPolicy: async () => ({}),
      collaborationPreferences: async () => ({ effective_preferences: [] }), listPreferenceConflicts: async () => []
    },
    searchKnowledge: async () => ({ facts: [], entities: [] })
  };
  const result = await taskEntryPreferences(application, { status: 'matched', personalProjectId: 'app' }, {
    projectPath: '/work/app', taskPrompt: 'verify the export', sourceApplication: 'codex', agentInvocation: true,
    agentToolName: 'begin_task_context', sessionId: 's', turnId: 't'
  }, async () => {});
  const context = result.project_agent_context;
  assert.equal(context.project_agent_id, 'lead-1');
  assert.equal(context.selection_reason, 'project_team_lead');
  assert.equal(context.execution_reason, 'project_team_gap');
  assert.equal(context.execution_agent_id, null);
  assert.equal(context.worker_started, false);
  assert.ok(context.match_basis.includes(guidance));
});

test('direct chat wakes once through the existing read-only adapter and records its verified answer', async t => {
  const entered = Promise.withResolvers(), answer = Promise.withResolvers();
  const { roundtable, woken, grants } = fixture({ wake: async input => { entered.resolve(input); return answer.promise; } });
  t.after(() => roundtable.close());
  const chat = (token, action, data = {}) => roundtable.chat({ taskContextToken: token, sourceApplication: token === 'token-milo' ? 'claude_code' : 'codex', action, ...data });
  const { chatId } = await chat('token-milo', 'create', { requestId: 'auto-wake-room', kind: 'direct', members: ['local:reviewer-1'] });
  await chat('token-milo', 'send', { chatId, requestId: 'auto-wake-message', body: 'review the unread note' });
  // One turn of the event loop, not a timer scan, lets asynchronous grant work run.
  const { scheduler } = await import('node:timers/promises');
  await scheduler.yield();
  assert.equal(woken.length, 1);
  assert.match((await entered.promise).prompt, /review the unread note/);
  await chat('token-milo', 'send', { chatId, requestId: 'auto-wake-message', body: 'review the unread note' });
  await chat('token-milo', 'send', { chatId, requestId: 'auto-wake-message-2', body: 'another unread note' });
  await scheduler.yield();
  assert.equal(woken.length, 1);
  assert.equal(grants.length, 1);
  answer.resolve({ body: 'read-only answer', sessionId: 'verified-chat-session' });
  await scheduler.yield();
  const page = await chat('token-nova', 'read', { chatId });
  assert.deepEqual(page.messages.map(m => m.body), ['review the unread note','another unread note']);
});

test('an active wait suppresses automatic direct chat wake', async t => {
  const { roundtable, woken } = fixture();
  t.after(() => roundtable.close());
  const { chatId } = await roundtable.chat({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', action: 'create', requestId: 'wait-no-wake', kind: 'direct', members: ['local:reviewer-1'] });
  const waiting = roundtable.chat({ taskContextToken: 'token-nova', sourceApplication: 'codex', action: 'wait', chatId });
  await roundtable.chat({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', action: 'send', chatId, requestId: 'wait-delivery', body: 'delivered to waiter' });
  assert.equal((await waiting).messages[0].body, 'delivered to waiter');
  assert.equal(woken.length, 0);
});

test('messages arriving during a chat wake are consumed by the next wake without a timer scan', async t => {
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  let runs = 0;
  const { roundtable, woken } = fixture({ wake: async () => ++runs === 1 ? first.promise : second.promise });
  t.after(() => { first.resolve({ body: 'first answer', sessionId: 'one' }); second.resolve({ body: 'second answer', sessionId: 'two' }); return roundtable.close(); });
  const chat = (action, data) => roundtable.chat({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', action, ...data });
  const { chatId } = await chat('create', { requestId: 'during-wake', kind: 'direct', members: ['local:reviewer-1'] });
  const { scheduler } = await import('node:timers/promises');
  await chat('send', { chatId, requestId: 'during-1', body: 'first note' });
  await scheduler.yield();
  assert.equal(woken.length, 1);
  await chat('send', { chatId, requestId: 'during-2', body: 'second note' });
  first.resolve({ body: 'first answer', sessionId: 'one' });
  await scheduler.yield();
  assert.equal(woken.length, 2);
  assert.match(woken[1].prompt, /second note/);
  assert.doesNotMatch(woken[1].prompt, /first note/);
});

test('shared-store instances wait for the existing claim and then wake another room', { timeout: 5000 }, async t => {
  const {mkdtemp,rm}=await import('node:fs/promises'); const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'chat-wake-instances-')); const path=join(dir,'chats.sqlite');
  const one=Promise.withResolvers(), firstEntered=Promise.withResolvers(), secondEntered=Promise.withResolvers();
  const {randomUUID}=await import('node:crypto');
  const openStore=()=>createRoundtableStore(path);
  const a=fixture({openStore,idFactory:randomUUID,wake:async input=>{firstEntered.resolve(input);return one.promise;}});
  const b=fixture({openStore,idFactory:randomUUID,wake:async input=>{secondEntered.resolve(input);return {body:'second result',sessionId:'second'};}});
  t.after(async()=>{one.resolve({body:'first result',sessionId:'first'});await a.roundtable.close();await b.roundtable.close();await rm(dir,{recursive:true,force:true});});
  const call=(r,action,data)=>r.chat({taskContextToken:'token-milo',sourceApplication:'claude_code',action,...data});
  const r1=await call(a.roundtable,'create',{requestId:'r1',kind:'group',members:['local:reviewer-1']});
  const r2=await call(a.roundtable,'create',{requestId:'r2',kind:'group',members:['local:reviewer-1']});
  await call(a.roundtable,'send',{chatId:r1.chatId,requestId:'r1-send',body:'@{local:reviewer-1} room one'});
  await firstEntered.promise;
  await call(b.roundtable,'send',{chatId:r2.chatId,requestId:'r2-send',body:'@{local:reviewer-1} room two'});
  one.resolve({body:'first result',sessionId:'first'});
  assert.match((await secondEntered.promise).prompt,/room two/);
  assert.equal(a.woken.length+b.woken.length,2);
});

test('group wake uses stable addresses and a bounded post-admission unread snapshot', async t => {
  const {roundtable,woken}=fixture();t.after(()=>roundtable.close());
  const chat=(action,data)=>roundtable.chat({taskContextToken:'token-milo',sourceApplication:'claude_code',action,...data});
  const {chatId}=await chat('create',{requestId:'snapshot-room',kind:'group',members:['local:reviewer-1']});
  await chat('members',{chatId,expectedRevision:1,remove:['local:reviewer-1']});
  await chat('send',{chatId,requestId:'before-admission',body:'secret before joining'});
  await chat('members',{chatId,expectedRevision:2,add:['local:reviewer-1']});
  await chat('send',{chatId,requestId:'name-only',body:'@Nova Lane is just prose'});
  const {scheduler}=await import('node:timers/promises');await scheduler.yield();assert.equal(woken.length,0);
  await chat('send',{chatId,requestId:'stable-mention',body:'@{local:reviewer-1} '+ '中'.repeat(15000)});
  await scheduler.yield();assert.equal(woken.length,1);
  assert.doesNotMatch(woken[0].prompt,/secret before joining/);
  assert.match(woken[0].prompt,/"unshown":true/);
  assert.match(woken[0].prompt,/"bodyTruncated":true/);
  assert.ok(Buffer.byteLength(woken[0].prompt)<13000);
});

test('escaped control characters fit the unread snapshot budget without poisoning later wakes', async t => {
  const {roundtable,woken}=fixture();t.after(()=>roundtable.close());
  const call=(action,data)=>roundtable.chat({taskContextToken:'token-milo',sourceApplication:'claude_code',action,...data});
  const {chatId}=await call('create',{requestId:'escaped-room',kind:'direct',members:['local:reviewer-1']});
  await call('send',{chatId,requestId:'escaped-message',body:'\u0001'.repeat(2000)});
  const {scheduler}=await import('node:timers/promises');await scheduler.yield();
  assert.equal(woken.length,1);assert.ok(Buffer.byteLength(woken[0].prompt)<13000);
  assert.match(woken[0].prompt,/"bodyTruncated":true/);
  await call('send',{chatId,requestId:'after-escaped',body:'next message'});await scheduler.yield();
  assert.equal(woken.length,2);assert.match(woken[1].prompt,/next message/);
});

test('a definite remote queue rejection releases the source execution claim', async t => {
  const store=createRoundtableStore();const to='peer:0123456789abcdef:binding';
  const peer={isRemoteAddress:value=>value.startsWith('peer:'),resolveRemote:async()=>({address:to,agentId:'remote-lead',name:'lead',deviceName:'other'}),
    send:async()=>{throw Object.assign(new Error('queue full'),{status:429,code:'queue_full'});}};
  const {roundtable}=fixture({openStore:()=>store,peer});t.after(()=>roundtable.close());
  await assert.rejects(roundtable.messageAgent({taskContextToken:'token-milo',sourceApplication:'claude_code',to,body:'snapshot',chatWake:{}}),/queue full/);
  assert.deepEqual(store.executionState('space',to),{busy:false,claim:null,held:false});
});

test('an unknown thread is reported as the thread, never as a missing Agent (rec#68)', async () => {
  const { roundtable } = fixture();
  await assert.rejects(roundtable.messageAgent({ to: 'Milo Reed', body: 'x', threadId: 'host-session-7',
    sourceApplication: 'codex', wait: false }), error => {
    assert.match(error.message, /Roundtable thread host-session-7 not found\. Agent Milo Reed exists/);
    assert.match(error.message, /Omit threadId to start a new thread/);
    return true;
  });
});

test('task entry tells the lead which project the person asked about and how to ask it (rec#71)', async () => {
  const { taskEntryPreferences } = await import('../src/graphiti/task-entry-preferences.js');
  const application = {
    config: { personal: { spaceId: 'space' } }, consoleUrl: 'http://127.0.0.1:2727',
    roundtable: { pending: () => [] },
    personal: {
      resolveProjectAgentContext: async () => ({ status: 'ready', reason: 'project_team_lead', agent: { agent_id: 'lead-1',
        profile: { name: 'Synthetic Lead', status: 'active', allowed_clients: ['codex'], work_kinds: ['planning'] } } }),
      getProjectAgentMemory: async () => null, getPersonalProject: async () => null,
      listPersonalProjects: async () => [{ project_id: 'app', profile: { name: 'App', lifecycle: 'active' } },
        { project_id: 'other', profile: { name: 'Other Shop', lifecycle: 'active' } }],
      listProjectAgentTasks: async () => [], getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: 'lead-1' }),
      collaborationPreferences: async () => ({ effective_preferences: [] }), listPreferenceConflicts: async () => []
    },
    searchKnowledge: async () => ({ facts: [], entities: [] })
  };
  const entry = taskPrompt => taskEntryPreferences(application, { status: 'matched', personalProjectId: 'app' }, {
    projectPath: '/work/app', taskPrompt, sourceApplication: 'codex', agentInvocation: true,
    agentToolName: 'begin_task_context', sessionId: 's', turnId: 't'
  }, async () => {});
  const asked = await entry('去看看 Other Shop 项目是怎么做导出的');
  assert.deepEqual(asked.roundtable_ask.projects, [{ projectId: 'other', name: 'Other Shop', address: 'project:other' }]);
  assert.equal((await entry('verify the export')).roundtable_ask, undefined);
});

test('a real woken process that outlives its console blocks a second wake until it ends (rec#97)', async () => {
  // A synthetic stand-in for the woken client: it keeps running after the "console" is gone.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  try {
    const { lost, ask, advance, store } = lostWake({ spawn: child.pid, inspect: createProcessInspector().inspect });
    await settle(lost.woken);
    // The identity is read right after spawn, as a console that lived a moment longer would.
    for (let tries = 0; tries < 150 && !store.getMessage('id-2')?.wake_pid_identity; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(store.getMessage('id-2').wake_pid_identity, 'the OS identity of the woken process was recorded');
    advance(90);
    assert.equal((await ask('while it runs')).reason, 'execution_claimed');
    child.kill();
    await exited;
    advance(2);
    assert.equal((await ask('after it ended')).status, 'answered');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test('a claim from before processes were recorded is released a day after it began (rec#97)', async () => {
  let time = Date.parse('2026-11-09T10:00:00Z');
  const claim = { id: 'old-1', execution_claimed_at: new Date(time).toISOString(), wake_process_evidence: null };
  const expired = [];
  const store = { claimsBefore: (_space, _agent, cutoff) => (claim.execution_claimed_at < cutoff && !expired.length ? [claim] : []),
    expireClaim: id => { expired.push(id); return true; } };
  const release = createWakeClaimRelease({ store, now: () => time });
  time += 2 * 60 * 60 * 1000;
  assert.equal(await release.release('space', 'reviewer-1'), 0, 'no evidence is no proof yet');
  time += 23 * 60 * 60 * 1000;
  assert.equal(await release.release('space', 'reviewer-1'), 1);
  assert.deepEqual(expired, ['old-1']);
  assert.equal(await release.release('space', 'peer:abc:reviewer-1'), 0, 'a remote run is ended only by its own device');
});

test('a process group is alive while any member answers; Windows keeps none (rec#97)', () => {
  const kill = code => () => { if (code) throw Object.assign(new Error('synthetic'), { code }); };
  assert.equal(processGroupAlive(4242, { platform: 'linux', kill: kill(null) }), true);
  assert.equal(processGroupAlive(4242, { platform: 'linux', kill: kill('ESRCH') }), false);
  assert.equal(processGroupAlive(4242, { platform: 'darwin', kill: kill('EPERM') }), true);
  assert.equal(processGroupAlive(4242, { platform: 'linux', kill: kill('EINVAL') }), null);
  assert.equal(processGroupAlive(4242, { platform: 'win32', kill: kill(null) }), false);
  let signalled;
  processGroupAlive(4242, { platform: 'linux', kill: (pid, signal) => { signalled = [pid, signal]; } });
  assert.deepEqual(signalled, [-4242, 0], 'only asks the group, never signals it');
});

test('a woken process is recorded as soon as spawn returns, before its spawn event (rec#97)', async () => {
  const seen = [];
  const running = runProcess(process.execPath, ['-e', ''], { input: '', timeoutMs: 10_000, onSpawn: pid => seen.push(pid) });
  assert.equal(seen.length, 1, 'recorded synchronously');
  assert.ok(Number.isSafeInteger(seen[0]) && seen[0] > 0);
  await running;
});

test('the address find_agents gives works as the to of message_agent, and a near-miss name is offered as a question (rec#110)', async () => {
  const { roundtable } = fixture({ wake: async () => { throw Object.assign(new Error('offline'), { code: 'client_unavailable' }); } });
  const [nova] = (await roundtable.findAgents({ query: 'Nova Lane' })).agents;
  const sent = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', to: nova.address, body: '请复核', wait: false });
  assert.equal(sent.status, 'queued');
  const missed = await roundtable.findAgents({ query: 'Nova Lan' });
  assert.ok(missed.agents.length, 'a substring still matches as before');
  const typo = await roundtable.findAgents({ query: 'Nova Lame' });
  assert.deepEqual([typo.agents, typo.didYouMean], [[], [{ agentId: 'reviewer-1', name: 'Nova Lane' }]]);
  await assert.rejects(roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', to: 'Nova Lame', body: 'x' }),
    /No active Agent matches "Nova Lame". Did you mean Nova Lane (reviewer-1)?/);
  const far = await roundtable.findAgents({ query: 'Zed Q' });
  assert.equal(far.didYouMean, undefined);
});

test('an Agent working with no project reads the status of the message it sent (rec#110)', async () => {
  const { roundtable } = fixture({ wake: async () => { throw Object.assign(new Error('offline'), { code: 'client_unavailable' }); } });
  const sent = await roundtable.messageAgent({ taskContextToken: 'token-global', sourceApplication: 'claude_code', to: 'reviewer-1', body: '请复核', wait: false });
  assert.equal((await roundtable.messageStatus({ taskContextToken: 'token-global', sourceApplication: 'claude_code', messageId: sent.messageId })).status, 'queued');
  // A project's task still does not reach a message of no project, nor the reverse.
  await assert.rejects(roundtable.messageStatus({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', messageId: sent.messageId }), /current project/);
  const projectSent = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', to: 'reviewer-1', body: '另一条' });
  await assert.rejects(roundtable.messageStatus({ taskContextToken: 'token-global', sourceApplication: 'claude_code', messageId: projectSent.messageId }), /current project/);
});

test('an Agent with no project answers only an ask of its own space (rec#110 review)', async () => {
  const { app, roundtable } = fixture({ wake: async () => { throw Object.assign(new Error('offline'), { code: 'client_unavailable' }); } });
  const reply = (messageId, body) => roundtable.replyMessage({ taskContextToken: 'token-nova-global', sourceApplication: 'codex', messageId, body });
  const foreign = await roundtable.messageAgent({ taskContextToken: 'token-global', sourceApplication: 'claude_code', to: 'reviewer-1', body: '另一个空间' });
  const before = roundtable.thread({ threadId: foreign.threadId });
  app.config.personal.spaceId = 'other-space';
  await assert.rejects(reply(foreign.messageId, 'synthetic cross-space reply'), /No such message for this Agent/);
  app.config.personal.spaceId = 'space';
  assert.deepEqual(roundtable.thread({ threadId: foreign.threadId }).messages.map(m => [m.kind, m.status]),
    before.messages.map(m => [m.kind, m.status]), 'nothing was written to the thread of the other space');
  // In its own space the same reply goes through; a project task still does not answer it.
  await assert.rejects(roundtable.replyMessage({ taskContextToken: 'token-nova', sourceApplication: 'codex', messageId: foreign.messageId, body: 'x' }),
    /No such message for this Agent/);
  await reply(foreign.messageId, '同空间回复');
  assert.equal((await roundtable.messageStatus({ taskContextToken: 'token-global', sourceApplication: 'claude_code', messageId: foreign.messageId })).status, 'answered');
});

test('an ask a runner sent wakes read-only with only FULI\'s MCP server, never in the folder it named, and records the runner', async () => {
  const { app, roundtable, woken } = fixture();
  app.fuliMcpServer = () => ({ command: '/synthetic/node', args: ['/synthetic/mcp-server.js'] });
  const ask = { taskContextToken: 'token-nova', sourceApplication: 'codex', to: 'Milo Reed', body: 'hello', projectPath: '/work/app' };

  const local = await roundtable.messageAgent(ask);
  const fromRunner = await runAsRunnerCall('runner-fingerprint-1', () => roundtable.messageAgent(ask));

  assert.equal(local.status, 'answered');
  assert.deepEqual([woken[0].mode, woken[0].cwd, 'mcpServers' in woken[0]], ['answer', '/work/app', false]);
  assert.equal(fromRunner.status, 'answered');
  assert.equal(woken[1].mode, 'read_only');
  assert.deepEqual(woken[1].mcpServers, { fuli: { command: '/synthetic/node', args: ['/synthetic/mcp-server.js'] } });
  assert.notEqual(woken[1].cwd, '/work/app');
  const [ask1] = roundtable.thread({ threadId: local.threadId }).messages;
  const [ask2] = roundtable.thread({ threadId: fromRunner.threadId }).messages;
  assert.equal('runner' in ask1.from, false);
  assert.equal(ask2.from.runner, 'runner-fingerprint-1');
});

test('a runner\'s folder is never one of this computer\'s, for a session or a visit request', async () => {
  const { app } = fixture();
  app.projectPathResolver = () => ({ status: 'matched', personalProjectId: 'app' });
  const host = createFuliRoundtableHost(app);
  assert.equal(await host.projectForPath('/work/app'), 'app');
  assert.equal(await host.folderBelongsTo('/work/app', 'app'), true);
  await runAsRunnerCall('runner-fingerprint-1', async () => {
    assert.equal(host.callerRunner(), 'runner-fingerprint-1');
    assert.equal(await host.projectForPath('/work/app'), null);
    assert.equal(await host.folderBelongsTo('/work/app', 'app'), false);
  });
  assert.equal(host.callerRunner(), null);
});

test('a chat message a runner sent wakes its member as the runner\'s ask: read-only, only FULI\'s MCP server', async t => {
  // Its member runs only in Codex, which takes asks from another computer on macOS and Linux.
  const { app, roundtable, woken } = fixture({ platform: 'darwin' });
  app.fuliMcpServer = () => ({ command: '/synthetic/node', args: ['/synthetic/mcp-server.js'] });
  t.after(() => roundtable.close());
  const chat = (action, data = {}) => roundtable.chat({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', action, ...data });
  const { chatId } = await runAsRunnerCall('runner-fingerprint-1',
    () => chat('create', { requestId: 'runner-room', kind: 'direct', members: ['local:reviewer-1'] }));
  await runAsRunnerCall('runner-fingerprint-1', () => chat('send', { chatId, requestId: 'runner-message', body: 'synthetic note' }));
  const { scheduler } = await import('node:timers/promises');
  for (let turn = 0; turn < 5 && !woken.length; turn += 1) await scheduler.yield();
  assert.equal(woken.length, 1);
  assert.equal(woken[0].mode, 'read_only');
  assert.deepEqual(Object.keys(woken[0].mcpServers), ['fuli']);
});

test('a session woken for a runner\'s ask holds its own asks the same way, one hop on; a local ask\'s report wake is unchanged', async () => {
  const fuliEntry = () => ({ command: '/synthetic/node', args: ['/synthetic/mcp-server.js'] });
  const ask = { taskContextToken: 'token-nova', sourceApplication: 'codex', to: 'Milo Reed', body: 'synthetic follow-up', projectPath: '/work/app' };

  const fromRunner = fixture();
  fromRunner.app.fuliMcpServer = fuliEntry;
  await runAsRunnerCall('runner-fingerprint-1', () => fromRunner.roundtable.messageAgent(ask));
  assert.equal(fromRunner.woken[0].origin, 'runner', 'the wake carries where its ask came from');
  assert.notEqual(fromRunner.woken[0].cwd, process.cwd(), 'a fresh session for a runner never starts in the console\'s folder');
  assert.match(fromRunner.woken[0].cwd, /fuli-roundtable-wake-/);
  assert.equal(existsSync(fromRunner.woken[0].cwd), false, 'the fallback folder made for that wake is gone after it');

  // The FLA woken above runs its own FULI with the origin its wake carried, and asks its report.
  const woken = fixture({ env: { FULI_ROUNDTABLE_DELEGATION: 'synthetic-grant', FULI_ROUNDTABLE_ORIGIN: 'runner' } });
  woken.app.fuliMcpServer = fuliEntry;
  const report = await woken.roundtable.messageAgent(ask);
  assert.equal(report.status, 'answered');
  assert.deepEqual([woken.woken[0].mode, woken.woken[0].origin, Object.keys(woken.woken[0].mcpServers)], ['read_only', 'runner', ['fuli']]);
  assert.notEqual(woken.woken[0].cwd, '/work/app');
  assert.equal(woken.roundtable.thread({ threadId: report.threadId }).messages[0].origin, 'runner');

  const local = fixture({ env: { FULI_ROUNDTABLE_DELEGATION: 'synthetic-grant' } });
  local.app.fuliMcpServer = fuliEntry;
  await local.roundtable.messageAgent(ask);
  assert.deepEqual([local.woken[0].mode, 'origin' in local.woken[0], 'mcpServers' in local.woken[0], local.woken[0].cwd],
    ['answer', false, false, '/work/app']);
});

test('a runner\'s ask nobody could answer gets no stand-in', async () => {
  const { roundtable } = fixture({ wake: async () => { throw Object.assign(new Error('offline'), { code: 'client_unavailable' }); } });
  const ask = { taskContextToken: 'token-nova', sourceApplication: 'codex', to: 'Milo Reed', body: 'synthetic ask' };
  const fromRunner = await runAsRunnerCall('runner-fingerprint-1', () => roundtable.messageAgent(ask));
  assert.equal(fromRunner.status, 'queued');
  assert.equal((await roundtable.messageAgent(ask)).status, 'stand_in', 'a local ask still gets one');
});

test('a wake passes its origin to the woken client\'s environment and drops one it inherited', async () => {
  const seen = [];
  const run = async (_command, _args, input) => {
    seen.push(input.env.FULI_ROUNDTABLE_ORIGIN);
    return { code: 0, stdout: [{ type: 'thread.started', thread_id: 'synthetic-session' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Answer' } }, { type: 'turn.completed' }].map(JSON.stringify).join('\n') };
  };
  const env = { FULI_CODEX_BIN: '/synthetic/codex', FULI_ROUNDTABLE_ORIGIN: 'remote' };
  await wakeAgent({ client: 'codex', cwd: '/synthetic', prompt: 'Review', delegationToken: 'grant', origin: 'runner', env, run,
    platform: 'linux' });
  await wakeAgent({ client: 'codex', cwd: '/synthetic', prompt: 'Review', delegationToken: 'grant', env, run });
  assert.deepEqual(seen, ['runner', undefined]);
});

test('on Windows an ask from another computer never wakes Codex: Claude Code takes it, or it is refused with the reason', async () => {
  assert.deepEqual(isolatedWakeClients('win32'), ['claude_code']);
  assert.deepEqual(isolatedWakeClients('darwin'), ['claude_code', 'codex']);
  assert.deepEqual(isolatedWakeClients('linux'), ['claude_code', 'codex']);
  const toNova = { taskContextToken: 'token-milo', sourceApplication: 'claude_code', to: 'reviewer-1', body: 'synthetic ask' };
  const toMilo = { taskContextToken: 'token-nova', sourceApplication: 'codex', to: 'Milo Reed', body: 'synthetic ask' };

  const windows = fixture({ platform: 'win32' });
  const refused = await runAsRunnerCall('runner-fingerprint-1', () => windows.roundtable.messageAgent(toNova));
  assert.equal(refused.status, 'queued');
  assert.equal(refused.reason, 'no_isolated_client');
  assert.match(refused.guidance, /only a read-only Claude Code session can take one/);
  await runAsRunnerCall('runner-fingerprint-1', () => windows.roundtable.messageAgent(toMilo));
  assert.deepEqual(windows.woken.map((input) => input.client), ['claude_code'], 'Milo is woken in Claude Code, never Codex');
  await windows.roundtable.messageAgent(toNova);
  assert.equal(windows.woken.at(-1).client, 'codex', 'a local ask still wakes Codex on Windows');

  const mac = fixture({ platform: 'darwin' });
  await runAsRunnerCall('runner-fingerprint-1', () => mac.roundtable.messageAgent(toNova));
  assert.deepEqual(mac.woken.map((input) => [input.client, input.mode]), [['codex', 'read_only']]);

  await assert.rejects(wakeAgent({ client: 'codex', cwd: '/synthetic', prompt: 'Review', origin: 'runner', platform: 'win32',
    env: { FULI_CODEX_BIN: '/synthetic/codex' }, run: async () => assert.fail('no process starts') }), { code: 'client_not_isolated' });
});
