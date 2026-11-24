import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { DataFormatError } from '../packages/roundtable/src/storage/data-format-error.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { callRoundtableTool } from '../src/agent-roundtable/tools.js';

// rec#55 #FLG: a group discussion where every member is really woken through
// its own executor and answers for itself. The executor here is a fake at the
// roundtable's wake port that records each call and answers as the member it
// was asked to restore; the roundtable, chat, delegation checks and store are
// the real ones. What the person typed reaches the roundtable the way the task
// entry records it (recordGroupChoice, requestGroupFollowUp). Synthetic
// data only.

const agent = (agentId, name, occupation, allowedClients = ['claude_code', 'codex']) => ({ agentId,
  occupation: { role: occupation }, assignments: [{ personalProjectId: 'app', status: 'active' }],
  profile: { name: occupation, displayName: name, status: 'active', responsibility: `${occupation}的职责`,
    capabilities: [], allowedClients } });

const AGENTS = [agent('lead', 'Ada Lead', '负责人'), agent('dev', 'Jamie Ash', '开发'), agent('qa', 'Nova Lane', '测试'),
  agent('ux', 'Jade Lin', '设计'), agent('oc-only', 'Otto Cole', '运维', ['opencode'])];

function fixture({ answer = null, clientAvailable = () => true, agents = AGENTS, store = null, redeemed = true,
  env = {}, now = Date.now, resumable = false, fuliMcp = null } = {}) {
  const woken = [];
  const grants = [];
  const roster = { agents: [...agents] };
  const tasks = {
    'token-ada': { projectAgentId: 'lead', personalProjectId: 'app', sessionId: 'host-1', sourceApplication: 'claude_code' },
    'token-ada-2': { projectAgentId: 'lead', personalProjectId: 'app', sessionId: 'host-1', sourceApplication: 'claude_code' },
    'token-jamie': { projectAgentId: 'dev', personalProjectId: 'app', sessionId: 'host-2', sourceApplication: 'claude_code' },
    // Sessions the person opened in clients FULI cannot wake (rec#129): Astro outside any project, an FLA in one.
    'token-astro-oc': { projectAgentId: 'employee.assistant', personalProjectId: null, sessionId: 'oc-1', sourceApplication: 'opencode' },
    'token-astro-cursor': { projectAgentId: 'employee.assistant', personalProjectId: null, sessionId: 'cur-1', sourceApplication: 'cursor' },
    'token-jade-cursor': { projectAgentId: 'ux', personalProjectId: 'app', sessionId: 'cur-2', sourceApplication: 'cursor' }
  };
  // Each member's earlier sessions, when a wake may resume one (rec#129 rounds).
  const sessions = [];
  const app = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => roster.agents,
    taskContextRegistry: { context: async token => tasks[token] },
    personal: { recentAgentSessions: async ({ agentId }) => resumable ? sessions.filter(item => item.agent === agentId)
      .map(item => ({ source_application: item.client, session_id: item.sessionId, personal_project_id: 'app',
        last_active: '2026-11-13T00:00:00Z' })) : [],
      listPersonalProjects: async () => [],
      issueAgentDelegation: async input => { grants.push(input); return { token: `grant-${grants.length}` }; },
      sealAgentDelegation: async () => ({}),
      verifyAgentDelegation: async () => ({ redeemed }),
      revokeAgentDelegation: async () => {} }
  };
  if (fuliMcp) app.fuliMcpServer = fuliMcp;
  let id = 0;
  const roundtable = createAgentRoundtable({ host: createFuliRoundtableHost(app), openStore: () => store ?? createRoundtableStore(),
    idFactory: () => `id-${++id}`, locateCwd: (client, sessionId) => resumable && sessionId ? '/synthetic/app' : null,
    clientAvailable, env, now,
    // The executor port: the woken client restores the member named by the
    // prompt's leading #FLA {agentId} and answers as itself. Claude Code
    // reports its model on its init event; Codex reports none.
    wake: async input => {
      const member = /^#FLA \{([^}]+)\}/u.exec(input.prompt)[1];
      woken.push({ member, client: input.client, prompt: input.prompt, sessionId: input.sessionId, mode: input.mode,
        mcpServers: input.mcpServers ?? null });
      const body = answer ? await answer(member, input) : `${member} 的观点`;
      const sessionId = `session-${member}-${woken.length}`;
      sessions.push({ agent: member, client: input.client, sessionId });
      return { body, sessionId, ...(input.client === 'claude_code' ? { model: 'synthetic-model-a' } : {}) };
    } });
  const call = (action, data = {}, token = 'token-ada') => roundtable.discuss({ taskContextToken: token,
    sourceApplication: tasks[token]?.sourceApplication ?? 'claude_code', action, ...data });
  // What the person's #FLG entry records: the confirmed members, then a follow-up.
  const confirm = (requestId, members, question = '这个方案的产品体验和技术风险？', options = {}) =>
    roundtable.recordGroupChoice({ requestId, agentId: 'lead', projectId: 'app', question, members, ...options });
  const start = async (requestId, members, extra = {}) => {
    confirm(requestId, members, extra.question, extra.options);
    return call('start', { requestId, ...(extra.responseRounds !== undefined ? { responseRounds: extra.responseRounds } : {}) });
  };
  // The person's `#FLG 加入 <code>` in a session of another client, as task entry passes it.
  const join = (code, token, name = 'Astro', model = null) => roundtable.joinGroupDiscussion({ code,
    agentId: tasks[token].projectAgentId, name, projectId: tasks[token].personalProjectId,
    client: tasks[token].sourceApplication, sessionId: tasks[token].sessionId, ...(model ? { model } : {}) });
  const ask = (requestId, body, to = null) => roundtable.requestGroupFollowUp({ requestId, body, to });
  const settle = async (chatId, token = 'token-ada') => {
    let view = await call('status', { chatId }, token);
    for (let i = 0; i < 50 && view.status === 'running'; i++) {
      view = await call('wait', { chatId, timeoutSeconds: 2, after: view.nextAfter }, token);
    }
    return call('status', { chatId }, token);
  };
  return { app, roster, roundtable, woken, grants, call, confirm, start, ask, settle, join, tasks };
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
  assert.ok(woken.every(call => call.sessionId === null && call.mode === 'read_only'));
  assert.ok(woken.every(call => /^#FLA \{(dev|qa)\} \[FULI 圆桌/u.test(call.prompt)));
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
  // FULI cannot name its own MCP entry here: the member's client keeps its own servers.
  assert.ok(woken.every(call => call.mcpServers === null));
});

test('a woken member loads only the MCP server of FULI where FULI can name it', async t => {
  const entry = { command: '/synthetic/node', args: ['/synthetic/mcp-server.js'] };
  const { roundtable, woken, start, settle } = fixture({ fuliMcp: client => (client === 'claude_code' ? entry : null) });
  t.after(() => roundtable.close());
  const done = await settle((await start('flg-mcp', ['dev', 'qa'])).chatId);
  assert.equal(done.status, 'concluded');
  assert.ok(woken.length >= 2);
  for (const call of woken) assert.deepEqual(call.mcpServers, call.client === 'claude_code' ? { fuli: entry } : null);
});

test('a member that falls back to its other client is given that client’s own entry or none', async t => {
  const entry = { command: '/synthetic/node', args: ['/synthetic/mcp-server.js'] };
  // Claude Code is not installed here, so every turn runs in Codex, whose entry FULI cannot name.
  const unnamed = fixture({ fuliMcp: client => (client === 'claude_code' ? entry : null), clientAvailable: client => client === 'codex' });
  t.after(() => unnamed.roundtable.close());
  assert.equal((await unnamed.settle((await unnamed.start('flg-codex', ['dev'])).chatId)).status, 'concluded');
  assert.ok(unnamed.woken.length && unnamed.woken.every(call => call.client === 'codex' && call.mcpServers === null));
  const named = fixture({ fuliMcp: () => entry, clientAvailable: client => client === 'codex' });
  t.after(() => named.roundtable.close());
  assert.equal((await named.settle((await named.start('flg-codex-2', ['dev'])).chatId)).status, 'concluded');
  assert.ok(named.woken.length && named.woken.every(call => call.client === 'codex'));
  for (const call of named.woken) assert.deepEqual(call.mcpServers, { fuli: entry });
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

test('follow-ups: only the person\'s own #FLG entry asks one, each once, to the confirmed members, at most five', async t => {
  const { roundtable, woken, start, call, ask, settle } = fixture();
  t.after(() => roundtable.close());
  const { chatId } = await start('flg-f', ['dev', 'qa'], { responseRounds: 0 });
  await settle(chatId);
  assert.equal(woken.length, 2);
  await assert.rejects(call('follow_up', { chatId }), error => error.code === 'flg_follow_up_not_requested');
  // The discussion's chat is not managed through agent_chat, even by its host (rec#129).
  await assert.rejects(roundtable.chat({ taskContextToken: 'token-ada', sourceApplication: 'claude_code', action: 'members',
    chatId, expectedRevision: 1, add: ['local:ux'] }), error => error.code === 'chat_group_discussion');
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

test('a heartbeat that cannot be written never crashes: a busy file beats again, a moved store ends the run as interrupted', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = createRoundtableStore();
  const cancelled = [];
  const runner = fixture({ store, answer: (member, input) => new Promise((_, reject) => {
    input.signal.addEventListener('abort', () => { cancelled.push(member);
      reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })); }, { once: true });
  }) });
  t.after(() => runner.roundtable.close());
  const { chatId } = await runner.start('flg-beat', ['dev', 'qa']);
  await until(() => runner.woken.length === 2);
  const heartbeat = store.discussions.heartbeat;
  store.discussions.heartbeat = () => { throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }); };
  t.mock.timers.tick(20_000);
  await delay(20);
  assert.deepEqual(cancelled, []);
  store.discussions.heartbeat = () => {
    throw new DataFormatError('roundtable', 'data_format_changed_underneath', 'Synthetic store moved underneath');
  };
  t.mock.timers.tick(20_000);
  await until(() => cancelled.length === 2);
  store.discussions.heartbeat = heartbeat;
  await delay(20);
  const done = await runner.call('status', { chatId });
  assert.deepEqual(latest(done), { dev: 'failed', qa: 'failed' });
  assert.ok(done.turns.every(turn => turn.reason === 'interrupted'));
  assert.equal(done.status, 'concluded');
});

test('a start refused for good ends the person\'s choice; an unstarted choice expires after ten minutes', async t => {
  let offset = 0;
  const none = fixture({ clientAvailable: () => false, now: () => Date.now() + offset });
  t.after(() => none.roundtable.close());
  await assert.rejects(none.start('flg-dead', ['dev', 'qa']), error => error.code === 'flg_no_executor');
  assert.equal(none.roundtable.groupDiscussionStatus({ requestId: 'flg-dead' }).status, 'ended');
  none.confirm('flg-old', ['dev', 'qa']);
  assert.equal(none.roundtable.groupDiscussionStatus({ requestId: 'flg-old' }).status, 'confirmed');
  offset = 11 * 60_000;
  assert.equal(none.roundtable.groupDiscussionStatus({ requestId: 'flg-old' }).status, 'ended');
  await assert.rejects(none.call('start', { requestId: 'flg-old' }), error => error.code === 'flg_ended');
});

test('a follow-up whose post fails waits again for the next call', async t => {
  const store = createRoundtableStore();
  const { roundtable, woken, start, call, ask, settle } = fixture({ store });
  t.after(() => roundtable.close());
  const { chatId } = await start('flg-retry', ['dev', 'qa'], { responseRounds: 0 });
  await settle(chatId);
  ask('flg-retry', '再看看');
  const append = store.chat.append;
  store.chat.append = () => { throw new Error('Synthetic send failure'); };
  await assert.rejects(call('follow_up', { chatId }), /Synthetic send failure/u);
  store.chat.append = append;
  assert.equal((await call('status', { chatId })).followUps, 0);
  assert.equal(woken.length, 2);
  // The same follow-up is carried out on the next call, once.
  await call('follow_up', { chatId });
  assert.equal((await settle(chatId)).followUps, 1);
  assert.equal(woken.length, 4);
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

// rec#129: joining by code from any connected client, who said what with which
// client and model, host-led rounds with a limit, and short or long groups.
const code = view => /^#FLG 加入 ([2-9A-HJKMNP-Z]{4})$/u.exec(view.join)?.[1];
const member = (view, key) => view.members.find(item => item.member === key);

test('joining by code: any connected session joins as its FLA (Astro outside a project), replies itself, and the host sees it', async t => {
  const { roundtable, start, settle, call, join } = fixture();
  t.after(() => roundtable.close());
  const started = await start('flg-join', ['dev', 'qa'], { responseRounds: 0 });
  const joinCode = code(started);
  assert.ok(joinCode, started.join);
  const done = await settle(started.chatId);
  // Case-insensitive; the excerpt is bounded.
  const { joined } = await join(joinCode.toLowerCase(), 'token-astro-oc');
  assert.equal(joined.fresh, true);
  assert.equal(joined.question, '这个方案的产品体验和技术风险？');
  assert.ok(joined.excerpt.length <= 5 && joined.excerpt.every(message => message.body.length <= 310));
  assert.ok(joined.open);
  assert.match(joined.member, /^join:\d+$/u);
  // Joining again from the same session is the same membership, said once.
  assert.equal((await join(joinCode, 'token-astro-oc')).joined.fresh, false);
  const status = await call('status', { chatId: started.chatId });
  const astro = member(status, joined.member);
  assert.deepEqual([astro.source, astro.client, astro.status, astro.name], ['joined', 'opencode', 'waiting', 'Astro · OpenCode']);
  assert.deepEqual([member(status, 'dev').source, member(status, 'dev').client], ['woken', 'claude_code']);
  assert.equal(status.waitingForJoined, true);
  assert.match(status.guidance, /Joined members are never woken/u);
  // The member reads a bounded page and answers with the model its client states; FULI records the client itself.
  const read = await call('read', { chatId: started.chatId }, 'token-astro-oc');
  assert.ok(read.messages.length <= 10);
  assert.match(read.guidance, /never guessed[\s\S]*Read-only/u);
  const reply = await call('reply', { chatId: started.chatId, body: 'Astro 的观点', model: 'synthetic-model-b' }, 'token-astro-oc');
  assert.equal(reply.by, 'OpenCode · synthetic-model-b');
  await assert.rejects(call('reply', { chatId: started.chatId, body: '再说一次' }, 'token-astro-oc'),
    error => error.code === 'flg_no_turn');
  const after = await call('status', { chatId: started.chatId, after: done.nextAfter });
  assert.deepEqual(after.messages.map(message => [message.from, message.by]), [['Astro · OpenCode', 'OpenCode · synthetic-model-b']]);
  const all = await call('status', { chatId: started.chatId });
  // The host reported no model: unknown, never guessed.
  assert.ok(all.messages.filter(message => message.from.startsWith('主持')).every(message => message.by === 'Claude Code · unknown'));
  assert.equal(member(all, joined.member).status, 'replied');
  // A session that did not join cannot read or post.
  await assert.rejects(call('read', { chatId: started.chatId }, 'token-astro-cursor'), error => error.code === 'flg_not_member');
});

test('a joined or woken member can never host: no rounds, follow-ups, removals or summaries from them', async t => {
  const { roundtable, start, settle, call, join, ask } = fixture();
  t.after(() => roundtable.close());
  const started = await start('flg-host', ['dev', 'qa'], { responseRounds: 0 });
  await settle(started.chatId);
  const { chatId } = started;
  // The host FLA in its own project is the host, never a member.
  assert.deepEqual(await roundtable.joinGroupDiscussion({ code: code(started), agentId: 'lead', name: 'Ada', projectId: 'app',
    client: 'cursor', sessionId: 'cur-9' }), { refused: 'host' });
  await join(code(started), 'token-jade-cursor', 'Jade Lin');
  ask('flg-host', '追问');
  for (const [action, data] of [['round', { to: ['dev'], questions: ['为什么？'] }], ['remove', { member: 'dev' }],
    ['follow_up', {}], ['summary', { requestId: 's', body: '总结' }], ['stop', {}]]) {
    await assert.rejects(call(action, { chatId, ...data }, 'token-jade-cursor'),
      error => ['flg_not_moderator', 'flg_member_not_host', 'chat_task_required', 'chat_not_found'].includes(error.code), action);
  }
  // A woken session cannot join, and an unknown code joins nothing.
  const wokenSession = fixture({ env: { FULI_ROUNDTABLE_DELEGATION: 'synthetic-grant' } });
  t.after(() => wokenSession.roundtable.close());
  assert.deepEqual(await wokenSession.join(code(started), 'token-astro-oc'), { refused: 'woken' });
  assert.deepEqual(await join('ZZZZ', 'token-astro-cursor'), { refused: 'unknown' });
});

test('the host removes a joined member; woken and joined members together are capped at six', async t => {
  const { roundtable, start, settle, call, join, tasks } = fixture();
  t.after(() => roundtable.close());
  const started = await start('flg-cap6', ['dev', 'qa', 'ux'], { responseRounds: 0 });
  await settle(started.chatId);
  const { chatId } = started;
  const first = (await join(code(started), 'token-astro-oc')).joined;
  await join(code(started), 'token-astro-cursor');
  for (let n = 0; n < 2; n++) {
    tasks[`token-extra-${n}`] = { projectAgentId: 'employee.assistant', personalProjectId: null, sessionId: `x-${n}`,
      sourceApplication: 'other' };
  }
  assert.ok((await join(code(started), 'token-extra-0')).joined);
  assert.deepEqual(await join(code(started), 'token-extra-1'), { refused: 'full', limit: 6 });
  const removed = await call('remove', { chatId, member: first.member });
  assert.equal(removed.members.some(item => item.member === first.member), false);
  await assert.rejects(call('reply', { chatId, body: '还在吗' }, 'token-astro-oc'), error => error.code === 'flg_not_member');
  assert.ok((await join(code(started), 'token-extra-1')).joined);
  await assert.rejects(call('remove', { chatId, member: 'join:999' }), error => error.code === 'flg_not_member');
});

test('host-led rounds: questions to named members, woken again in their own session, joined ones on their next turn, up to the limit', async t => {
  const { roundtable, woken, start, settle, call, join } = fixture({ resumable: true });
  t.after(() => roundtable.close());
  const started = await start('flg-rounds', ['dev', 'qa'], { responseRounds: 0 });
  await settle(started.chatId);
  const { joined } = await join(code(started), 'token-astro-oc');
  await call('reply', { chatId: started.chatId, body: 'Astro 的观点' }, 'token-astro-oc');
  const turns = (agentId = 'employee.assistant') => roundtable.groupDiscussionTurns({ client: 'opencode', sessionId: 'oc-1',
    agentId });
  // Nothing new for the joined session until the host asks it.
  assert.deepEqual(await turns(), []);
  const before = woken.length;
  const devSession = woken.find(item => item.member === 'dev');
  const round = await call('round', { chatId: started.chatId, to: ['dev', joined.member],
    questions: ['灰度比例定多少？', '回滚条件是什么？'] });
  assert.equal(round.hostRound, 2);
  assert.match(round.messages[0].body, /^【第 2 轮 · 主持人提问 → Jamie Ash（开发）、Astro · OpenCode】\n1\. 灰度比例定多少？\n2\. 回滚条件是什么？$/u);
  const done = await settle(started.chatId);
  // Only the named woken member is woken, in the session it answered from before.
  assert.deepEqual(woken.slice(before).map(item => [item.member, item.sessionId]),
    [['dev', `session-dev-${woken.indexOf(devSession) + 1}`]]);
  assert.match(woken.at(-1).prompt, /第 2 轮：主持人提问[\s\S]*灰度比例定多少/u);
  assert.equal(member(done, 'qa').round, 1);
  // The joined member sees the round on its turns until it answers, and only as the FLA that joined;
  // the host is told to have the person nudge it.
  assert.match(done.guidance, /Ask the person to send any message/u);
  const shown = await turns();
  assert.deepEqual(shown.map(item => [item.member, item.round]), [[joined.member, done.round]]);
  assert.match(shown[0].latest.body, /灰度比例/u);
  assert.equal((await turns()).length, 1);
  assert.deepEqual(await turns('dev'), []);
  await call('reply', { chatId: started.chatId, body: '回滚看错误率' }, 'token-astro-oc');
  assert.deepEqual(await turns(), []);
  // Round 3 is the last of the default three; a fourth is refused and the guidance says to conclude.
  await call('round', { chatId: started.chatId, to: ['qa'], questions: ['测试够吗？'] });
  const third = await settle(started.chatId);
  assert.equal(third.hostRound, 3);
  assert.match(third.guidance, /round limit is reached/u);
  await assert.rejects(call('round', { chatId: started.chatId, to: ['qa'], questions: ['再来'] }),
    error => error.code === 'flg_round_limit');
  // Without a limit the host may go on; a non-member is refused.
  const open = fixture();
  t.after(() => open.roundtable.close());
  const free = await open.start('flg-free', ['dev', 'qa'], { responseRounds: 0, options: { roundLimit: 0 } });
  await open.settle(free.chatId);
  for (let n = 0; n < 3; n++) {
    await open.call('round', { chatId: free.chatId, to: ['qa'], questions: [`第 ${n} 问`] });
    await open.settle(free.chatId);
  }
  assert.equal((await open.call('status', { chatId: free.chatId })).roundLimit, null);
  await assert.rejects(open.call('round', { chatId: free.chatId, to: ['ux'], questions: ['?'] }), error => error.code === 'flg_not_member');
});

test('short and long: a short discussion\'s code dies with its summary; a long group keeps it and starts a new topic', async t => {
  const { roundtable, woken, start, settle, call, join, ask } = fixture();
  t.after(() => roundtable.close());
  const short = await start('flg-short', ['dev', 'qa'], { responseRounds: 0 });
  await settle(short.chatId);
  assert.equal(short.lifetime, 'short');
  const summarized = await call('summary', { chatId: short.chatId, requestId: 's-1', body: '结论' });
  assert.equal(summarized.status, 'ended');
  assert.equal(summarized.join, undefined);
  assert.deepEqual(await join(code(short), 'token-astro-oc'), { refused: 'unknown' });
  const long = await start('flg-long', ['dev', 'qa'], { responseRounds: 0, options: { lifetime: 'long' } });
  await settle(long.chatId);
  await join(code(long), 'token-astro-cursor');
  const kept = await call('summary', { chatId: long.chatId, requestId: 's-2', body: '第一个话题的结论' });
  assert.deepEqual([kept.status, kept.join, kept.summary.not_counted.map(item => item.name)],
    ['concluded', long.join, ['Astro · Cursor']]);
  assert.match(kept.guidance, /new topic/u);
  // The code still joins, and the person's next #FLG text is a new topic, beyond the follow-up count.
  const later = (await join(code(long), 'token-astro-oc')).joined;
  assert.equal(later.open, false);
  assert.equal(roundtable.groupDiscussionStatus({ requestId: 'flg-long' }).nextTopic, true);
  assert.deepEqual(ask('flg-long', '第二个话题：要不要拆服务？'), { recorded: true });
  const before = woken.length;
  const topic = await call('follow_up', { chatId: long.chatId });
  assert.deepEqual([topic.topic, topic.question, topic.hostRound], [2, '第二个话题：要不要拆服务？', 1]);
  assert.match(topic.messages[0].body, /^【新话题】第二个话题/u);
  const second = await settle(long.chatId);
  assert.deepEqual(woken.slice(before).map(item => item.member).sort(), ['dev', 'qa']);
  assert.equal(member(second, later.member).status, 'invited');
  assert.equal(second.summary.recorded, false);
  // Stopping a long group ends its code too.
  await call('stop', { chatId: long.chatId });
  assert.deepEqual(await join(code(long), 'token-jade-cursor'), { refused: 'unknown' });
});

test('a woken Claude Code member\'s model comes from its client, a Codex one is unknown; nothing grants edits', async t => {
  const { roundtable, woken, start, settle } = fixture({ agents: [agent('lead', 'Ada Lead', '负责人'),
    agent('dev', 'Jamie Ash', '开发', ['claude_code']), agent('qa', 'Nova Lane', '测试', ['codex'])] });
  t.after(() => roundtable.close());
  const { chatId } = await start('flg-models', ['dev', 'qa'], { responseRounds: 0 });
  const done = await settle(chatId);
  assert.deepEqual([member(done, 'dev').client, member(done, 'dev').model], ['claude_code', 'synthetic-model-a']);
  assert.deepEqual([member(done, 'qa').client, member(done, 'qa').model], ['codex', 'unknown']);
  assert.ok(woken.every(item => item.mode === 'read_only'));
  assert.match(done.guidance, /authorizes no edits or publishing/u);
});

// rec#129 review: the chat behind a discussion has no side door, removal is
// immediate and complete, failed posts lose nothing, codes are bounded.
const chatAs = (roundtable, token, request) => roundtable.chat({ taskContextToken: token, sourceApplication: 'claude_code',
  ...request });

test('the chat behind a discussion is reached only through group_discussion: no reads, posts, membership or mention wakes', async t => {
  const { roundtable, woken, start, settle, call, join } = fixture();
  t.after(() => roundtable.close());
  const started = await start('flg-door', ['dev', 'qa'], { responseRounds: 0 });
  await settle(started.chatId);
  const { chatId } = started;
  await join(code(started), 'token-jade-cursor', 'Jade Lin');
  // A woken member's ordinary session and the joined FLA's: agent_chat is refused, pointing to group_discussion.
  for (const token of ['token-jamie', 'token-jade-cursor', 'token-ada']) {
    for (const request of [{ action: 'read', chatId }, { action: 'send', chatId, requestId: `x-${token}`, body: '插话 @{local:qa}' },
      { action: 'members', chatId, expectedRevision: 1, remove: ['local:qa'] }, { action: 'wait', chatId, timeoutSeconds: 1 }]) {
      await assert.rejects(chatAs(roundtable, token, request), error => error.code === 'chat_group_discussion'
        && /group_discussion/u.test(error.message), `${token} ${request.action}`);
    }
  }
  // A host question that mentions a member wakes nobody but the members it names through the discussion.
  const before = woken.length;
  await call('round', { chatId, to: ['join:1'], questions: ['@{local:qa} 你怎么看？'] });
  await settle(chatId);
  assert.equal(woken.length, before);
  // The person's own console still reads it.
  assert.ok((await roundtable.chatOwner({ action: 'read', chatId })).messages.length > 0);
  // Removing a woken member takes it out of the chat too.
  await call('remove', { chatId, member: 'qa' });
  const room = await roundtable.chatOwner({ action: 'read', chatId });
  assert.ok(!room.members.some(item => item.address === 'local:qa'));
});

test('a member removed mid-round is out at once: never picked for the response round', async t => {
  const gate = Promise.withResolvers();
  const { roundtable, woken, start, settle, call } = fixture({ answer: async member => member === 'dev' ? 'dev 的观点'
    : gate.promise.then(() => `${member} 的观点`) });
  t.after(() => { gate.resolve(); return roundtable.close(); });
  const { chatId } = await start('flg-mid', ['dev', 'qa', 'ux'], { responseRounds: 1 });
  let view = await call('status', { chatId });
  for (let i = 0; i < 50 && member(view, 'dev').status !== 'replied'; i++) view = await call('wait', { chatId, timeoutSeconds: 1 });
  const removed = await call('remove', { chatId, member: 'dev' });
  assert.ok(!removed.members.some(item => item.member === 'dev'));
  gate.resolve();
  const done = await settle(chatId);
  assert.deepEqual(woken.filter(item => item.member === 'dev').length, 1);
  assert.deepEqual(done.turns.filter(turn => turn.round === 2).map(turn => turn.agentId).sort(), ['qa', 'ux']);
  // A removal after the end is refused.
  await call('stop', { chatId });
  await assert.rejects(call('remove', { chatId, member: 'qa' }), error => error.code === 'flg_ended');
});

test('a failed post loses nothing: a new topic stays the person\'s, a host round is not used up', async t => {
  const store = createRoundtableStore();
  const { roundtable, start, settle, call, ask } = fixture({ store });
  t.after(() => roundtable.close());
  const long = await start('flg-retry-topic', ['dev', 'qa'], { responseRounds: 0, options: { lifetime: 'long' } });
  await settle(long.chatId);
  // A round whose questions cannot be posted.
  const append = store.chat.append;
  store.chat.append = () => { throw new Error('Synthetic send failure'); };
  await assert.rejects(call('round', { chatId: long.chatId, to: ['qa'], questions: ['为什么？'] }), /Synthetic send failure/u);
  store.chat.append = append;
  assert.equal((await call('status', { chatId: long.chatId })).hostRound, 1);
  await call('summary', { chatId: long.chatId, requestId: 's-1', body: '第一个话题的结论' });
  ask('flg-retry-topic', '第二个话题');
  store.chat.append = () => { throw new Error('Synthetic send failure'); };
  await assert.rejects(call('follow_up', { chatId: long.chatId }), /Synthetic send failure/u);
  store.chat.append = append;
  const kept = await call('status', { chatId: long.chatId });
  assert.deepEqual([kept.topic, kept.question, kept.summary.recorded], [1, '这个方案的产品体验和技术风险？', true]);
  const topic = await call('follow_up', { chatId: long.chatId });
  assert.deepEqual([topic.topic, topic.question], [2, '第二个话题']);
});

test('a round addressed only to members nobody can reach uses up nothing and posts nothing', async t => {
  const { roundtable, start, settle, call } = fixture({ clientAvailable: client => client !== 'codex' });
  t.after(() => roundtable.close());
  const { chatId } = await start('flg-none', ['dev', 'oc-only'], { responseRounds: 0 });
  const before = await settle(chatId);
  await assert.rejects(call('round', { chatId, to: ['oc-only'], questions: ['?'] }), error => error.code === 'flg_member_unavailable');
  const after = await call('status', { chatId, after: before.nextAfter });
  assert.deepEqual([after.hostRound, after.messages], [1, []]);
});

test('codes: unique per space, a short one dies after a day idle, and unknown codes are limited per session', async t => {
  let offset = 0;
  const store = createRoundtableStore();
  const { roundtable, start, settle, join } = fixture({ store, now: () => Date.now() + offset });
  t.after(() => roundtable.close());
  const short = await start('flg-idle', ['dev', 'qa'], { responseRounds: 0 });
  const long = await start('flg-standing', ['dev', 'qa'], { responseRounds: 0, options: { lifetime: 'long' } });
  await settle(short.chatId);
  await settle(long.chatId);
  // A live code cannot be given to a second discussion.
  assert.equal(store.discussions.assignCode('space', 'flg-standing', code(short)), false);
  offset = 25 * 60 * 60_000;
  assert.deepEqual(await join(code(short), 'token-astro-oc'), { refused: 'unknown' });
  assert.equal(store.discussions.get('space', 'flg-idle').join_code, null);
  assert.ok((await join(code(long), 'token-astro-oc')).joined);
  // Five unknown codes from one session, then even a right code is refused for a while.
  for (let n = 0; n < 5; n++) assert.deepEqual(await join(`Z${n + 2}ZZ`, 'token-astro-cursor'), { refused: 'unknown' });
  assert.deepEqual(await join(code(long), 'token-astro-cursor'), { refused: 'throttled' });
  offset += 11 * 60_000;
  assert.ok((await join(code(long), 'token-astro-cursor')).joined);
});

test('a joined Codex session\'s model is the one its prompt hook reported, unless it states another', async t => {
  const { roundtable, start, settle, call, join } = fixture();
  t.after(() => roundtable.close());
  const started = await start('flg-codex-model', ['dev', 'qa'], { responseRounds: 0 });
  await settle(started.chatId);
  await join(code(started), 'token-astro-oc', 'Astro', 'synthetic-hook-model');
  const reply = await call('reply', { chatId: started.chatId, body: '观点' }, 'token-astro-oc');
  assert.equal(reply.by, 'OpenCode · synthetic-hook-model');
});
