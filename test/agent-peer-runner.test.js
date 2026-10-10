import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { createDeviceCertificate, deviceIdentity } from '../src/agent-peer/device-identity.js';
import { createNodeStore } from '../src/agent-peer/node-store.js';
import { assertionDigest } from '../src/agent-peer/origin-proof.js';
import { canonicalJson, sha256Hex } from '../src/agent-peer/protocol.js';
import { createPeerRunner } from '../src/agent-peer/runner.js';

const TARGET = 'b'.repeat(64);

function authorityKey() {
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ format: 'jwk' }).x;
  return { privateKey: key.privateKey, authority: { keyId: sha256Hex(Buffer.from(publicKey, 'base64url')).slice(0, 32), publicKey } };
}

function originFor(assertion, { privateKey, authority }, changes = {}) {
  const payload = Buffer.from(canonicalJson({ version: 'fuli-remote-origin/1', key_id: authority.keyId,
    space_id: 'remote-space', project_id: 'remote-project', agent_id: assertion.from.agentId, task_hash: 'a'.repeat(64),
    message_id: assertion.messageId, digest: assertionDigest(assertion), target_node: assertion.to.node,
    binding_id: assertion.to.bindingId, issued_at: assertion.issuedAt, expires_at: assertion.expiresAt, ...changes }));
  return { payload: payload.toString('base64url'), signature: sign(null, payload, privateKey).toString('base64url') };
}

async function fixture({ accept = async () => ({ cancel: false }), renew = async () => ({ cancel: false }),
  answer = async () => ({ body: 'Synthetic reply', via: 'codex:new' }), result = async () => ({}) } = {}) {
  const sender = deviceIdentity(await createDeviceCertificate());
  const signer = authorityKey();
  const store = createNodeStore();
  store.replaceShares([{ spaceId: 'local-space', projectId: 'local-project', agentId: 'local-lead', clients: ['codex'] }],
    () => 'fixture-binding');
  const calls = [];
  const results = [];
  let attempt = 0;
  function claimFor({ assertionChanges = {}, origin = (assertion) => originFor(assertion, signer), authority = signer.authority,
    messageId = 'coordinator-message' } = {}) {
    const now = Date.now();
    const assertion = { protocol: 'peer/1', messageId: 'fixture-message', threadId: 'fixture-thread',
      from: { node: sender.fingerprint, agentId: 'remote-lead', name: 'Remote lead' },
      to: { node: TARGET, bindingId: 'fixture-binding', agentId: 'local-lead' },
      body: 'Synthetic question', conversation: 'new', depth: 1,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), ...assertionChanges };
    assertion.origin = origin(assertion);
    attempt += 1;
    return { messageId, attemptId: `fixture-attempt-${attempt}`, assertion, signature: sender.sign(assertion),
      sender: { nodeId: sender.fingerprint, name: 'Remote fixture', certPem: sender.certPem, authority } };
  }
  const client = { post: async (route, body, options = {}) => {
    if (route === '/peer/1/renew' && body.state === 'accepted') {
      if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
      return Promise.race([accept(body), new Promise((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'aborted' })), { once: true });
      })]);
    }
    if (route === '/peer/1/renew') return renew(body, options);
    if (route === '/peer/1/result') { results.push(body); return result(body); }
    return {};
  } };
  const runner = createPeerRunner({ store, client, nodeId: TARGET, spaceId: () => 'local-space',
    renewMs: 20,
    provider: { issueRemoteAgentDelegation: async (input) => { calls.push({ grant: input }); return { token: 'fixture-grant' }; } },
    roundtable: { answerRemote: async (input) => {
      calls.push({ answerRemote: true, aborted: input.signal.aborted });
      await input.issueGrant({ client: 'codex', sessionId: null }, 300);
      return answer(input);
    } } });
  return { runner, store, claimFor, calls, results, signer, sender };
}

test('a verified, accepted ask runs once and reports a verified answer', async () => {
  const f = await fixture();
  try {
    const claim = f.claimFor();
    await f.runner.handle(claim);
    assert.equal(f.calls.filter((call) => call.answerRemote).length, 1);
    const { grant } = f.calls.find((call) => call.grant);
    assert.deepEqual({ space: grant.personal_space_id, project: grant.personal_project_id, agent: grant.agent_id,
      node: grant.origin_node, attempt: grant.origin_attempt_id },
    { space: 'local-space', project: 'local-project', agent: 'local-lead', node: f.sender.fingerprint, attempt: claim.attemptId });
    assert.deepEqual(f.results.map((row) => [row.outcome, row.verified, row.reply]), [['answered', true, 'Synthetic reply']]);
    await f.runner.handle(claim);
    assert.equal(f.calls.filter((call) => call.answerRemote).length, 1, 'a repeated claim is not run again');
    await f.runner.handle({ ...claim, attemptId: 'replayed-attempt' });
    assert.equal(f.calls.filter((call) => call.answerRemote).length, 1, 'a replayed message is not run again');
    assert.equal(f.results.at(-1).error, 'already_started');
  } finally { await f.runner.stop(); f.store.close(); }
});

test('the lease deadline stops execution even while a renewal request is pending', async (t) => {
  const started = Promise.withResolvers();
  let renewalPending = false;
  let executionSignal;
  const f = await fixture({
    renew: async (_body, { signal }) => {
      renewalPending = true;
      return new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { code: 'aborted' }));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },
    answer: async ({ signal, onSpawn }) => {
      executionSignal = signal;
      onSpawn();
      started.resolve();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(
        Object.assign(new Error('cancelled'), { code: 'cancelled' })), { once: true }));
    },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const work = f.runner.handle(f.claimFor());
    await started.promise;
    assert.equal(renewalPending, true);
    t.mock.timers.tick(60_001);
    await work;
    assert.equal(executionSignal.aborted, true);
    assert.equal(f.runner.active(), 0);
    assert.equal(f.results.at(-1).outcome, 'unknown');
    assert.equal(f.results.at(-1).error, 'lease_lost');
  } finally {
    t.mock.timers.reset();
    await f.runner.stop();
    f.store.close();
  }
});

test('valid TLS and device signatures without a valid source authority proof never start', async () => {
  const f = await fixture();
  const other = authorityKey();
  const cases = {
    missing: { origin: () => undefined },
    tampered_signature: { origin: (assertion) => ({ ...originFor(assertion, f.signer), signature: originFor(assertion, other).signature }) },
    forged_sender_agent: { origin: (assertion) => originFor(assertion, f.signer, { agent_id: 'other-agent' }) },
    other_binding: { origin: (assertion) => originFor(assertion, f.signer, { binding_id: 'other-binding' }) },
    other_message: { origin: (assertion) => originFor(assertion, f.signer, { digest: 'f'.repeat(64) }) },
    stale_proof: { origin: (assertion) => originFor(assertion, f.signer, { expires_at: new Date(Date.now() - 1000).toISOString() }) },
    other_authority: { origin: (assertion) => originFor(assertion, other) },
  };
  try {
    for (const [name, options] of Object.entries(cases)) {
      await f.runner.handle(f.claimFor({ ...options, messageId: `message-${name}` }));
    }
    assert.deepEqual(f.calls, [], 'no delegation was issued and nothing started');
    assert.deepEqual(f.results.map((row) => row.outcome), Object.keys(cases).map(() => 'failed'));
  } finally { await f.runner.stop(); f.store.close(); }
});

test('a sending device that presents a different origin key after pinning is refused', async () => {
  const f = await fixture();
  try {
    await f.runner.handle(f.claimFor({ messageId: 'first' }));
    const rotated = authorityKey();
    await f.runner.handle(f.claimFor({ messageId: 'second', authority: rotated.authority,
      origin: (assertion) => originFor(assertion, rotated) }));
    assert.equal(f.calls.filter((call) => call.answerRemote).length, 1);
    assert.equal(f.results.at(-1).error, 'authority_changed');
  } finally { await f.runner.stop(); f.store.close(); }
});

test('a tampered target or an unshared binding is refused before any authority', async () => {
  const f = await fixture();
  try {
    await f.runner.handle(f.claimFor({ messageId: 'unshared', assertionChanges: {
      to: { node: TARGET, bindingId: 'unknown-binding', agentId: 'local-lead' } } }));
    await f.runner.handle(f.claimFor({ messageId: 'member', assertionChanges: {
      to: { node: TARGET, bindingId: 'fixture-binding', agentId: 'local-member' } } }));
    await f.runner.handle(f.claimFor({ messageId: 'device', assertionChanges: {
      to: { node: 'c'.repeat(64), bindingId: 'fixture-binding', agentId: 'local-lead' } } }));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.results.map((row) => row.error), ['agent_not_shared', 'agent_not_shared', 'wrong_device']);
  } finally { await f.runner.stop(); f.store.close(); }
});

test('an acceptance response requesting cancellation does not begin execution', async () => {
  const f = await fixture({ accept: async () => ({ cancel: true }) });
  try {
    await f.runner.handle(f.claimFor());
    assert.deepEqual(f.calls, []);
    assert.equal(f.results[0].outcome, 'cancelled');
  } finally { await f.runner.stop(); f.store.close(); }
});

test('stopping while acceptance is pending prevents later execution', async () => {
  const accepting = Promise.withResolvers();
  const reached = Promise.withResolvers();
  const f = await fixture({ accept: async () => { reached.resolve(); return accepting.promise; } });
  let handling;
  try {
    handling = f.runner.handle(f.claimFor());
    await reached.promise;
    await f.runner.stop();
    accepting.resolve({ cancel: false });
    await handling;
    assert.deepEqual(f.calls, []);
    assert.equal(f.results[0].outcome, 'never_started');
  } finally { accepting.resolve({ cancel: false }); await handling?.catch(() => {}); f.store.close(); }
});

test('a lost acceptance acknowledgement never starts and leaves the decision to the coordinator', async () => {
  const f = await fixture({ accept: async () => { throw Object.assign(new Error('reset'), { code: 'response_interrupted', status: 502 }); } });
  try {
    await f.runner.handle(f.claimFor());
    assert.deepEqual(f.calls, []);
    assert.equal(f.results[0].outcome, 'never_started');
  } finally { await f.runner.stop(); f.store.close(); }
});

test('a lost lease or a revoked device stops the running process', async () => {
  for (const [status, outcome] of [[409, 'unknown'], [403, 'cancelled']]) {
    const f = await fixture({
      renew: async () => { throw Object.assign(new Error('refused'), { status }); },
      answer: (input) => new Promise((_, reject) => input.signal.addEventListener('abort',
        () => reject(Object.assign(new Error('stopped'), { code: 'cancelled' })), { once: true })),
    });
    try {
      await f.runner.handle(f.claimFor());
      assert.equal(f.results[0].outcome, outcome);
    } finally { await f.runner.stop(); f.store.close(); }
  }
});

test('a restart reports started attempts as unknown and unstarted ones as not started', async () => {
  const store = createNodeStore();
  try {
    for (const [messageId, state] of [['claimed-only', 'claimed'], ['accepted-only', 'accepted'], ['was-running', 'running']]) {
      store.recordAttempt({ messageId, attemptId: 'attempt', bindingId: 'binding' });
      store.setAttemptState(messageId, 'attempt', state);
    }
    const results = [];
    const runner = createPeerRunner({ store, nodeId: TARGET, spaceId: () => 'local-space', retryMs: 10,
      client: { post: async (route, body) => {
        if (route === '/peer/1/result') { results.push([body.messageId, body.outcome]); return {}; }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { claim: null };
      } } });
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runner.stop();
    assert.deepEqual(results.sort(), [['accepted-only', 'never_started'], ['claimed-only', 'never_started'], ['was-running', 'unknown']]);
  } finally { store.close(); }
});
