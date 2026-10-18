import assert from 'node:assert/strict';
import test from 'node:test';
import { sign } from 'node:crypto';
import { canonicalJson } from '../src/agent-peer/protocol.js';
import { device, pair, remoteAddress, signingAuthority } from './fixtures/peer-devices.js';
test('a project lead asks the shared lead on another paired device over TLS', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta);
    const found = await alpha.app.roundtable.findAgents({});
    assert.equal(found.remoteAgents[0].role, 'shared_project_lead');
    assert.ok(!JSON.stringify(found).includes(beta.folder), 'local folders are never published');
    const answer = await alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      to: await remoteAddress(alpha.app), body: 'Synthetic cross-device question', timeoutSeconds: 30 });
    assert.equal(answer.status, 'answered', JSON.stringify(answer));
    assert.equal(answer.reply, 'beta answers');
    assert.equal(beta.calls.wakes.length, 1);
    assert.match(beta.calls.wakes[0].prompt, /Synthetic cross-device question/);
    assert.equal(beta.calls.wakes[0].cwd, beta.folder);
    assert.deepEqual([beta.calls.grants[0].agent_id, beta.calls.grants[0].personal_project_id], ['beta-lead', 'beta-project']);
    assert.ok(!JSON.stringify(beta.calls).includes('alpha-task'), 'the sender task token never leaves its device');
    const status = await alpha.app.roundtable.messageStatus({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      messageId: answer.messageId });
    assert.equal(status.status, 'answered');

    const [betaDevice] = (await alpha.runtime.status()).devices.filter((entry) => !entry.self);
    await alpha.runtime.revokeDevice(betaDevice.nodeId);
    const after = await alpha.app.roundtable.findAgents({});
    assert.equal(after.remoteAgents.length, 0, 'a revoked device no longer offers Agents');
  } finally { await alpha.close(); await beta.close(); }
});

test('valid TLS and device signature without the source authority proof start nothing', { timeout: 20_000 }, async () => {
  const forger = signingAuthority();
  for (const [name, tamper] of Object.entries({
    missing: () => undefined,
    tampered: (proof) => ({ ...proof, payload: Buffer.from(canonicalJson({ forged: true })).toString('base64url') }),
    forged_key: (_proof, claims) => {
      const payload = Buffer.from(canonicalJson({ ...claims, key_id: forger.keyId }));
      return { payload: payload.toString('base64url'), signature: sign(null, payload, forger.privateKey).toString('base64url') };
    },
  })) {
    const [alpha, beta] = await Promise.all([device('alpha', { tamper }), device('beta')]);
    try {
      await pair(alpha, beta);
      const result = await alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
        to: await remoteAddress(alpha.app), body: 'Forged question', timeoutSeconds: 30 }).catch((error) => ({ status: 'refused', code: error.code }));
      assert.ok(['failed', 'refused'].includes(result.status), `${name}: ${JSON.stringify(result)}`);
      assert.deepEqual(beta.calls.grants, [], `${name}: no receiving delegation`);
      assert.deepEqual(beta.calls.wakes, [], `${name}: nothing started`);
    } finally { await alpha.close(); await beta.close(); }
  }
});

test('a shared lead without a known project folder is not woken anywhere else', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta, { folder: false });
    const result = await alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      to: await remoteAddress(alpha.app), body: 'Question without folder', timeoutSeconds: 30 });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'no_working_directory');
    assert.deepEqual(beta.calls.wakes, []);
  } finally { await alpha.close(); await beta.close(); }
});

test('an unconfirmed remote cleanup reaches the sender with its original code and holds the next wake', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta', { wake: async () => {
    throw Object.assign(new Error('synthetic'), { code: 'wake_timeout', cleanup: { status: 'unconfirmed', code: 'cleanup_failed' } });
  } })]);
  try {
    await pair(alpha, beta);
    const to = await remoteAddress(alpha.app);
    const first = await alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      to, body: 'Synthetic question', timeoutSeconds: 30 });
    assert.equal(first.status, 'failed', JSON.stringify(first));
    assert.equal(first.reason, 'wake_timeout');
    assert.deepEqual(first.cleanup, { status: 'unconfirmed', code: 'cleanup_failed' });
    const status = await alpha.app.roundtable.messageStatus({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      messageId: first.messageId });
    assert.deepEqual([status.status, status.reason, status.cleanup],
      ['failed', 'wake_timeout', { status: 'unconfirmed', code: 'cleanup_failed' }]);
    assert.equal(beta.calls.wakes.length, 1);

    const second = await alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      to, body: 'Synthetic retry', timeoutSeconds: 30 });
    assert.equal(second.status, 'failed', JSON.stringify(second));
    assert.equal(second.reason, 'cleanup_unconfirmed');
    assert.equal(second.cleanup, undefined, 'a refused ask started nothing that could still be running');
    assert.equal(beta.calls.wakes.length, 1, 'the receiving device never stacks a second process');
  } finally { await alpha.close(); await beta.close(); }
});

test('the owner chooses the shared clients and a folder of that project', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta);
    await assert.rejects(beta.runtime.setShares({ shares: [{ projectId: beta.projectId, clients: [] }] }), { code: 'invalid_clients' });
    await assert.rejects(beta.runtime.setShares({ shares: [{ projectId: beta.projectId, clients: ['claude_code'] }] }), { code: 'invalid_clients' });
    await assert.rejects(beta.runtime.setShares({ shares: [{ projectId: beta.projectId, clients: ['codex'],
      workingDirectory: alpha.folder }] }), { code: 'invalid_folder' });
    const [share] = (await beta.runtime.status()).shares;
    assert.deepEqual([share.clients, share.state], [['codex'], 'shared']);
  } finally { await alpha.close(); await beta.close(); }
});
