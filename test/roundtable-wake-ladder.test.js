import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';

// rec#109 「找 FLA AAA 做 X」: the recipient's latest session, else a new session
// as it (the sender's client first), else this session stands in (代入); every
// result says which tier held the ask and why each earlier one did not.
// Synthetic Agents, sessions and clients only.

const agent = (agentId, name, allowedClients) => ({ agentId, profile: { name, displayName: name, status: 'active',
  responsibility: `${name} 的职责`, capabilities: [], allowedClients } });

function fixture({ wake = null, sessions = {}, clientAvailable = () => true, turnRunning = () => false,
  locateCwd = (client, sessionId) => `/work/${client}/${sessionId}`, grant = null } = {}) {
  const agents = [agent('lead-1', 'Milo Reed', ['claude_code', 'codex']), agent('jamie-1', 'Jamie Ash', ['claude_code', 'codex'])];
  const tasks = {
    'token-milo': { projectAgentId: 'lead-1', personalProjectId: 'app', sessionId: 'cc-milo', sourceApplication: 'claude_code' },
    'token-milo-codex': { projectAgentId: 'lead-1', personalProjectId: 'app', sessionId: 'cx-milo', sourceApplication: 'codex' },
    'token-jamie': { projectAgentId: 'jamie-1', personalProjectId: 'app', sessionId: 'cx-jamie-next', sourceApplication: 'codex' },
    // A task outside every project (a global assistant's), as in the 11-10 session.
    'token-global': { projectAgentId: null, personalProjectId: null, sessionId: 'cc-global', sourceApplication: 'claude_code' }
  };
  const woken = [], grants = [];
  const app = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => agents,
    taskContextRegistry: { context: async token => tasks[token] },
    standingAssignments: createStandingAssignments(),
    personal: { recentAgentSessions: async ({ agentId }) => sessions[agentId] ?? [], listPersonalProjects: async () => [],
      issueAgentDelegation: async input => {
        grants.push(input);
        if (grant) await grant(input);
        return { token: `synthetic-grant-${grants.length}` };
      },
      verifyAgentDelegation: async () => ({ redeemed: true }), revokeAgentDelegation: async () => {} }
  };
  let id = 0;
  const roundtable = createAgentRoundtable({ host: createFuliRoundtableHost(app), env: {}, openStore: () => createRoundtableStore(),
    idFactory: () => `id-${++id}`, locateCwd, turnRunning, clientAvailable,
    wake: async input => { woken.push(input); return wake ? wake(input) : { body: 'Jamie 的结论', sessionId: input.sessionId ?? 'fresh-1' }; } });
  return { roundtable, woken, grants };
}

const steps = ladder => ladder.steps.map(({ tier, client, session, outcome, reason }) => [tier, client, session, outcome, reason]);
const lastCodex = { 'jamie-1': [{ source_application: 'codex', session_id: 'cx-jamie', personal_project_id: 'app' }] };
const ask = (roundtable, input = {}) => roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
  to: 'Jamie Ash', body: '去找 Jamie Ash 评审登录重构', ...input });

test('tier 1: Jamie is brought back in the Codex session it last worked in, and the answer returns here', async () => {
  const { roundtable, woken } = fixture({ sessions: lastCodex });
  const result = await ask(roundtable);
  assert.deepEqual([result.status, result.reply, result.via], ['answered', 'Jamie 的结论', 'codex:resume']);
  assert.deepEqual([woken[0].client, woken[0].sessionId], ['codex', 'cx-jamie']);
  assert.equal(result.ladder.reached, 'resume');
  assert.deepEqual(steps(result.ladder), [['resume', 'codex', 'cx-jamie', 'answered', null]]);
});

test('tier 2: a running or vanished last session is passed over for a new Jamie session in the sender\'s client', async () => {
  for (const [setup, reason] of [[{ turnRunning: () => true }, 'session_busy'], [{ locateCwd: () => null }, 'session_not_found']]) {
    const { roundtable, woken } = fixture({ sessions: lastCodex, ...setup });
    const result = await ask(roundtable);
    assert.equal(result.status, 'answered');
    assert.equal(result.via, 'claude_code:new', 'the new session opens in the client the person is in');
    assert.ok(woken.every(input => input.sessionId === null), 'a running turn is never joined');
    assert.equal(result.ladder.reached, 'new_session');
    assert.deepEqual(steps(result.ladder), [['resume', 'codex', 'cx-jamie', 'skipped', reason],
      ['new_session', 'claude_code', null, 'answered', null]]);
    assert.ok(result.ladder.steps[0].why);
  }
});

test('tier 3: with no session to open, this session stands in for Jamie, labelled, and each FLA keeps its own record', async () => {
  const { roundtable, woken } = fixture({ clientAvailable: () => false });
  const result = await ask(roundtable);
  assert.deepEqual([result.status, result.reason, woken.length], ['stand_in', 'no_client', 0]);
  assert.deepEqual(steps(result.ladder), [['resume', null, null, 'skipped', 'no_previous_session'],
    ['new_session', 'claude_code', null, 'skipped', 'client_unavailable']]);
  assert.equal(result.ladder.reached, 'stand_in');
  const { standIn } = result;
  assert.equal(standIn.present, '在场：Milo Reed & Jamie Ash（代入）');
  assert.equal(standIn.speaker, '【Jamie Ash · 代入】');
  // Only Jamie's shareable index, never its working memory.
  assert.deepEqual(standIn.scope.members.map(member => member.agent_id), ['jamie-1']);
  assert.match(standIn.scope.withheld, /working memory/);
  // The receipt names the real executor: this client and session, never Jamie's own client.
  assert.deepEqual(standIn.receipt.executor, { client: 'claude_code', session: 'cc-milo', model: '-' });
  assert.match(standIn.receipt.markdown, /^代入：Jamie Ash（实际执行：Claude Code 本会话，模型 -；不是 Jamie Ash 自己的客户端）$/);

  // Jamie still has the ask until someone answers it.
  assert.deepEqual(roundtable.pending('jamie-1').map(item => item.messageId), [result.messageId]);
  const status = await roundtable.messageStatus({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', messageId: result.messageId });
  assert.deepEqual([status.status, status.delivery], ['stand_in', 'stand_in']);

  // Another session of Milo cannot answer for this stand-in.
  await assert.rejects(roundtable.replyMessage({ taskContextToken: 'token-milo-codex', sourceApplication: 'codex',
    messageId: result.messageId, body: 'not this session' }), /No such message/);
  const left = await roundtable.replyMessage({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    messageId: result.messageId, body: '登录重构：会话过期处理缺测试，其余可合并' });
  assert.deepEqual([left.status, left.standIn], ['sent', true]);

  const thread = roundtable.thread({ threadId: result.threadId });
  assert.deepEqual(thread.messages.map(({ kind, from, to, via }) => [kind, from.name, from.client, to.name, via]), [
    ['ask', 'Milo Reed', 'claude_code', 'Jamie Ash', 'claude_code:stand_in'],
    ['reply', 'Jamie Ash', 'claude_code', 'Milo Reed', 'claude_code:stand_in'],
    ['handback', 'Milo Reed', 'claude_code', 'Jamie Ash', 'claude_code:stand_in']]);
  assert.deepEqual(roundtable.pending('jamie-1'), []);
  // Milo wrote the answer itself: nothing waits in Milo's inbox. Jamie gets its increment once.
  assert.deepEqual(roundtable.agentReplies('lead-1', 'app'), []);
  assert.deepEqual(roundtable.standInHandbacks('lead-1', 'app'), []);
  const [announced] = roundtable.standInHandbacks('jamie-1', 'app');
  assert.equal(announced.inReplyTo, result.messageId);
  const inbox = await roundtable.readMessages({ taskContextToken: 'token-jamie', sourceApplication: 'codex' });
  assert.deepEqual(inbox.handbacks.map(item => item.body), ['登录重构：会话过期处理缺测试，其余可合并']);
  assert.match(inbox.handbacksGuidance, /代入/);
  assert.deepEqual(inbox.messages, []);
});

test('tier 3: Jamie answering its own ask first wins over the stand-in', async () => {
  const { roundtable } = fixture({ clientAvailable: () => false });
  const result = await ask(roundtable);
  await roundtable.replyMessage({ taskContextToken: 'token-jamie', sourceApplication: 'codex', messageId: result.messageId, body: '我自己来答' });
  await assert.rejects(roundtable.replyMessage({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    messageId: result.messageId, body: 'stand-in answer' }), /No such message/);
  assert.deepEqual(roundtable.standInHandbacks('jamie-1', 'app'), []);
});

test('the same FLA in another session is reached by naming that session, not refused as itself', async () => {
  const { roundtable, woken, grants } = fixture({ sessions: {
    'lead-1': [{ source_application: 'codex', session_id: 'cx-milo-other', personal_project_id: 'app' },
      { source_application: 'claude_code', session_id: 'cc-milo', personal_project_id: 'app' }] } });
  const bare = await ask(roundtable, { to: 'Milo Reed' }).catch(error => error);
  assert.match(bare.message, /Milo Reed is the current task's own FLA\. To reach another session of it, pass conversation: "cx-milo-other" \(Codex\)/);
  await assert.rejects(ask(roundtable, { to: 'Milo Reed', conversation: 'cc-milo' }), /current task's own FLA/);
  const result = await ask(roundtable, { to: 'Milo Reed', conversation: 'cx-milo-other' });
  assert.deepEqual([result.status, result.via], ['answered', 'codex:resume']);
  assert.deepEqual([woken[0].client, woken[0].sessionId, grants[0].agent_id], ['codex', 'cx-milo-other', 'lead-1']);
});

test('every failure says why and moves on; wait never ends in a bare queued', async () => {
  // A task outside every project cannot grant a wake: both tiers say so, then the session stands in.
  const global = fixture({ sessions: lastCodex });
  const fromGlobal = await ask(global.roundtable, { taskContextToken: 'token-global' });
  assert.equal(fromGlobal.status, 'stand_in');
  assert.deepEqual(steps(fromGlobal.ladder), [['resume', null, null, 'skipped', 'sender_without_project'],
    ['new_session', null, null, 'skipped', 'sender_without_project']]);
  assert.equal(global.woken.length, 0);
  assert.equal(fromGlobal.standIn.present, '在场：Claude Code & Jamie Ash（代入）');

  // Each failed attempt is named, then the next tier runs.
  const failing = fixture({ sessions: lastCodex, wake: async ({ sessionId }) => {
    if (sessionId) throw Object.assign(new Error('refused'), { code: 'wake_failed' });
    throw Object.assign(new Error('not logged in'), { code: 'client_login_required' });
  } });
  const result = await ask(failing.roundtable);
  assert.equal(result.status, 'stand_in');
  assert.deepEqual(steps(result.ladder), [['resume', 'codex', 'cx-jamie', 'failed', 'wake_failed'],
    ['new_session', 'claude_code', null, 'failed', 'client_login_required'], ['new_session', 'codex', null, 'failed', 'client_login_required']]);

  // The team rules refusing Jamie stop the ladder: no other client and no stand-in.
  const refused = fixture({ sessions: lastCodex, grant: async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); } });
  const denied = await ask(refused.roundtable);
  assert.deepEqual([denied.status, denied.reason, refused.grants.length], ['queued', 'not_permitted', 1]);
  assert.equal(denied.standIn, undefined);

  // A session that may still be working is not doubled by a stand-in.
  const slow = fixture({ sessions: lastCodex, wake: async () => { throw Object.assign(new Error('late'), { code: 'wake_timeout' }); } });
  const late = await ask(slow.roundtable);
  assert.deepEqual([late.status, late.reason, late.delivery], ['queued', 'wake_timeout', 'unconfirmed']);
  assert.deepEqual(steps(late.ladder), [['resume', 'codex', 'cx-jamie', 'failed', 'wake_timeout']]);
});
