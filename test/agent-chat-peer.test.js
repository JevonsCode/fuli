import assert from 'node:assert/strict';
import test from 'node:test';
import { sign } from 'node:crypto';
import { canonicalJson } from '../src/agent-peer/protocol.js';
import { device, pair } from './fixtures/peer-devices.js';

test('paired devices discover an explicitly shared member and exchange a group over real mTLS without waking anything', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta);
    await alpha.runtime.setShares({ shares: [{ projectId: alpha.projectId, clients: ['codex'] }] });
    await beta.runtime.setShares({ shares: [
      { projectId: beta.projectId, clients: ['codex'] },
      { projectId: beta.projectId, agentId: 'beta-member', communicationOnly: true, clients: [] }
    ] });
    const found = await alpha.app.roundtable.findAgents({ occupation: 'tester', capability: 'testing' });
    assert.equal(found.remoteAgents.length, 1);
    const target = found.remoteAgents[0];
    assert.equal(target.agentId, 'beta-member');
    assert.equal(target.communicationOnly, true);
    assert.equal(target.occupation, 'tester');
    assert.equal(target.projectId, beta.projectId);
    const call = (d, actor, action, data = {}) => d.app.roundtable.chat({ taskContextToken: `${actor}-task`, sourceApplication: 'codex', action, ...data });
    const room = await call(alpha, 'alpha', 'create', { requestId: 'group-1', kind: 'group', title: 'cross device', members: [target.address] });
    assert.equal(room.transport, 'peer');
    const sent = await call(alpha, 'alpha', 'send', { chatId: room.chatId, requestId: 'message-1', body: 'review this' });
    assert.equal(sent.seq, 1);
    const received = await call(beta, 'beta-member', 'read', { chatId: room.chatId });
    assert.equal(received.messages[0].body, 'review this');
    await call(beta, 'beta-member', 'send', { chatId: room.chatId, requestId: 'reply-1', body: 'reviewed' });
    assert.deepEqual((await call(alpha, 'alpha', 'read', { chatId: room.chatId })).messages.map(m => m.body), ['review this', 'reviewed']);
    assert.equal((await alpha.app.roundtable.chatOwner({ action: 'list' })).chats.length, 1);
    await assert.rejects(call(beta, 'beta', 'read', { chatId: room.chatId }), /member|not found/);
    assert.equal(alpha.calls.wakes.length + beta.calls.wakes.length, 0);
    assert.equal(alpha.calls.grants.length + beta.calls.grants.length, 0);
    assert.ok(alpha.calls.origins.every(input => input.purpose === 'chat'));
    assert.ok(!JSON.stringify(beta.calls).includes('alpha-task'));
    await assert.rejects(alpha.app.peer.resolveRemote(target.address), /communication|chat/i);
    await beta.runtime.setShares({ shares: [{ projectId: beta.projectId, clients: ['codex'] }] });
    await assert.rejects(call(beta, 'beta-member', 'read', { chatId: room.chatId }), /share/i);
  } finally { await alpha.close(); await beta.close(); }
});

test('a signed device cannot use a forged origin for chat', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha', { tamper: (_proof, claims) => ({
    payload: Buffer.from(JSON.stringify({ ...claims, purpose: 'execution' })).toString('base64url'), signature: 'AA'
  }) }), device('beta')]);
  try {
    await pair(alpha, beta);
    await alpha.runtime.setShares({ shares: [{ projectId: alpha.projectId, clients: ['codex'] }] });
    const target = (await alpha.app.roundtable.findAgents({})).remoteAgents[0].address;
    await assert.rejects(alpha.app.roundtable.chat({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      action: 'create', requestId: 'bad-proof', kind: 'direct', members: [target] }), /origin|proof/i);
    assert.equal((await beta.app.roundtable.chatOwner({ action: 'list' })).chats.length, 0);
  } finally { await alpha.close(); await beta.close(); }
});

test('valid signatures cannot exchange chat and execution proof versions', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha', { tamper: (_proof, claims, authority) => {
    const chat = claims.purpose !== 'chat';
    const payload = Buffer.from(canonicalJson({ ...claims, purpose: chat ? 'chat' : 'execution',
      version: chat ? 'fuli-chat-origin/1' : 'fuli-remote-origin/1' }));
    return { payload: payload.toString('base64url'), signature: sign(null, payload, authority.privateKey).toString('base64url') };
  } }), device('beta')]);
  try {
    await pair(alpha, beta);
    await alpha.runtime.setShares({ shares: [{ projectId: alpha.projectId, clients: ['codex'] }] });
    const target = (await alpha.app.roundtable.findAgents({})).remoteAgents[0].address;
    await assert.rejects(alpha.app.roundtable.chat({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      action: 'create', requestId: 'wrong-version', kind: 'direct', members: [target] }), /origin|purpose/i);
    const execution = await alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      to: target, body: 'A chat proof cannot wake a process', timeoutSeconds: 30 });
    assert.equal(execution.status, 'failed');
    assert.equal(beta.calls.wakes.length, 0);
    assert.equal(beta.calls.grants.length, 0);
  } finally { await alpha.close(); await beta.close(); }
});
