import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';

// An ask to a Codex FLA goes to its inbox conversation in the Codex app, which
// answers with reply_agent_message; nothing is woken headlessly.
const INBOX = '01a19859-0cb0-73b3-890f-e47e1c7e8dc0';
const agent = (agentId, name, allowedClients) => ({ agentId, employeeNumber: agentId === 'lead-1' ? '000001' : '000002',
  profile: { name, displayName: name, status: 'active', responsibility: `${name} 的职责`, capabilities: [], allowedClients } });

function fixture({ desktop = null, sessions = {} } = {}) {
  const agents = [agent('lead-1', 'Milo Reed', ['claude_code']), agent('reviewer-1', 'Nova Lane', ['codex'])];
  const tasks = {
    'token-milo': { projectAgentId: 'lead-1', personalProjectId: 'app', sessionId: 'cc-1', sourceApplication: 'claude_code' },
    'token-nova': { projectAgentId: 'reviewer-1', personalProjectId: 'app', sessionId: INBOX, sourceApplication: 'codex' },
    // The same inbox conversation, entered as the project lead its member reports to.
    'token-inbox-as-lead': { projectAgentId: 'lead-1', personalProjectId: 'app', sessionId: INBOX, sourceApplication: 'codex' },
    'token-milo-elsewhere': { projectAgentId: 'lead-1', personalProjectId: 'app', sessionId: 'codex-other', sourceApplication: 'codex' }
  };
  const app = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => agents,
    taskContextRegistry: { context: async token => tasks[token] },
    standingAssignments: createStandingAssignments(),
    personal: { recentAgentSessions: async ({ agentId }) => sessions[agentId] ?? [], listPersonalProjects: async () => [],
      issueAgentDelegation: async () => ({ token: 'synthetic-grant' }), verifyAgentDelegation: async () => ({ redeemed: true }),
      revokeAgentDelegation: async () => {} }
  };
  const woken = [];
  const store = createRoundtableStore();
  let id = 0;
  const roundtable = createAgentRoundtable({ host: createFuliRoundtableHost(app), env: {}, openStore: () => store,
    idFactory: () => `id-${++id}`, locateCwd: (client, sessionId) => `/work/${client}/${sessionId}`, clientAvailable: () => true,
    desktopApp: client => (client === 'codex' ? desktop : null),
    wake: async input => { woken.push(input); return { body: 'headless answer', sessionId: 'fork-1' }; } });
  return { roundtable, store, woken };
}

function fakeDesktop({ onHandOff = () => {}, createFails = false } = {}) {
  const calls = { created: [], handedOff: [] };
  return { calls, available: () => true,
    async createInbox(input) {
      calls.created.push(input);
      if (createFails) throw Object.assign(new Error('app missing'), { code: 'client_unavailable' });
      return INBOX;
    },
    async handOff(input) { calls.handedOff.push(input); await onHandOff(input); } };
}

test('an ask to a Codex FLA is queued in its Codex app inbox and the reply from there answers it', async () => {
  let reply;
  const desktop = fakeDesktop({ onHandOff: ({ message }) => {
    const messageId = /messageId="([^"]+)"/.exec(message)[1];
    // The app's conversation answers a moment later, from its own MCP process.
    reply = new Promise(resolve => setTimeout(() => resolve(f.roundtable.replyMessage({ taskContextToken: 'token-nova',
      sourceApplication: 'codex', messageId, body: '在 Codex 里看过了' })), 50));
  } });
  const f = fixture({ desktop });
  const result = await f.roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'Nova Lane', body: '帮我点一遍安装流程', timeoutSeconds: 30 });
  await reply;
  assert.equal(result.status, 'answered');
  assert.equal(result.reply, '在 Codex 里看过了');
  assert.equal(result.via, 'codex:inbox');
  assert.deepEqual(f.woken, [], 'nothing runs headlessly');
  assert.deepEqual(desktop.calls.created, [{ cwd: process.cwd(), greeting: 'FULI 圆桌会把发给「Nova Lane」的消息排进这个对话。现在只需回复「好」。' }]);
  const [handOff] = desktop.calls.handedOff;
  assert.equal(handOff.threadId, INBOX);
  assert.match(handOff.message, /^#FLA \{reviewer-1\} \[FULI 圆桌 · id-1\]/);
  assert.match(handOff.message, /帮我点一遍安装流程/);
  assert.match(handOff.message, /reply_agent_message（messageId="id-2"）/);
  const ask = f.store.getMessage('id-2');
  assert.equal(ask.to_client, 'codex');
  assert.equal(ask.to_session, INBOX);
  assert.equal(ask.execution_claim, 'finished', 'the hand-off holds no execution claim while the app works');
});

test('the inbox conversation is created once per Agent and project and reused', async () => {
  const desktop = fakeDesktop();
  const f = fixture({ desktop });
  for (const body of ['第一条', '第二条']) {
    const result = await f.roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
      to: 'Nova Lane', body, timeoutSeconds: 30, signal: AbortSignal.timeout(200) });
    assert.equal(result.status, 'queued');
    assert.equal(result.reason, 'waiting_in_desktop_app');
  }
  assert.equal(desktop.calls.created.length, 1);
  assert.deepEqual(desktop.calls.handedOff.map(call => call.threadId), [INBOX, INBOX]);
  // Still in the inbox: the conversation can read and answer them later.
  const inbox = await f.roundtable.readMessages({ taskContextToken: 'token-nova', sourceApplication: 'codex' });
  assert.deepEqual(inbox.messages.map(message => message.body ?? message.text).length, 2);
});

test('a hand-off that fails leaves the ask queued with the reason and wakes nothing headlessly', async () => {
  const f = fixture({ desktop: fakeDesktop({ createFails: true }) });
  const result = await f.roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'Nova Lane', body: '在吗', timeoutSeconds: 30 });
  assert.equal(result.status, 'stand_in');
  assert.equal(result.reason, 'client_unavailable');
  assert.deepEqual(f.woken, []);
  assert.equal(f.store.desktopInboxes.find({ spaceId: 'space', agentId: 'reviewer-1', projectId: 'app', client: 'codex' }), null);
});

test('without the Codex app an ask wakes Codex headlessly as before', async () => {
  const f = fixture();
  const result = await f.roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'Nova Lane', body: '在吗', timeoutSeconds: 30 });
  assert.equal(result.status, 'answered');
  assert.equal(result.reply, 'headless answer');
  assert.equal(f.woken[0].client, 'codex');
});

// rec#109 tier 1: the Agent's own latest Codex conversation, where the app queues
// the ask behind any running turn; its inbox conversation only when that fails.
const LAST = '01a19859-0cb0-73b3-890f-e47e1c7e8dc9';
const lastSession = { 'reviewer-1': [{ source_application: 'codex', session_id: LAST, personal_project_id: 'app' }] };

test('an ask goes into the Agent\'s latest Codex conversation before its inbox conversation', async () => {
  const desktop = fakeDesktop();
  const f = fixture({ desktop, sessions: lastSession });
  const result = await f.roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'Nova Lane', body: '续上次的评审', timeoutSeconds: 30, signal: AbortSignal.timeout(200) });
  assert.deepEqual([result.status, result.reason], ['queued', 'waiting_in_desktop_app']);
  assert.deepEqual(desktop.calls.handedOff.map(call => call.threadId), [LAST]);
  assert.deepEqual(desktop.calls.created, []);
  assert.equal(result.ladder.reached, 'resume');
  assert.deepEqual(result.ladder.steps.map(({ tier, session, outcome }) => [tier, session, outcome]), [['resume', LAST, 'handed_off']]);
});

test('when the latest Codex conversation refuses, the ask goes to the inbox conversation and the ladder says why', async () => {
  const desktop = fakeDesktop({ onHandOff: ({ threadId }) => {
    if (threadId === LAST) throw Object.assign(new Error('no such thread'), { code: 'codex_app_failed' });
  } });
  const f = fixture({ desktop, sessions: lastSession });
  const result = await f.roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'Nova Lane', body: '续上次的评审', timeoutSeconds: 30, signal: AbortSignal.timeout(200) });
  assert.deepEqual(desktop.calls.handedOff.map(call => call.threadId), [LAST, INBOX]);
  assert.equal(result.ladder.reached, 'new_session');
  assert.deepEqual(result.ladder.steps.map(({ tier, outcome, reason }) => [tier, outcome, reason]),
    // Nova may not run in the sender's Claude Code, so its new session is its own Codex inbox.
    [['resume', 'failed', 'codex_app_failed'], ['new_session', 'skipped', 'client_not_allowed'], ['new_session', 'handed_off', null]]);
  assert.match(result.ladder.steps[0].why, /Codex 桌面端/);
});

test('the conversation an ask was handed to answers for its recipient, whichever FLA its task was entered as', async () => {
  let handed;
  const desktop = fakeDesktop({ onHandOff: ({ message }) => { handed = /messageId="([^"]+)"/.exec(message)[1]; } });
  const f = fixture({ desktop });
  const pending = f.roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'Nova Lane', body: '看一下顶栏版本号', timeoutSeconds: 30 });
  while (!handed) await new Promise(resolve => setTimeout(resolve, 5));
  // Another conversation of the lead is not where the ask went.
  await assert.rejects(f.roundtable.replyMessage({ taskContextToken: 'token-milo-elsewhere', sourceApplication: 'codex',
    messageId: handed, body: '不该送达' }), /No such message for this Agent/);
  const sent = await f.roundtable.replyMessage({ taskContextToken: 'token-inbox-as-lead', sourceApplication: 'codex',
    messageId: handed, body: '顶栏显示 v0.25.2，没有红点' });
  assert.equal(sent.status, 'sent');
  const result = await pending;
  assert.deepEqual([result.status, result.reply, result.via], ['answered', '顶栏显示 v0.25.2，没有红点', 'codex:inbox']);
  const reply = f.store.messages(result.threadId).find(message => message.kind === 'reply');
  assert.deepEqual([reply.from_agent, reply.from_name, reply.from_session], ['reviewer-1', 'Nova Lane', INBOX],
    'the answer is recorded as the recipient, from the conversation it was handed to');
});
