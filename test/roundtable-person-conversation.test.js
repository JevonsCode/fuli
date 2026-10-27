import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { handleRoundtableApiRequest } from '../src/agent-roundtable/http.js';
import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';

// Synthetic FLAs only: the person's console messages through the real
// roundtable, store and FULI host, with the client process faked at the wake port.
function fixture({ clients = ['codex'], ownerGrants = true } = {}) {
  const store = createRoundtableStore();
  const woken = [];
  const grants = [];
  const agent = (agentId, name, projects = ['alpha-project']) => ({ agentId, profile: { name, status: 'active', allowedClients: clients },
    assignments: projects.map(personalProjectId => ({ status: 'active', personalProjectId })) });
  const roster = [agent('ada', 'Ada Vale'), agent('bo', 'Bo Lin'), agent('cy', 'Cy Moss', ['beta-project'])];
  let task = { projectAgentId: 'ada', personalProjectId: 'alpha-project', sourceApplication: 'codex', sessionId: 'ada-session-0001' };
  const personal = {
    recentAgentSessions: async ({ agentId }) => [{ source_application: 'codex', session_id: `${agentId}-session-0001`,
      personal_project_id: 'alpha-project', last_active: '2026-10-27T00:00:00Z' }],
    verifyAgentDelegation: async () => ({ redeemed: true }),
    revokeAgentDelegation: async () => {},
    ...(ownerGrants ? { issueOwnerAgentDelegation: async input => { grants.push(input); return { token: `owner-grant-${grants.length}` }; } } : {}),
  };
  const app = { config: { personal: { spaceId: 'fixture-space' } }, personal, listProjectAgents: async () => roster,
    taskContextRegistry: { context: async () => task } };
  const host = createFuliRoundtableHost(app);
  if (!ownerGrants) delete host.issueOwnerDelegation;
  const service = createAgentRoundtable({ host, openStore: () => store, clientAvailable: () => true, locateCwd: () => process.cwd(),
    wake: async input => { woken.push(input); return { body: `Reply ${woken.length}`, sessionId: `fork-session-${woken.length}` }; } });
  const until = async (check) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = check();
      if (value) return value;
      await delay(5);
    }
    throw new Error('condition not reached');
  };
  return { store, service, woken, grants, until, actAs: value => { task = value; } };
}

const replies = view => view.messages.filter(message => message.kind === 'reply');

test('a board message waits for the FLA, who answers it when it next works', async () => {
  const f = fixture();
  try {
    const view = await f.service.ownerSend({ to: ['ada'], body: 'Please review the synthetic plan', mode: 'board' });
    assert.equal(view.mode, 'board');
    assert.deepEqual(view.subscribers.map(({ agentId, delivery }) => [agentId, delivery]), [['ada', 'board']]);
    const [ask] = view.messages;
    assert.deepEqual([ask.kind, ask.status, ask.error, ask.from.client, ask.to.agentId], ['ask', 'queued', null, 'person', 'ada']);
    await delay(20);
    assert.equal(f.woken.length, 0, 'nothing is woken for the board');
    const inbox = await f.service.readMessages({ taskContextToken: 'fixture-task', sourceApplication: 'codex' });
    assert.deepEqual(inbox.messages.map(item => [item.messageId, item.body, item.fromClient]), [[ask.id, 'Please review the synthetic plan', 'person']]);
    await f.service.replyMessage({ taskContextToken: 'fixture-task', sourceApplication: 'codex', messageId: ask.id, body: 'Reviewed.' });
    const after = await f.service.ownerThread({ threadId: view.id });
    assert.deepEqual(replies(after).map(reply => [reply.body, reply.from.agentId, reply.to.client, reply.inReplyTo]),
      [['Reviewed.', 'ada', 'person', ask.id]]);
  } finally { await f.service.close(); }
});

test('an instant message starts a real run of the FLA at once and posts its verified answer', async () => {
  const f = fixture();
  try {
    const view = await f.service.ownerSend({ to: ['ada'], body: 'What blocks the release?', mode: 'instant' });
    assert.equal(view.mode, 'instant');
    assert.equal(view.subscribers[0].instantBlocked, null);
    const answered = await f.until(() => {
      const thread = f.service.thread({ threadId: view.id });
      return replies(thread).length ? thread : null;
    });
    assert.equal(f.woken.length, 1);
    assert.equal(f.woken[0].client, 'codex');
    assert.match(f.woken[0].prompt, /本人在 FULI 控制台发来消息/);
    assert.match(f.woken[0].prompt, /What blocks the release\?/);
    assert.equal(f.woken[0].delegationToken, 'owner-grant-1');
    assert.deepEqual(f.grants.map(grant => [grant.personal_project_id, grant.agent_id, grant.target_application]),
      [['alpha-project', 'ada', 'codex']]);
    const [ask, reply] = answered.messages;
    assert.equal(ask.status, 'answered');
    assert.deepEqual([reply.body, reply.from.agentId, reply.to.client], ['Reply 1', 'ada', 'person']);
  } finally { await f.service.close(); }
});

test('a group thread pushes each post to every subscriber, each answering for itself', async () => {
  const f = fixture();
  try {
    const first = await f.service.ownerSend({ to: ['ada', 'bo'], body: 'Opening question', mode: 'instant' });
    await f.until(() => replies(f.service.thread({ threadId: first.id })).length === 2);
    const second = await f.service.ownerSend({ threadId: first.id, body: 'Follow-up for both' });
    assert.deepEqual(second.messages.filter(message => message.kind === 'ask' && message.body === 'Follow-up for both')
      .map(message => message.to.agentId).sort(), ['ada', 'bo']);
    const done = await f.until(() => {
      const thread = f.service.thread({ threadId: first.id });
      return replies(thread).length === 4 ? thread : null;
    });
    assert.deepEqual(replies(done).map(reply => reply.from.agentId).sort(), ['ada', 'ada', 'bo', 'bo']);
    // The later wake sees the conversation so far, not only its own question.
    const followUp = f.woken.find(input => input.prompt.includes('Follow-up for both'));
    assert.match(followUp.prompt, /Opening question/);
    await assert.rejects(f.service.ownerSend({ to: ['ada', 'cy'], body: 'Mixed projects' }), /one shared project/);
  } finally { await f.service.close(); }
});

test('instant mode that cannot start a run says why and leaves the message on the board', async () => {
  for (const [options, reason] of [[{ clients: ['cursor'] }, 'no_client'], [{ ownerGrants: false }, 'instant_unavailable']]) {
    const f = fixture(options);
    try {
      const view = await f.service.ownerSend({ to: ['ada'], body: 'Can you hear me?', mode: 'instant' });
      assert.equal(view.subscribers[0].instantBlocked, reason);
      assert.deepEqual([view.messages[0].status, view.messages[0].error], ['queued', reason]);
      await delay(20);
      assert.equal(f.woken.length, 0);
    } finally { await f.service.close(); }
  }
});

test('switching a thread to instant answers what is still waiting on the board', async () => {
  const f = fixture();
  try {
    const view = await f.service.ownerSend({ to: ['ada'], body: 'Waiting question', mode: 'board' });
    await delay(20);
    assert.equal(f.woken.length, 0);
    const switched = await f.service.ownerSetMode({ threadId: view.id, mode: 'instant' });
    assert.equal(switched.mode, 'instant');
    await f.until(() => replies(f.service.thread({ threadId: view.id })).length === 1);
    assert.equal(f.woken.length, 1);
    await assert.rejects(f.service.ownerSetMode({ threadId: view.id, mode: 'loud' }), /board/);
  } finally { await f.service.close(); }
});

test('the console routes take the person\'s message and mode, and refuse a blank one', async () => {
  const f = fixture();
  const call = async (method, path, body = null) => {
    let status, value;
    const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); request.method = method;
    const response = { writeHead: code => { status = code; }, end: text => { value = JSON.parse(text); } };
    await handleRoundtableApiRequest({ request, response, url: new URL(path, 'http://localhost'), roundtable: f.service });
    return { status, value };
  };
  try {
    const created = await call('POST', '/api/roundtable/threads', { to: ['ada'], body: 'Hello from the console', mode: 'board' });
    assert.equal(created.status, 201);
    assert.deepEqual([created.value.mode, created.value.messages[0].body], ['board', 'Hello from the console']);
    const next = await call('POST', `/api/roundtable/threads/${created.value.id}/messages`, { body: 'Second' });
    assert.deepEqual(next.value.messages.map(message => message.body), ['Hello from the console', 'Second']);
    const read = await call('GET', `/api/roundtable/threads/${created.value.id}`);
    assert.equal(read.value.subscribers[0].agentId, 'ada');
    const switched = await call('PUT', `/api/roundtable/threads/${created.value.id}/mode`, { mode: 'instant' });
    assert.equal(switched.value.mode, 'instant');
    await assert.rejects(call('POST', `/api/roundtable/threads/${created.value.id}/messages`, { body: '  ' }), { code: 'invalid_input' });
  } finally { await f.service.close(); }
});
