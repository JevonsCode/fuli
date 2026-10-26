import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { callRoundtableTool } from '../src/agent-roundtable/tools.js';

// rec#55 @FLG: a group discussion where every member is really woken through
// its own executor and answers for itself. The executor here is a fake that
// records each call and answers as the member it was asked to restore; the
// roundtable, chat, delegation checks and store are the real ones. Synthetic
// data only.

const agent = (agentId, name, occupation, allowedClients = ['claude_code', 'codex']) => ({ agentId,
  occupation: { role: occupation }, assignments: [{ personalProjectId: 'app', status: 'active' }],
  profile: { name: occupation, displayName: name, status: 'active', responsibility: `${occupation} 的职责`,
    capabilities: [], allowedClients } });

const AGENTS = [agent('lead', 'Ada Lead', '负责人'), agent('dev', 'Jamie Ash', '开发'), agent('qa', 'Nova Lane', '测试'),
  agent('ux', 'Jade Lin', '设计'), agent('oc-only', 'Otto Cole', '运维', ['opencode'])];

function fixture({ answer = null, clientAvailable = () => true, agents = AGENTS, store = null } = {}) {
  const woken = [];
  const grants = [];
  const tasks = {
    'token-ada': { projectAgentId: 'lead', personalProjectId: 'app', sessionId: 'host-1', sourceApplication: 'claude_code' },
    'token-ada-2': { projectAgentId: 'lead', personalProjectId: 'app', sessionId: 'host-1', sourceApplication: 'claude_code' },
    'token-jamie': { projectAgentId: 'dev', personalProjectId: 'app', sessionId: 'host-2', sourceApplication: 'claude_code' }
  };
  const app = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => agents,
    taskContextRegistry: { context: async token => tasks[token] },
    personal: { recentAgentSessions: async () => [],
      listPersonalProjects: async () => [],
      issueAgentDelegation: async input => { grants.push(input); return { token: `grant-${grants.length}` }; },
      sealAgentDelegation: async () => ({}),
      verifyAgentDelegation: async () => ({ redeemed: true }),
      revokeAgentDelegation: async () => {} }
  };
  let id = 0;
  const roundtable = createAgentRoundtable({ host: createFuliRoundtableHost(app), openStore: () => store ?? createRoundtableStore(),
    idFactory: () => `id-${++id}`, locateCwd: () => null, clientAvailable,
    // The executor port: the woken client restores the member named by the
    // prompt's leading @{agentId} and answers as itself.
    wake: async input => {
      const member = /^@\{([^}]+)\}/u.exec(input.prompt)[1];
      woken.push({ member, client: input.client, prompt: input.prompt });
      const body = answer ? await answer(member, input) : `${member} 的观点`;
      return { body, sessionId: `session-${member}-${woken.length}` };
    } });
  const call = (action, data = {}, token = 'token-ada') => roundtable.discuss({ taskContextToken: token,
    sourceApplication: 'claude_code', action, ...data });
  const settle = async (chatId, token = 'token-ada') => {
    let view = await call('status', { chatId }, token);
    for (let i = 0; i < 50 && view.status === 'running'; i++) {
      view = await call('wait', { chatId, timeoutSeconds: 2, after: view.nextAfter }, token);
    }
    return call('status', { chatId }, token);
  };
  return { app, roundtable, woken, grants, call, settle };
}

const latest = view => Object.fromEntries(view.members.map(member => [member.agentId, member.status]));

test('every member is woken through its executor and replies for itself; one response round follows by default', async t => {
  const { roundtable, woken, grants, call, settle } = fixture();
  t.after(() => roundtable.close());
  const started = await call('start', { requestId: 'flg-1', question: '这个方案的产品体验和技术风险？', members: ['dev', 'qa'] });
  assert.equal(started.status, 'running');
  // Invited, and already waiting for the executor by the time start returns.
  assert.ok(started.members.every(member => ['invited', 'waiting'].includes(member.status)));
  const done = await settle(started.chatId);
  assert.equal(done.status, 'concluded');
  // Two rounds (views, then one response round), each member once per round.
  assert.deepEqual(woken.map(call => call.member).sort(), ['dev', 'dev', 'qa', 'qa']);
  assert.ok(woken.every(call => /^@\{(dev|qa)\} \[FULI 圆桌/u.test(call.prompt)));
  assert.match(woken.find(call => call.member === 'dev').prompt, /第 1 轮：各自观点[\s\S]*这个方案的产品体验和技术风险/u);
  // A response round shows each member only the others' views.
  const response = woken.filter(call => call.member === 'dev')[1].prompt;
  assert.match(response, /第 2 轮：回应其他成员/u);
  assert.match(response, /Nova Lane（测试）：qa 的观点/u);
  assert.doesNotMatch(response, /dev 的观点/u);
  // Each wake carried its own delegation for that member.
  assert.deepEqual(grants.map(grant => grant.agent_id).sort(), ['dev', 'dev', 'qa', 'qa']);
  assert.deepEqual(latest(done), { dev: 'replied', qa: 'replied' });
  assert.ok(done.turns.every(turn => turn.evidence?.messageId && /^(claude_code|codex):/u.test(turn.evidence.via)));
  // The chat holds the question and every reply, posted as the member that gave it.
  assert.deepEqual(done.messages.map(message => `${message.round ?? 0} ${message.from}`).sort(), [
    '0 主持 · Ada Lead（负责人）', '1 Jamie Ash（开发）', '1 Nova Lane（测试）', '2 Jamie Ash（开发）', '2 Nova Lane（测试）']);
  assert.deepEqual(done.summary.not_counted, []);
  const owner = await roundtable.chatOwner({ action: 'read', chatId: started.chatId });
  assert.equal(owner.kind, 'group');
  assert.deepEqual(owner.members.map(member => member.agentId).sort(), ['dev', 'lead', 'qa']);
});

test('the response rounds stop at the cap of two', async t => {
  const { roundtable, woken, call, settle } = fixture();
  t.after(() => roundtable.close());
  const { chatId } = await call('start', { requestId: 'flg-cap', question: '要不要拆分服务？', members: ['dev', 'qa', 'ux'],
    responseRounds: 2 });
  const done = await settle(chatId);
  assert.equal(done.round, 3);
  assert.equal(woken.length, 9);
  await assert.rejects(call('start', { requestId: 'flg-over', question: 'x', members: ['dev', 'qa'], responseRounds: 3 }),
    /responseRounds/u);
});

test('a member that fails or times out is shown as failed, gets no response round and is not counted', async t => {
  const { roundtable, woken, call, settle } = fixture({ answer: async member => {
    if (member === 'qa') throw Object.assign(new Error('timeout'), { code: 'wake_timeout' });
    return `${member} 的观点`;
  } });
  t.after(() => roundtable.close());
  const { chatId } = await call('start', { requestId: 'flg-fail', question: '发布节奏？', members: ['dev', 'qa', 'ux'] });
  const done = await settle(chatId);
  assert.equal(done.members.find(member => member.agentId === 'qa').status, 'failed');
  assert.equal(done.turns.find(turn => turn.agentId === 'qa').reason, 'wake_timeout');
  assert.deepEqual(done.summary.not_counted.map(item => item.name), ['Nova Lane（测试）']);
  // qa failed in round 1, so only dev and ux respond in round 2.
  assert.deepEqual(done.turns.filter(turn => turn.round === 2).map(turn => turn.agentId).sort(), ['dev', 'ux']);
  assert.equal(woken.filter(call => call.member === 'qa').length, 1);
  // The unanswered ask is withdrawn, not left waiting in the member's inbox.
  assert.deepEqual(roundtable.pending('qa'), []);
  // The summary must name the member that did not reply.
  await assert.rejects(call('summary', { chatId, requestId: 'sum-1', body: '共识：先灰度。来源 Jamie Ash · 第 1 轮' }),
    /Nova Lane/u);
  const summarized = await call('summary', { chatId, requestId: 'sum-2',
    body: '共识：先灰度（Jamie Ash、Jade Lin · 第 1 轮）。分歧：无。待决：Nova Lane 未回复，不计入。' });
  assert.equal(summarized.status, 'ended');
  assert.equal(summarized.summary.recorded, true);
  assert.match(summarized.messages.at(-1).body, /^【主持人总结】/u);
});

test('no executor available: nothing starts and nothing is faked', async t => {
  const { roundtable, woken, call } = fixture({ clientAvailable: () => false });
  t.after(() => roundtable.close());
  await assert.rejects(call('start', { requestId: 'flg-none', question: '谁来做？', members: ['dev', 'qa'] }),
    error => error.code === 'flg_no_executor');
  assert.equal(woken.length, 0);
  assert.deepEqual((await roundtable.chatOwner({ action: 'list' })).chats, []);
});

test('a member without an executor fails at once while the others are woken', async t => {
  const { roundtable, woken, call, settle } = fixture();
  t.after(() => roundtable.close());
  const { chatId } = await call('start', { requestId: 'flg-oc', question: '部署方案？', members: ['dev', 'oc-only'] });
  const done = await settle(chatId);
  assert.deepEqual(latest(done), { dev: 'replied', 'oc-only': 'failed' });
  assert.equal(done.turns.find(turn => turn.agentId === 'oc-only').reason, 'no_executor');
  assert.deepEqual(woken.map(call => call.member), ['dev']);
});

test('stop ends waiting members as not replied; a late answer is not counted', async t => {
  const release = Promise.withResolvers();
  const { roundtable, call } = fixture({ answer: async member => member === 'qa' ? release.promise : `${member} 的观点` });
  t.after(() => { release.resolve('迟到的观点'); return roundtable.close(); });
  const { chatId } = await call('start', { requestId: 'flg-stop', question: '要不要延期？', members: ['dev', 'qa'] });
  let view = await call('status', { chatId });
  for (let i = 0; i < 20 && view.members.find(member => member.agentId === 'dev').status !== 'replied'; i++) {
    view = await call('wait', { chatId, timeoutSeconds: 1 });
  }
  const stopped = await call('stop', { chatId });
  assert.equal(stopped.status, 'ended');
  assert.deepEqual(latest(stopped), { dev: 'replied', qa: 'ended' });
  assert.deepEqual(stopped.summary.not_counted.map(item => item.status), ['ended']);
  release.resolve('迟到的观点');
  const after = await call('status', { chatId });
  assert.ok(after.messages.every(message => !message.body.includes('迟到的观点')));
  assert.equal(after.status, 'ended');
});

test('a follow-up asks the same members in the same chat, or one member, without a new choice', async t => {
  const { roundtable, woken, call, settle } = fixture();
  t.after(() => roundtable.close());
  const { chatId } = await call('start', { requestId: 'flg-f', question: '缓存放哪层？', members: ['dev', 'qa'], responseRounds: 0 });
  await settle(chatId);
  assert.equal(woken.length, 2);
  // A later turn of the same moderator, with a fresh task token.
  await call('follow_up', { chatId, requestId: 'f-1', body: '如果流量翻倍呢？' }, 'token-ada-2');
  const all = await settle(chatId, 'token-ada-2');
  assert.equal(woken.length, 4);
  assert.match(woken[2].prompt, /追问[\s\S]*如果流量翻倍呢？/u);
  assert.match(woken[2].prompt, /缓存放哪层？/u);
  assert.equal(all.chatId, chatId);
  await call('follow_up', { chatId, requestId: 'f-2', body: '测试怎么覆盖？', to: 'qa' }, 'token-ada-2');
  const one = await settle(chatId, 'token-ada-2');
  assert.deepEqual(woken.slice(4).map(call => call.member), ['qa']);
  assert.deepEqual(one.turns.filter(turn => turn.round === one.round).map(turn => turn.agentId), ['qa']);
  await assert.rejects(call('follow_up', { chatId, requestId: 'f-3', body: 'x', to: 'ux' }), /not a member/u);
  // Only the moderator runs it.
  await assert.rejects(call('status', { chatId }, 'token-jamie'), /started this discussion/u);
});

test('the moderator cannot be a member, members must be active, and start is idempotent', async t => {
  const { roundtable, woken, call, settle } = fixture();
  t.after(() => roundtable.close());
  await assert.rejects(call('start', { requestId: 'flg-self', question: 'x', members: ['lead', 'dev'] }), /moderator/u);
  await assert.rejects(call('start', { requestId: 'flg-ghost', question: 'x', members: ['dev', 'ghost'] }), /ghost/u);
  const first = await call('start', { requestId: 'flg-same', question: '同一个请求', members: ['dev', 'qa'], responseRounds: 0 });
  const again = await call('start', { requestId: 'flg-same', question: '同一个请求', members: ['dev', 'qa'], responseRounds: 0 });
  assert.equal(again.chatId, first.chatId);
  await settle(first.chatId);
  assert.equal(woken.length, 2);
});

test('another process reads the same real states; a turn whose runner went away fails as interrupted', async t => {
  const store = createRoundtableStore();
  const hang = Promise.withResolvers();
  const runner = fixture({ store, answer: async () => hang.promise });
  const reader = fixture({ store });
  t.after(async () => { hang.resolve('x'); await runner.roundtable.close(); });
  const { chatId } = await runner.call('start', { requestId: 'flg-gone', question: '谁来值班？', members: ['dev', 'qa'] });
  assert.deepEqual(latest(await reader.call('status', { chatId })), { dev: 'waiting', qa: 'waiting' });
  // A turn left unsettled past its deadline by a process that went away.
  store.discussions.invite(chatId, 9, 'follow_up', ['ux'], Date.now() - 1);
  const seen = await reader.call('status', { chatId });
  assert.deepEqual(seen.turns.find(turn => turn.round === 9),
    { round: 9, kind: 'follow_up', agentId: 'ux', status: 'failed', reason: 'interrupted' });
  assert.equal(reader.woken.length, 0);
});

test('the person\'s stop from another process cancels the member wakes still running here', async t => {
  const store = createRoundtableStore();
  const cancelled = [];
  const runner = fixture({ store, answer: (member, input) => new Promise((_, reject) => {
    input.signal.addEventListener('abort', () => { cancelled.push(member);
      reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })); }, { once: true });
  }) });
  const entry = fixture({ store });
  t.after(() => runner.roundtable.close());
  const { chatId } = await runner.call('start', { requestId: 'flg-x', question: '要不要回滚？', members: ['dev', 'qa'] });
  const { setTimeout: delay } = await import('node:timers/promises');
  for (let i = 0; i < 100 && runner.woken.length < 2; i++) await delay(20);
  const stopped = await entry.roundtable.ownerStopGroupDiscussion({ requestId: 'flg-x' });
  assert.equal(stopped.status, 'ended');
  for (let i = 0; i < 100 && cancelled.length < 2; i++) await delay(20);
  assert.deepEqual(cancelled.sort(), ['dev', 'qa']);
  assert.deepEqual(latest(await runner.call('status', { chatId })), { dev: 'ended', qa: 'ended' });
});

test('the MCP tool reaches the same discussion and names its error codes', async t => {
  const { roundtable } = fixture({ clientAvailable: () => false });
  t.after(() => roundtable.close());
  await assert.rejects(callRoundtableTool(roundtable, 'group_discussion', { taskContextToken: 'token-ada',
    sourceApplication: 'claude_code', action: 'start', requestId: 'r', question: 'q', members: ['dev', 'qa'] }),
  error => error.code === 'flg_no_executor');
  await assert.rejects(callRoundtableTool(roundtable, 'group_discussion', { taskContextToken: 'token-ada',
    sourceApplication: 'claude_code', action: 'follow_up', chatId: 'c' }), error => error.code === 'flg_invalid');
});
