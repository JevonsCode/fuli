import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';

// 11-18 incident (synthetic IDs only): an ask named one FLA's Codex session,
// the same FLA's Claude session answered first from its inbox, and the named
// Codex session was then told it was already answered. An ask that names a
// native session belongs to that client and session: nobody else of the FLA
// sees it in its inbox or task entry, or closes it with its ID; the named
// session answers it once; the thread shows who was named, where it went and
// who answered. An ask that names no session stays the FLA's, as before.
const CODEX = 'synthetic-codex-session-a';
const CODEX_OTHER = 'synthetic-codex-session-b';
const CLAUDE = 'synthetic-claude-session-c';
const agent = (agentId, name, allowedClients) => ({ agentId, employeeNumber: agentId === 'lead-1' ? '000001' : '000002',
  profile: { name, displayName: name, status: 'active', responsibility: `${name} 的职责`, capabilities: [], allowedClients } });

function fixture() {
  const agents = [agent('lead-1', 'Milo Reed', ['claude_code']), agent('reviewer-1', 'Nova Lane', ['codex', 'claude_code'])];
  const task = (projectAgentId, sessionId, sourceApplication, personalProjectId = 'app') =>
    ({ projectAgentId, personalProjectId, sessionId, sourceApplication });
  const tasks = {
    'token-milo': task('lead-1', 'synthetic-milo', 'claude_code'),
    'token-nova-codex': task('reviewer-1', CODEX, 'codex'),
    'token-nova-codex-other': task('reviewer-1', CODEX_OTHER, 'codex'),
    'token-nova-claude': task('reviewer-1', CLAUDE, 'claude_code'),
    'token-nova-other-project': task('reviewer-1', CODEX, 'codex', 'other-app')
  };
  const sessions = { 'reviewer-1': [
    { source_application: 'codex', session_id: CODEX, personal_project_id: 'app' },
    { source_application: 'codex', session_id: CODEX_OTHER, personal_project_id: 'app' },
    { source_application: 'claude_code', session_id: CLAUDE, personal_project_id: 'app' }] };
  const app = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => agents,
    taskContextRegistry: { context: async token => tasks[token] },
    standingAssignments: createStandingAssignments(),
    personal: { recentAgentSessions: async ({ agentId }) => sessions[agentId] ?? [], listPersonalProjects: async () => [],
      issueAgentDelegation: async () => ({ token: 'synthetic-grant' }), verifyAgentDelegation: async () => ({ redeemed: true }),
      revokeAgentDelegation: async () => {} }
  };
  const store = createRoundtableStore();
  let id = 0;
  const roundtable = createAgentRoundtable({ host: createFuliRoundtableHost(app), env: {}, openStore: () => store,
    idFactory: () => `id-${++id}`, locateCwd: (client, sessionId) => `/work/${client}/${sessionId}`, clientAvailable: () => true,
    desktopApp: () => null, wake: async () => { throw new Error('nothing is woken in these tests'); } });
  const as = (token, client) => ({ taskContextToken: token, sourceApplication: client });
  return { roundtable, store, as };
}

async function namedAsk(f, conversation = CODEX) {
  const sent = await f.roundtable.messageAgent({ ...f.as('token-milo', 'claude_code'), to: 'Nova Lane', body: '在 Codex 那边确认一下',
    conversation, wait: false });
  assert.equal(sent.status, 'queued');
  return sent.messageId;
}

test('an ask naming a Codex session is not in the inbox or task entry of the same FLA elsewhere', async () => {
  const f = fixture();
  const messageId = await namedAsk(f);
  const inbox = async (token, client) => (await f.roundtable.readMessages(f.as(token, client))).messages.map(m => m.messageId);
  assert.deepEqual(await inbox('token-nova-claude', 'claude_code'), [], 'another client of the FLA');
  assert.deepEqual(await inbox('token-nova-codex-other', 'codex'), [], 'another session of the same client');
  assert.deepEqual(await inbox('token-nova-codex', 'codex'), [messageId], 'the named session');
  assert.deepEqual(f.roundtable.pending('reviewer-1', 'app', { client: 'claude_code', session: CLAUDE }), []);
  assert.deepEqual(f.roundtable.pending('reviewer-1', 'app', { client: 'codex', session: CODEX }).map(m => m.messageId), [messageId]);
  assert.deepEqual(f.roundtable.pending('reviewer-1', 'app'), [], 'an entry that names no session sees no named ask');
});

test('only the named session closes it, once; another session of the FLA cannot, even with its ID', async () => {
  const f = fixture();
  const messageId = await namedAsk(f);
  for (const [token, client] of [['token-nova-claude', 'claude_code'], ['token-nova-codex-other', 'codex']]) {
    await assert.rejects(f.roundtable.replyMessage({ ...f.as(token, client), messageId, body: '我先答了' }), /another session/);
  }
  assert.equal(f.store.getMessage(messageId).status, 'queued', 'still waiting for the named session');
  const answered = await f.roundtable.replyMessage({ ...f.as('token-nova-codex', 'codex'), messageId, body: '确认过了' });
  assert.equal(answered.status, 'sent');
  await assert.rejects(f.roundtable.replyMessage({ ...f.as('token-nova-codex', 'codex'), messageId, body: '再答一次' }),
    /already answered/);
  // The thread reads who was named, where it went and who answered: client and native session each.
  const view = f.roundtable.thread({ threadId: f.store.getMessage(messageId).thread_id });
  const ask = view.messages.find(message => message.id === messageId);
  const reply = view.messages.find(message => message.inReplyTo === messageId);
  assert.deepEqual(ask.target, { client: 'codex', session: CODEX });
  assert.deepEqual([reply.from.client, reply.from.session, reply.body], ['codex', CODEX, '确认过了']);
  assert.deepEqual([ask.from.client, ask.from.session], ['claude_code', 'synthetic-milo']);
});

test('a session FULI handed the named ask to may answer it, and the project boundary holds', async () => {
  const f = fixture();
  const messageId = await namedAsk(f);
  await assert.rejects(f.roundtable.replyMessage({ ...f.as('token-nova-other-project', 'codex'), messageId, body: 'x' }),
    /No such message/);
  // The named conversation could not be resumed and FULI delivered it to another one (an inbox conversation).
  f.store.updateMessage(messageId, { status: 'queued', toClient: 'codex', toSession: CODEX_OTHER });
  assert.deepEqual((await f.roundtable.readMessages(f.as('token-nova-codex-other', 'codex'))).messages.map(m => m.messageId),
    [messageId]);
  assert.equal((await f.roundtable.replyMessage({ ...f.as('token-nova-codex-other', 'codex'), messageId, body: '收到' })).status, 'sent');
  const view = f.roundtable.thread({ threadId: f.store.getMessage(messageId).thread_id });
  const ask = view.messages.find(message => message.id === messageId);
  assert.deepEqual([ask.target.session, ask.to.client, ask.to.session], [CODEX, 'codex', CODEX_OTHER],
    'named, delivered and answered are told apart');
});

test('an ask that names no session stays the FLA\'s: any of its sessions sees and answers it', async () => {
  const f = fixture();
  const messageId = await namedAsk(f, 'auto');
  assert.deepEqual((await f.roundtable.readMessages(f.as('token-nova-claude', 'claude_code'))).messages.map(m => m.messageId),
    [messageId]);
  assert.deepEqual(f.roundtable.pending('reviewer-1', 'app').map(m => m.messageId), [messageId]);
  assert.equal((await f.roundtable.replyMessage({ ...f.as('token-nova-claude', 'claude_code'), messageId, body: '我来' })).status, 'sent');
  const ask = f.roundtable.thread({ threadId: f.store.getMessage(messageId).thread_id }).messages.find(m => m.id === messageId);
  assert.equal(ask.target, undefined);
});

test('asks named to other sessions never crowd out the asks of this session in the inbox or task entry', async () => {
  const f = fixture();
  for (let n = 0; n < 6; n += 1) await namedAsk(f, CODEX_OTHER);
  const own = await namedAsk(f, CODEX);
  assert.deepEqual((await f.roundtable.readMessages(f.as('token-nova-codex', 'codex'))).messages.map(m => m.messageId), [own]);
  assert.deepEqual(f.roundtable.pending('reviewer-1', 'app', { client: 'codex', session: CODEX }).map(m => m.messageId), [own]);
});

test('a named session missing from the recent list is matched by its session alone', async () => {
  const f = fixture();
  const sent = await f.roundtable.messageAgent({ ...f.as('token-milo', 'claude_code'), to: 'Nova Lane', body: '旧会话',
    conversation: 'synthetic-unlisted-session', wait: false });
  const ask = f.store.getMessage(sent.messageId);
  assert.deepEqual([ask.target_client, ask.target_session], [null, 'synthetic-unlisted-session']);
  assert.deepEqual(f.roundtable.pending('reviewer-1', 'app', { client: 'codex', session: CODEX }), []);
  assert.deepEqual(f.roundtable.pending('reviewer-1', 'app', { client: 'codex', session: 'synthetic-unlisted-session' })
    .map(m => m.messageId), [sent.messageId]);
});
