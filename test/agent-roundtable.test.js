import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { parseFinalAnswer, sessionWorkingDirectory, wakeArguments, wakeAgent } from '../packages/roundtable/src/roundtable/wake.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';

const agent = (agentId, name, allowedClients = ['claude_code', 'codex']) => ({ agentId,
  employeeNumber: agentId === 'lead-1' ? '000001' : '000002',
  profile: { name, displayName: name, status: 'active', responsibility: `${name} 的职责`, capabilities: [], allowedClients } });

function fixture({ wake, sessions = {}, redeemed = true, env = {}, openStore = () => createRoundtableStore(), idFactory = null, peer = undefined } = {}) {
  const agents = [agent('lead-1', 'Milo Reed'), agent('reviewer-1', 'Nova Lane', ['codex'])];
  const tasks = {
    'token-milo': { token: 'token-milo', projectAgentId: 'lead-1', personalProjectId: 'app', sessionId: 'cc-1', sourceApplication: 'claude_code' },
    'token-nova': { token: 'token-nova', projectAgentId: 'reviewer-1', personalProjectId: 'app', sessionId: 'cx-9', sourceApplication: 'codex' },
    'token-foreign': { token: 'token-foreign', projectAgentId: 'lead-1', personalProjectId: 'other-app', sessionId: 'cc-2', sourceApplication: 'claude_code' }
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
    locateCwd: (client, sessionId) => `/work/${client}/${sessionId}`, clientAvailable: () => true,
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
  assert.match(woken[0].prompt, /^@\{reviewer-1\} \[FULI 圆桌 · id-1\]/);
  assert.match(woken[0].prompt, /Milo Reed（Claude Code）发来消息/);
  const thread = roundtable.thread({ threadId: result.threadId });
  assert.deepEqual(thread.messages.map(({ kind, status, from, to }) => [kind, status, from.name, to.name]), [
    ['ask', 'answered', 'Milo Reed', 'Nova Lane'], ['reply', 'sent', 'Nova Lane', 'Milo Reed']]);
  const [summary] = roundtable.threads().threads;
  assert.equal(summary.subject, '登录重构评审过了吗？');
  assert.deepEqual(summary.participants.map((person) => person.name), ['Milo Reed', 'Nova Lane']);
  assert.equal(summary.waiting, false);
  assert.deepEqual(summary.waitingFor, []);
});

test('employee numbers find and address the same identity across clients', async () => {
  const { roundtable, woken } = fixture();
  const result = await roundtable.findAgents({ query: '000002' });
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].employeeNumber, '000002');
  assert.equal(result.agents[0].agentId, 'reviewer-1');
  await roundtable.messageAgent({ taskContextToken: 'token-milo', to: 'FLA 000002', body: 'Synthetic review', sourceApplication: 'claude_code' });
  assert.match(woken[0].prompt, /^@\{reviewer-1\}/);
});

test('a public in-flight thread header never authorizes member delegation', async () => {
  let roundtable;
  ({ roundtable } = fixture({ wake: async (input) => {
    const context = { taskPrompt: input.prompt, agentId: 'reviewer-1', personalProjectId: 'app', sourceApplication: 'codex' };
    assert.equal(roundtable.taskEntryDelegation(context), null);
    assert.equal(roundtable.taskEntryDelegation({ ...context, personalProjectId: 'elsewhere' }), null);
    assert.equal(roundtable.taskEntryDelegation({ ...context, sourceApplication: 'claude_code' }), null);
    assert.equal(roundtable.taskEntryDelegation({ ...context, sessionId: 'unrelated-user-session' }), null);
    assert.equal(roundtable.taskEntryDelegation({ ...context, taskPrompt: '@{reviewer-1} [FULI 圆桌 · invented]' }), null);
    return { body: 'Member report', sessionId: 'member-run' };
  } }));
  const result = await roundtable.messageAgent({ taskContextToken: 'token-milo', to: 'reviewer-1', body: 'Review this work' });
  assert.equal(result.status, 'answered');
  assert.equal(roundtable.taskEntryDelegation({ taskPrompt: '@{reviewer-1} [FULI 圆桌 · id-1]',
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
  assert.equal(result.status, 'queued');
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
  assert.equal(sent.status, 'queued');
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

test('status and cancel work from each client’s own task and reject another project’s task', async () => {
  const { roundtable } = fixture({ wake: async () => { throw Object.assign(new Error('offline'), { code: 'client_unavailable' }); } });
  const sent = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'reviewer-1', body: '请复核测试' });
  // Recipient on Codex and sender on Claude Code both read the status.
  assert.equal((await roundtable.messageStatus({ taskContextToken: 'token-nova', sourceApplication: 'codex', messageId: sent.messageId })).status, 'queued');
  assert.equal((await roundtable.messageStatus({ taskContextToken: 'token-milo', sourceApplication: 'claude_code', messageId: sent.messageId })).status, 'queued');
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

test('a fresh run is used when the recipient has no resumable conversation', async () => {
  const { roundtable, woken } = fixture();
  const result = await roundtable.messageAgent({ taskContextToken: 'token-nova', sourceApplication: 'codex',
    to: 'Milo Reed', body: 'hello', projectPath: '/work/app' });
  assert.equal(result.via, 'claude_code:new');
  assert.deepEqual([woken[0].client, woken[0].sessionId, woken[0].cwd], ['claude_code', null, '/work/app']);
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
  assert.deepEqual(store.executionState('space',to),{busy:false,held:false});
});
