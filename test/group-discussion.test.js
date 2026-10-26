import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { wakeArguments } from '../packages/roundtable/src/roundtable/wake.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { callRoundtableTool } from '../src/agent-roundtable/tools.js';

// rec#55 @FLG: a group discussion where every member is really woken through
// its own executor and answers for itself. The executor here is a fake at the
// roundtable's wake port that records each call and answers as the member it
// was asked to restore; the roundtable, chat, delegation checks and store are
// the real ones. What the person typed reaches the roundtable the way the task
// entry records it (confirmGroupDiscussion, requestGroupFollowUp). Synthetic
// data only.

const agent = (agentId, name, occupation, allowedClients = ['claude_code', 'codex']) => ({ agentId,
  occupation: { role: occupation }, assignments: [{ personalProjectId: 'app', status: 'active' }],
  profile: { name: occupation, displayName: name, status: 'active', responsibility: `${occupation}的职责`,
    capabilities: [], allowedClients } });

const AGENTS = [agent('lead', 'Ada Lead', '负责人'), agent('dev', 'Jamie Ash', '开发'), agent('qa', 'Nova Lane', '测试'),
  agent('ux', 'Jade Lin', '设计'), agent('oc-only', 'Otto Cole', '运维', ['opencode'])];

function fixture({ answer = null, clientAvailable = () => true, agents = AGENTS, store = null, redeemed = true,
  env = {}, now = Date.now } = {}) {
  const woken = [];
  const grants = [];
  const roster = { agents: [...agents] };
  const tasks = {
    'token-ada': { projectAgentId: 'lead', personalProjectId: 'app', sessionId: 'host-1', sourceApplication: 'claude_code' },
    'token-ada-2': { projectAgentId: 'lead', personalProjectId: 'app', sessionId: 'host-1', sourceApplication: 'claude_code' },
    'token-jamie': { projectAgentId: 'dev', personalProjectId: 'app', sessionId: 'host-2', sourceApplication: 'claude_code' }
  };
  const app = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => roster.agents,
    taskContextRegistry: { context: async token => tasks[token] },
    personal: { recentAgentSessions: async () => [],
      listPersonalProjects: async () => [],
      issueAgentDelegation: async input => { grants.push(input); return { token: `grant-${grants.length}` }; },
      sealAgentDelegation: async () => ({}),
      verifyAgentDelegation: async () => ({ redeemed }),
      revokeAgentDelegation: async () => {} }
  };
  let id = 0;
  const roundtable = createAgentRoundtable({ host: createFuliRoundtableHost(app), openStore: () => store ?? createRoundtableStore(),
    idFactory: () => `id-${++id}`, locateCwd: () => null, clientAvailable, env, now,
    // The executor port: the woken client restores the member named by the
    // prompt's leading @{agentId} and answers as itself.
    wake: async input => {
      const member = /^@\{([^}]+)\}/u.exec(input.prompt)[1];
      woken.push({ member, client: input.client, prompt: input.prompt, sessionId: input.sessionId, readOnly: input.readOnly });
      const body = answer ? await answer(member, input) : `${member} 的观点`;
      return { body, sessionId: `session-${member}-${woken.length}` };
    } });
  const call = (action, data = {}, token = 'token-ada') => roundtable.discuss({ taskContextToken: token,
    sourceApplication: 'claude_code', action, ...data });
  // What the person's @FLG entry records: the confirmed members, then a follow-up.
  const confirm = (requestId, members, question = '这个方案的产品体验和技术风险？') =>
    roundtable.confirmGroupDiscussion({ requestId, agentId: 'lead', projectId: 'app', question, members });
  const start = async (requestId, members, extra = {}) => {
    confirm(requestId, members, extra.question);
    return call('start', { requestId, ...(extra.responseRounds !== undefined ? { responseRounds: extra.responseRounds } : {}) });
  };
  const ask = (requestId, body, to = null) => roundtable.requestGroupFollowUp({ requestId, body, to });
  const settle = async (chatId, token = 'token-ada') => {
    let view = await call('status', { chatId }, token);
    for (let i = 0; i < 50 && view.status === 'running'; i++) {
      view = await call('wait', { chatId, timeoutSeconds: 2, after: view.nextAfter }, token);
    }
    return call('status', { chatId }, token);
  };
  return { app, roster, roundtable, woken, grants, call, confirm, start, ask, settle };
}

const latest = view => Object.fromEntries(view.members.map(member => [member.agentId, member.status]));
const memberPosts = async (roundtable, chatId) => (await roundtable.chatOwner({ action: 'read', chatId })).messages
  .filter(message => message.from !== 'local:lead');
async function until(condition) {
  for (let i = 0; i < 200 && !condition(); i++) await delay(10);
  assert.ok(condition(), 'condition not reached');
}

test('every member is woken in a fresh read-only session and replies for itself; one response round follows', async t => {
  const { roundtable, woken, grants, start, settle } = fixture();
  t.after(() => roundtable.close());
  const started = await start('flg-1', ['dev', 'qa']);
  assert.equal(started.status, 'running');
  assert.ok(started.members.every(member => ['invited', 'waiting'].includes(member.status)));
  const done = await settle(started.chatId);
  assert.equal(done.status, 'concluded');
  // Views, then one response round, each member once per round.
  assert.deepEqual(woken.map(call => call.member).sort(), ['dev', 'dev', 'qa', 'qa']);
  // Fresh sessions (no resume of the member's history), read-only.
  assert.ok(woken.every(call => call.sessionId === null && call.readOnly === true));
  assert.ok(woken.every(call => /^@\{(dev|qa)\} \[FULI 圆桌/u.test(call.prompt)));
  const view = woken.find(call => call.member === 'dev').prompt;
  assert.match(view, /第 1 轮：各自观点[\s\S]*你是 Jamie Ash（开发），职责：开发的职责[\s\S]*这个方案的产品体验和技术风险/u);
  // A response round shows each member only the others' views.
  const response = woken.filter(call => call.member === 'dev')[1].prompt;
  assert.match(response, /第 2 轮：回应其他成员[\s\S]*Nova Lane（测试）：qa 的观点/u);
  assert.doesNotMatch(response, /dev 的观点/u);
  assert.deepEqual(grants.map(grant => grant.agent_id).sort(), ['dev', 'dev', 'qa', 'qa']);
  assert.deepEqual(latest(done), { dev: 'replied', qa: 'replied' });
  assert.ok(done.turns.every(turn => turn.evidence?.messageId && /^(claude_code|codex):new$/u.test(turn.evidence.via)));
  assert.deepEqual((await memberPosts(roundtable, started.chatId)).map(message => message.from).sort(),
    ['local:dev', 'local:dev', 'local:qa', 'local:qa']);
  assert.deepEqual(done.summary.not_counted, []);
});

test('a discussion wake runs Claude Code in plan mode; Codex stays in its read-only sandbox', () => {
  const claude = wakeArguments('claude_code', { readOnly: true });
  assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'plan');
  const ordinary = wakeArguments('claude_code', {});
  assert.equal(ordinary[ordinary.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(wakeArguments('codex', { cwd: '/synthetic', readOnly: true }).includes('read-only'));
});

test('the response rounds stop at the cap of two', async t => {
  const { roundtable, woken, start, call, settle } = fixture();
  t.after(() => roundtable.close());
  const { chatId } = await start('flg-cap', ['dev', 'qa', 'ux'], { responseRounds: 2 });
  assert.equal((await settle(chatId)).round, 3);
  assert.equal(woken.length, 9);
  await assert.rejects(call('start', { requestId: 'flg-cap', responseRounds: 3 }), error => error.code === 'flg_invalid');
});

test('a failed or timed-out member is failed, gets no response round, and FULI writes it into the summary as not replied', async t => {
  const { roundtable, woken, start, call, settle } = fixture({ answer: async member => {
    if (member === 'qa') throw Object.assign(new Error('timeout'), { code: 'wake_timeout' });
    return `${member} 的观点`;
  } });
  t.after(() => roundtable.close());
  const { chatId } = await start('flg-fail', ['dev', 'qa', 'ux']);
  const done = await settle(chatId);
  assert.equal(done.turns.find(turn => turn.agentId === 'qa').reason, 'wake_timeout');
  assert.deepEqual(done.summary.not_counted.map(item => item.name), ['Nova Lane（测试）']);
  assert.deepEqual(done.turns.filter(turn => turn.round === 2).map(turn => turn.agentId).sort(), ['dev', 'ux']);
  assert.equal(woken.filter(call => call.member === 'qa').length, 1);
  // The unanswered ask is withdrawn, not left waiting in the member's inbox.
  assert.deepEqual(roundtable.pending('qa'), []);
  // Whatever the moderator writes, FULI appends who did not reply.
  const summarized = await call('summary', { chatId, requestId: 'sum-1', body: '共识：大家都同意先灰度。' });
  assert.equal(summarized.status, 'ended');
  assert.equal(summarized.summary.recorded, true);
  assert.deepEqual(summarized.messages.map(message => message.seq), [summarized.messages.at(-1).seq]);
  assert.match(summarized.messages.at(-1).body, /^【主持人总结】共识：大家都同意先灰度。\n\n未回复、不计入结论：Nova Lane（测试）（failed：wake_timeout）$/u);
});

test('an unverified wake is never posted', async t => {
  const { roundtable, start, settle } = fixture({ redeemed: false });
  t.after(() => roundtable.close());
  const { chatId } = await start('flg-unverified', ['dev', 'qa']);
  const done = await settle(chatId);
  assert.deepEqual(latest(done), { dev: 'failed', qa: 'failed' });
  assert.ok(done.turns.every(turn => turn.reason === 'delegation_not_redeemed'));
  assert.deepEqual(await memberPosts(roundtable, chatId), []);
});

test('no executor available: nothing starts and nothing is faked; one member without one fails at once', async t => {
  const none = fixture({ clientAvailable: () => false });
  t.after(() => none.roundtable.close());
  await assert.rejects(none.start('flg-none', ['dev', 'qa']), error => error.code === 'flg_no_executor');
  assert.equal(none.woken.length, 0);
  assert.deepEqual((await none.roundtable.chatOwner({ action: 'list' })).chats, []);
  const some = fixture();
  t.after(() => some.roundtable.close());
  const { chatId } = await some.start('flg-oc', ['dev', 'oc-only']);
  const done = await some.settle(chatId);
  assert.deepEqual(latest(done), { dev: 'replied', 'oc-only': 'failed' });
  assert.equal(done.turns.find(turn => turn.agentId === 'oc-only').reason, 'no_executor');
  assert.deepEqual(some.woken.map(call => call.member), ['dev']);
});

test('start runs only what the person confirmed: a forged request, another moderator or a stopped choice is refused', async t => {
  const { roundtable, woken, call, confirm, start, settle } = fixture();
  t.after(() => roundtable.close());
  await assert.rejects(call('start', { requestId: 'flg-forged' }), error => error.code === 'flg_not_confirmed');
  confirm('flg-mine', ['dev', 'qa']);
  await assert.rejects(call('start', { requestId: 'flg-mine' }, 'token-jamie'), error => error.code === 'flg_not_moderator');
  // Members and question come from the confirmation, not from the caller.
  const first = await call('start', { requestId: 'flg-mine', members: ['ux', 'oc-only'], question: '别的问题' });
  assert.deepEqual(first.members.map(member => member.agentId), ['dev', 'qa']);
  assert.equal(first.question, '这个方案的产品体验和技术风险？');
  assert.equal((await call('start', { requestId: 'flg-mine' })).chatId, first.chatId);
  await settle(first.chatId);
  assert.equal(woken.length, 4);
  confirm('flg-stopped', ['dev', 'qa']);
  await roundtable.ownerStopGroupDiscussion({ requestId: 'flg-stopped' });
  await assert.rejects(call('start', { requestId: 'flg-stopped' }), error => error.code === 'flg_ended');
  await assert.rejects(start('flg-self', ['lead', 'dev']), error => error.code === 'flg_moderator_member');
});

test('a woken Agent cannot start or continue a discussion', async t => {
  const { roundtable, start } = fixture({ env: { FULI_ROUNDTABLE_DELEGATION: 'synthetic-grant' } });
  t.after(() => roundtable.close());
  await assert.rejects(start('flg-nested', ['dev', 'qa']), error => error.code === 'flg_delegated_wake');
});

test('follow-ups: only the person\'s own @FLG entry asks one, each once, to the confirmed members, at most five', async t => {
  const { roundtable, woken, start, call, ask, settle } = fixture();
  t.after(() => roundtable.close());
  const { chatId } = await start('flg-f', ['dev', 'qa'], { responseRounds: 0 });
  await settle(chatId);
  assert.equal(woken.length, 2);
  await assert.rejects(call('follow_up', { chatId }), error => error.code === 'flg_follow_up_not_requested');
  // The moderator adds a member through agent_chat: it is never woken by the discussion.
  const room = await roundtable.chat({ taskContextToken: 'token-ada', sourceApplication: 'claude_code', action: 'read', chatId });
  await roundtable.chat({ taskContextToken: 'token-ada', sourceApplication: 'claude_code', action: 'members', chatId,
    expectedRevision: room.revision, add: ['local:ux'] });
  assert.deepEqual(ask('flg-f', '如果流量翻倍呢？'), { recorded: true });
  const asked = await call('follow_up', { chatId }, 'token-ada-2');
  assert.match(asked.messages[0].body, /^【用户追问】如果流量翻倍呢？$/u);
  await settle(chatId, 'token-ada-2');
  assert.deepEqual(woken.slice(2).map(call => call.member).sort(), ['dev', 'qa']);
  assert.match(woken[2].prompt, /追问[\s\S]*如果流量翻倍呢？/u);
  // Carried out once.
  await assert.rejects(call('follow_up', { chatId }), error => error.code === 'flg_follow_up_not_requested');
  ask('flg-f', '测试怎么覆盖？', 'qa');
  await call('follow_up', { chatId });
  const one = await settle(chatId);
  assert.deepEqual(woken.slice(4).map(call => call.member), ['qa']);
  assert.deepEqual(one.turns.filter(turn => turn.round === one.round).map(turn => turn.agentId), ['qa']);
  for (let i = 3; i <= 5; i++) {
    ask('flg-f', `第 ${i} 次追问`);
    await call('follow_up', { chatId });
    await settle(chatId);
  }
  assert.equal((await call('status', { chatId })).followUps, 5);
  assert.deepEqual(ask('flg-f', '第 6 次追问'), { refused: 'limit' });
  await assert.rejects(call('follow_up', { chatId }), error => error.code === 'flg_follow_up_limit');
  assert.ok(!woken.some(call => call.member === 'ux'));
  // Only the moderator runs it.
  await assert.rejects(call('status', { chatId }, 'token-jamie'), /started this discussion/u);
});

test('a dismissed member is reported unavailable on a follow-up, and a follow-up nobody can answer posts nothing', async t => {
  const { roundtable, roster, woken, start, call, ask, settle } = fixture();
  t.after(() => roundtable.close());
  const { chatId } = await start('flg-gone', ['dev', 'qa'], { responseRounds: 0 });
  await settle(chatId);
  roster.agents = roster.agents.filter(agent => agent.agentId !== 'qa');
  ask('flg-gone', '只问 Nova', 'qa');
  await assert.rejects(call('follow_up', { chatId }), error => error.code === 'flg_member_unavailable');
  assert.ok((await roundtable.chatOwner({ action: 'read', chatId })).messages.every(message => !message.body.includes('只问 Nova')));
  ask('flg-gone', '大家再看看');
  await call('follow_up', { chatId });
  const done = await settle(chatId);
  assert.deepEqual(done.turns.filter(turn => turn.round === done.round)
    .map(turn => [turn.agentId, turn.status, turn.reason ?? null]), [['dev', 'replied', null], ['qa', 'failed', 'unavailable']]);
  assert.deepEqual(woken.slice(2).map(call => call.member), ['dev']);
});

test('stop ends waiting members as not replied; a late answer is not posted', async t => {
  const release = Promise.withResolvers();
  const { roundtable, start, call } = fixture({ answer: async member => member === 'qa' ? release.promise : `${member} 的观点` });
  t.after(() => { release.resolve('迟到的观点'); return roundtable.close(); });
  const { chatId } = await start('flg-stop', ['dev', 'qa']);
  let view = await call('status', { chatId });
  for (let i = 0; i < 20 && view.members.find(member => member.agentId === 'dev').status !== 'replied'; i++) {
    view = await call('wait', { chatId, timeoutSeconds: 1 });
  }
  const stopped = await call('stop', { chatId });
  assert.equal(stopped.status, 'ended');
  assert.deepEqual(stopped.messages, []);
  assert.deepEqual(latest(stopped), { dev: 'replied', qa: 'ended' });
  release.resolve('迟到的观点');
  await delay(50);
  assert.ok((await memberPosts(roundtable, chatId)).every(message => !message.body.includes('迟到的观点')));
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
  const { chatId } = await runner.start('flg-x', ['dev', 'qa']);
  await until(() => runner.woken.length === 2);
  assert.equal((await entry.roundtable.ownerStopGroupDiscussion({ requestId: 'flg-x' })).status, 'ended');
  await until(() => cancelled.length === 2);
  assert.deepEqual(latest(await runner.call('status', { chatId })), { dev: 'ended', qa: 'ended' });
});

test('a late answer to a turn already failed elsewhere is not posted; a live runner\'s turn is never failed under it', async t => {
  const store = createRoundtableStore();
  const answers = { dev: Promise.withResolvers(), qa: Promise.withResolvers() };
  let offset = 0;
  const runner = fixture({ store, now: () => Date.now() + offset, answer: member => answers[member].promise });
  const reader = fixture({ store, now: () => Date.now() + 2 * 60_000 });
  t.after(() => { answers.dev.resolve('x'); answers.qa.resolve('x'); return runner.roundtable.close(); });
  const { chatId } = await runner.start('flg-late', ['dev', 'qa']);
  await until(() => runner.woken.length === 2);
  // Past every deadline, but the runner is alive in this process: its turns stay open.
  offset = 60 * 60_000;
  assert.deepEqual(latest(await runner.call('status', { chatId })), { dev: 'waiting', qa: 'waiting' });
  offset = 0;
  // Another process sees no heartbeat for over a minute: the runner is gone, its turns failed.
  const seen = await reader.call('status', { chatId });
  assert.deepEqual(latest(seen), { dev: 'failed', qa: 'failed' });
  assert.ok(seen.turns.every(turn => turn.reason === 'interrupted'));
  answers.dev.resolve('迟到的观点');
  answers.qa.resolve('也迟到了');
  await until(() => runner.roundtable && true);
  await delay(50);
  assert.deepEqual(await memberPosts(runner.roundtable, chatId), []);
  assert.deepEqual(latest(await reader.call('status', { chatId })), { dev: 'failed', qa: 'failed' });
});

test('a member woken elsewhere at the moment is shown as busy; a long reply is bounded in UTF-16 units', async t => {
  const hold = Promise.withResolvers();
  const { roundtable, start, settle } = fixture({ answer: async member => member === 'qa'
    ? hold.promise : '😀'.repeat(9_000) });
  t.after(() => { hold.resolve('x'); return roundtable.close(); });
  await start('flg-a', ['qa', 'ux']);
  const { chatId } = await start('flg-b', ['qa', 'dev'], { responseRounds: 0 });
  const done = await settle(chatId);
  const busy = done.turns.find(turn => turn.agentId === 'qa');
  assert.deepEqual([busy.status, busy.reason], ['failed', 'busy']);
  const [post] = await memberPosts(roundtable, chatId);
  assert.ok(post.body.length <= 16_000);
  assert.doesNotMatch(post.body, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  assert.match(post.body, /…（已截断）$/u);
});

test('the MCP tool reaches the same discussion and names its error codes', async t => {
  const { roundtable, confirm } = fixture({ clientAvailable: () => false });
  t.after(() => roundtable.close());
  confirm('r', ['dev', 'qa']);
  await assert.rejects(callRoundtableTool(roundtable, 'group_discussion', { taskContextToken: 'token-ada',
    sourceApplication: 'claude_code', action: 'start', requestId: 'r' }), error => error.code === 'flg_no_executor');
  await assert.rejects(callRoundtableTool(roundtable, 'group_discussion', { taskContextToken: 'token-ada',
    sourceApplication: 'claude_code', action: 'summary', chatId: 'c' }), error => error.code === 'flg_invalid');
});
