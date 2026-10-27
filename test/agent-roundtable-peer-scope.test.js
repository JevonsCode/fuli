import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';

function fixture() {
  const store = createRoundtableStore();
  const woken = [];
  let project = 'shared-project';
  const peerCalls = [];
  const app = {
    config: { personal: { spaceId: 'fixture-space' } },
    taskContextRegistry: { context: async () => ({ projectAgentId: 'shared-lead', personalProjectId: project, sourceApplication: 'codex', sessionId: 'fixture-session' }) },
    listProjectAgents: async () => [{ agentId: 'shared-lead', profile: { name: 'Shared lead', status: 'active', allowedClients: ['codex'] } }],
    personal: { recentAgentSessions: async () => [], verifyAgentDelegation: async () => ({ redeemed: true }), revokeAgentDelegation: async () => {} },
    peer: { hasSent: () => true, status: async () => { peerCalls.push('status'); return { status: 'queued' }; }, cancel: async () => { peerCalls.push('cancel'); return { status: 'cancelled' }; } },
  };
  const service = createAgentRoundtable({ host: createFuliRoundtableHost(app), peer: app.peer, openStore: () => store, clientAvailable: () => true,
    wake: async input => { woken.push(input); return { body: 'Synthetic reply', sessionId: 'fixture-session' }; } });
  function ask({ node = 'a', body = 'Allowed remote question', threadId = 'collision-thread', messageId = 'collision-ask' } = {}) {
    return service.answerRemote({
      claim: { messageId, attemptId: 'fixture-attempt', sender: { nodeId: node.repeat(64), name: 'Fixture peer' },
        assertion: { messageId, threadId, body, conversation: 'new', depth: 1, from: { agentId: 'peer-lead', name: 'Peer lead' } } },
      share: { spaceId: 'fixture-space', bindingId: 'shared-binding', agentId: 'shared-lead', projectId: 'shared-project', clients: ['codex'], workingDirectory: process.cwd() },
      issueGrant: async () => ({ token: 'fixture-grant' }), timeoutMs: 1000,
    });
  }
  return { store, service, woken, peerCalls, ask, setProject: value => { project = value; } };
}

test('remote IDs cannot select or mutate an existing local thread or ask', async () => {
  const f = fixture();
  try {
    f.store.createThread({ id: 'collision-thread', spaceId: 'fixture-space', projectId: 'private-project', subject: 'Private fixture' });
    f.store.appendMessage('collision-thread', { id: 'collision-ask', kind: 'ask', body: 'PRIVATE FIXTURE BODY', status: 'queued', from: { agentId: 'private-sender' }, to: { agentId: 'private-target' } });
    await f.ask();
    assert.equal(f.woken.length, 1);
    assert.match(f.woken[0].prompt, /Allowed remote question/);
    assert.doesNotMatch(f.woken[0].prompt, /PRIVATE FIXTURE BODY/);
    assert.equal(f.store.getMessage('collision-ask').status, 'queued');
    assert.equal(f.store.messages('collision-thread').length, 1);
    const remote = f.service.threads().threads.filter(row => row.projectId === 'shared-project');
    assert.equal(remote.length, 1);
    assert.notEqual(remote[0].id, 'collision-thread');
  } finally { f.service.close(); }
});

test('two paired origins may reuse remote IDs without sharing local records', async () => {
  const f = fixture();
  try {
    await f.ask({ node: 'a', body: 'Question from alpha' });
    await f.ask({ node: 'b', body: 'Question from beta' });
    assert.equal(f.woken.length, 2);
    assert.match(f.woken[0].prompt, /Question from alpha/);
    assert.doesNotMatch(f.woken[0].prompt, /Question from beta/);
    assert.match(f.woken[1].prompt, /Question from beta/);
    assert.doesNotMatch(f.woken[1].prompt, /Question from alpha/);
    assert.equal(f.service.threads().threads.length, 2);
  } finally { f.service.close(); }
});

test('same Agent in another project cannot read status or cancel this project ask', async () => {
  const f = fixture();
  try {
    f.store.createThread({ id: 'task-thread', spaceId: 'fixture-space', projectId: 'shared-project', subject: 'Task fixture' });
    f.store.appendMessage('task-thread', { id: 'task-ask', kind: 'ask', body: 'Question', status: 'sent', via: 'peer', from: { agentId: 'shared-lead' }, to: { agentId: 'peer-recipient' } });
    const request = { taskContextToken: 'synthetic-context', sourceApplication: 'codex', messageId: 'task-ask' };
    f.setProject('different-project');
    await assert.rejects(f.service.messageStatus(request), /current project/);
    await assert.rejects(f.service.cancelMessage(request), /current project/);
    assert.deepEqual(f.peerCalls, []);
    f.setProject('shared-project');
    assert.equal((await f.service.messageStatus(request)).status, 'queued');
    assert.equal((await f.service.cancelMessage(request)).status, 'cancelled');
    assert.deepEqual(f.peerCalls, ['status', 'cancel']);
  } finally { f.service.close(); }
});

test('a remote attempt uses its one grant and reports why that delivery failed', async () => {
  const store = createRoundtableStore();
  const grants = [];
  const app = {
    config: { personal: { spaceId: 'fixture-space' } },
    listProjectAgents: async () => [{ agentId: 'shared-lead', profile: { name: 'Shared lead', status: 'active', allowedClients: ['codex', 'claude_code'] } }],
    personal: { recentAgentSessions: async () => [], verifyAgentDelegation: async () => ({ redeemed: false }), revokeAgentDelegation: async () => {} },
  };
  const service = createAgentRoundtable({ host: createFuliRoundtableHost(app), peer: app.peer, openStore: () => store, clientAvailable: () => true,
    wake: async () => ({ body: 'Synthetic reply', sessionId: 'fixture-session' }) });
  try {
    await assert.rejects(service.answerRemote({
      claim: { messageId: 'one-grant-ask', attemptId: 'fixture-attempt', sender: { nodeId: 'c'.repeat(64), name: 'Fixture peer' },
        assertion: { messageId: 'one-grant-ask', threadId: 'one-grant-thread', body: 'Question', conversation: 'new', depth: 1, from: { agentId: 'peer-lead', name: 'Peer lead' } } },
      share: { spaceId: 'fixture-space', bindingId: 'shared-binding', agentId: 'shared-lead', projectId: 'shared-project', clients: ['codex', 'claude_code'], workingDirectory: process.cwd() },
      issueGrant: async (delivery) => { grants.push(delivery.client); if (grants.length > 1) throw Object.assign(new Error('409'), { code: 'provider_error' }); return { token: 'fixture-grant' }; },
      timeoutMs: 1000,
    }), { code: 'delegation_not_redeemed' });
    assert.equal(grants.length, 1);
  } finally { service.close(); }
});

test('a Provider refusal of the shared lead reaches the receiving thread with its reason', async () => {
  const store = createRoundtableStore();
  const woken = [];
  // The Provider's answer when a share outlived its lead (a handoff the directory has not caught up with).
  const personal = new GraphitiProviderClient({ baseUrl: 'http://provider.invalid', accessToken: 'synthetic-token',
    fetchImpl: async url => new URL(url).pathname === '/v1/project-agent-context/remote-delegations'
      ? Response.json({ detail: { code: 'lead_changed', message: 'Remote devices can only ask the project lead' } }, { status: 403 })
      : Response.json([]) });
  const app = {
    config: { personal: { spaceId: 'fixture-space' } },
    listProjectAgents: async () => [{ agentId: 'shared-lead', profile: { name: 'Shared lead', status: 'active', allowedClients: ['codex'] } }],
    personal,
  };
  const host = createFuliRoundtableHost(app);
  const service = createAgentRoundtable({ host, openStore: () => store, clientAvailable: () => true,
    wake: async input => { woken.push(input); return { body: 'Synthetic reply', sessionId: 'fixture-session' }; } });
  try {
    await assert.rejects(service.answerRemote({
      claim: { messageId: 'stale-share-ask', attemptId: 'fixture-attempt', sender: { nodeId: 'd'.repeat(64), name: 'Fixture peer' },
        assertion: { messageId: 'stale-share-ask', threadId: 'stale-share-thread', body: 'Question', conversation: 'new', depth: 1,
          from: { agentId: 'peer-lead', name: 'Peer lead' } } },
      share: { spaceId: 'fixture-space', bindingId: 'shared-binding', agentId: 'shared-lead', projectId: 'shared-project', clients: ['codex'], workingDirectory: process.cwd() },
      issueGrant: (delivery, lifetime) => host.issueRemoteDelegation({ projectId: 'shared-project', agentId: 'shared-lead',
        targetClient: delivery.client, targetSessionId: null, lifetimeSeconds: Math.round(lifetime),
        originNode: 'd'.repeat(64), originMessageId: 'stale-share-ask', originAttemptId: 'fixture-attempt' }),
      timeoutMs: 300_000,
    }), { code: 'lead_changed' });
    assert.deepEqual(woken, [], 'nothing is woken without authority');
    const [thread] = service.threads().threads;
    assert.deepEqual(store.messages(thread.id).map(message => [message.kind, message.status, message.error]),
      [['ask', 'failed', 'lead_changed']]);
  } finally { service.close(); }
});
