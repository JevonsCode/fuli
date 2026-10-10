import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { startCoordinatorServer } from '../src/agent-peer/coordinator-http.js';
import { createCoordinatorService } from '../src/agent-peer/coordinator-service.js';
import { createCoordinatorStore } from '../src/agent-peer/coordinator-store.js';
import { createDeviceCertificate, deviceIdentity } from '../src/agent-peer/device-identity.js';
import { createPeerClient } from '../src/agent-peer/peer-transport.js';
import { PEER_LIMITS, validateAssertion } from '../src/agent-peer/protocol.js';

const TEST_AUTHORITY = { keyId: '0'.repeat(32), publicKey: Buffer.alloc(32).toString('base64url') };
const identity = async () => deviceIdentity(await createDeviceCertificate());

function assertionFor(sender, target, now, changes = {}) {
  return { protocol: 'peer/1', messageId: 'message-1', threadId: 'thread-1',
    from: { node: sender.fingerprint, agentId: 'sender-agent', name: 'Sender' },
    to: { node: target.fingerprint, bindingId: 'binding-1', agentId: 'lead-agent' },
    body: 'Question', conversation: 'new', depth: 1, origin: { payload: 'e30', signature: 'AA' },
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30_000).toISOString(), ...changes };
}

async function coordinatorWithTarget({ clock } = {}) {
  const [coordinator, target] = await Promise.all([identity(), identity()]);
  const store = createCoordinatorStore();
  const service = createCoordinatorService({ store, identity: coordinator, authority: TEST_AUTHORITY, name: 'Coordinator', ...(clock ? { clock } : {}) });
  store.upsertNode({ id: target.fingerprint, name: 'Target', certPem: target.certPem, at: new Date(clock?.() ?? Date.now()).toISOString() });
  service.publishDirectory(target.fingerprint, { agents: [{ bindingId: 'binding-1', agentId: 'lead-agent' }] });
  return { coordinator, target, store, service };
}

async function rawServer(identities, onRequest) {
  const server = createServer({ ...identities.server.tlsOptions, ca: [identities.client.certPem],
    requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, onRequest);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = createPeerClient({ identity: identities.client, coordinator: {
    url: `https://127.0.0.1:${server.address().port}`, certPem: identities.server.certPem, fingerprint: identities.server.fingerprint } });
  return { client, close: async () => { client.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

test('a truncated coordinator response settles as interrupted before its deadline', { timeout: 3000 }, async () => {
  const identities = { server: await identity(), client: await identity() };
  const harness = await rawServer(identities, (request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      response.write('{');
      setTimeout(() => response.destroy(), 10);
    });
  });
  try {
    const started = Date.now();
    await assert.rejects(harness.client.post('/peer/1/result', {}, { timeoutMs: 100 }),
      (error) => ['response_interrupted', 'coordinator_timeout'].includes(error.code));
    assert.ok(Date.now() - started < 1000);
  } finally { await harness.close(); }
});

test('a stalled coordinator response is cut off by the absolute deadline', { timeout: 3000 }, async () => {
  const identities = { server: await identity(), client: await identity() };
  const harness = await rawServer(identities, (request, response) => {
    request.resume();
    request.on('end', () => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"a"'); });
  });
  try {
    await assert.rejects(harness.client.post('/peer/1/status', {}, { timeoutMs: 150 }), { code: 'coordinator_timeout' });
  } finally { await harness.close(); }
});

test('malformed successful JSON is an error, never an empty success', async () => {
  const identities = { server: await identity(), client: await identity() };
  const harness = await rawServer(identities, (request, response) => {
    request.resume();
    request.on('end', () => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('not json'); });
  });
  try {
    await assert.rejects(harness.client.post('/peer/1/status', {}), { code: 'invalid_response' });
  } finally { await harness.close(); }
});

test('only canonical UTC ISO lifetimes are accepted, so persisted expiry comparisons hold', async () => {
  let now = Date.parse('2026-10-11T00:00:00.000Z');
  const { coordinator, target, store, service } = await coordinatorWithTarget({ clock: () => now });
  try {
    const rfc = assertionFor(coordinator, target, now, { expiresAt: new Date(now + 5000).toUTCString() });
    assert.throws(() => validateAssertion(rfc, { now }), { code: 'invalid_message' });
    assert.throws(() => service.submit(coordinator.fingerprint, { assertion: rfc, signature: coordinator.sign(rfc) }), { code: 'invalid_message' });
    const offset = assertionFor(coordinator, target, now, { expiresAt: '2026-10-11T08:00:05+08:00' });
    assert.throws(() => validateAssertion(offset, { now }), { code: 'invalid_message' });
    const canonical = assertionFor(coordinator, target, now, { expiresAt: new Date(now + 5000).toISOString() });
    assert.equal(service.submit(coordinator.fingerprint, { assertion: canonical, signature: coordinator.sign(canonical) }).status, 'queued');
    now += 6000;
    service.sweep();
    assert.equal(service.status(coordinator.fingerprint, { messageId: canonical.messageId }).status, 'expired');
    assert.equal(service.claim(target.fingerprint), null);
  } finally { store.close(); }
});

test('an abandoned empty long poll never claims a message submitted afterwards', { timeout: 5000 }, async () => {
  const { coordinator, target, store, service } = await coordinatorWithTarget();
  let claims = 0;
  const server = await startCoordinatorServer({ service: { ...service, claim: (nodeId) => { claims += 1; return service.claim(nodeId); } },
    identity: coordinator, host: '127.0.0.1', claimWaitMs: 2000 });
  const client = createPeerClient({ identity: target, coordinator: {
    url: `https://127.0.0.1:${server.address.port}`, certPem: coordinator.certPem, fingerprint: coordinator.fingerprint } });
  try {
    const controller = new AbortController();
    const pending = client.post('/peer/1/claim', {}, { signal: controller.signal }).catch((error) => error.code);
    for (let index = 0; claims === 0 && index < 200; index += 1) await delay(5);
    controller.abort();
    assert.equal(await pending, 'aborted');
    await delay(50);
    const assertion = assertionFor(coordinator, target, Date.now());
    service.submit(coordinator.fingerprint, { assertion, signature: coordinator.sign(assertion) });
    await delay(700);
    assert.equal(service.status(coordinator.fingerprint, { messageId: assertion.messageId }).status, 'queued');
    assert.equal(claims, 1);
  } finally {
    client.close();
    await server.close();
    store.close();
  }
});

test('a claim that was never accepted is requeued, an accepted one becomes unknown', async () => {
  let now = Date.parse('2026-10-11T00:00:00.000Z');
  const { coordinator, target, store, service } = await coordinatorWithTarget({ clock: () => now });
  try {
    const assertion = assertionFor(coordinator, target, now, { expiresAt: new Date(now + 600_000).toISOString() });
    service.submit(coordinator.fingerprint, { assertion, signature: coordinator.sign(assertion) });
    const lost = service.claim(target.fingerprint);
    assert.throws(() => service.renew(target.fingerprint, { messageId: lost.messageId, attemptId: lost.attemptId, state: 'running' }),
      { code: 'attempt_not_accepted' });
    now += (PEER_LIMITS.acceptSeconds + 1) * 1000;
    service.sweep();
    assert.equal(service.status(coordinator.fingerprint, { messageId: assertion.messageId }).status, 'queued');

    const accepted = service.claim(target.fingerprint);
    assert.notEqual(accepted.attemptId, lost.attemptId);
    service.renew(target.fingerprint, { messageId: accepted.messageId, attemptId: accepted.attemptId, state: 'accepted' });
    // The started acknowledgement is lost after acceptance: the attempt may have run.
    now += (PEER_LIMITS.leaseSeconds + 1) * 1000;
    service.sweep();
    assert.equal(service.status(coordinator.fingerprint, { messageId: assertion.messageId }).status, 'unknown');
    assert.equal(service.claim(target.fingerprint), null);
    assert.throws(() => service.result(target.fingerprint, { messageId: accepted.messageId, attemptId: lost.attemptId, outcome: 'answered',
      reply: 'stale', verified: true }), { code: 'attempt_not_current' });
  } finally { store.close(); }
});

test('an expired acceptance cannot be renewed and an accepted never-started report stays unknown', async () => {
  let now = Date.parse('2026-10-11T00:00:00.000Z');
  const { coordinator, target, store, service } = await coordinatorWithTarget({ clock: () => now });
  try {
    const assertion = assertionFor(coordinator, target, now, { expiresAt: new Date(now + 600_000).toISOString() });
    service.submit(coordinator.fingerprint, { assertion, signature: coordinator.sign(assertion) });
    const late = service.claim(target.fingerprint);
    now += (PEER_LIMITS.acceptSeconds + 1) * 1000;
    // The sweep has not run yet; the lapsed window alone refuses a late acceptance.
    assert.throws(() => service.renew(target.fingerprint, { messageId: late.messageId, attemptId: late.attemptId, state: 'accepted' }),
      { code: 'lease_expired' });
    service.sweep();

    const claim = service.claim(target.fingerprint);
    service.renew(target.fingerprint, { messageId: claim.messageId, attemptId: claim.attemptId, state: 'accepted' });
    // A runner whose acceptance acknowledgement was lost cannot prove that nothing ran.
    const reported = service.result(target.fingerprint, { messageId: claim.messageId, attemptId: claim.attemptId, outcome: 'never_started' });
    assert.equal(reported.status, 'unknown');
    assert.equal(service.claim(target.fingerprint), null);
  } finally { store.close(); }
});

test('two devices may use the same message ID without colliding', async () => {
  const { coordinator, target, store, service } = await coordinatorWithTarget();
  const other = await identity();
  store.upsertNode({ id: other.fingerprint, name: 'Other', certPem: other.certPem, at: new Date().toISOString() });
  try {
    const first = assertionFor(coordinator, target, Date.now(), { body: 'From the coordinator' });
    const second = { ...assertionFor(other, target, Date.now()), body: 'From the other device' };
    service.submit(coordinator.fingerprint, { assertion: first, signature: coordinator.sign(first) });
    assert.equal(service.submit(other.fingerprint, { assertion: second, signature: other.sign(second) }).status, 'queued');
    const bodies = [service.claim(target.fingerprint), service.claim(target.fingerprint)].map((claim) => claim.assertion.body).sort();
    assert.deepEqual(bodies, ['From the coordinator', 'From the other device']);
    assert.throws(() => service.cancel(other.fingerprint, { messageId: 'unknown-id' }), { code: 'message_not_found' });
    assert.equal(service.status(other.fingerprint, { messageId: second.messageId }).status, 'claimed');
  } finally { store.close(); }
});
