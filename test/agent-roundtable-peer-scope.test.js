import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRoundtable } from '../src/agent-roundtable/service.js';
import { createRoundtableStore } from '../src/agent-roundtable/store.js';

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
  const service = createAgentRoundtable({ app, openStore: () => store, clientAvailable: () => true,
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
