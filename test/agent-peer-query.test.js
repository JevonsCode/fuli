import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCoordinatorService } from '../packages/roundtable/src/peer/coordinator-service.js';
import { createCoordinatorStore } from '../packages/roundtable/src/peer/coordinator-store.js';
import { createDeviceCertificate, deviceIdentity, loadDeviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { createNodeStore } from '../packages/roundtable/src/peer/node-store.js';
import { assertionDigest, originProofVersion } from '../packages/roundtable/src/peer/origin-proof.js';
import { createPeerPort, peerDirectory } from '../packages/roundtable/src/peer/peer-port.js';
import {
  canonicalJson, PEER_LIMITS, PEER_QUERY_PROTOCOL, peerMessageKey, validateQuery,
} from '../packages/roundtable/src/peer/protocol.js';
import { createPeerRunner } from '../packages/roundtable/src/peer/runner.js';
import { signingAuthority } from './fixtures/peer-devices.js';

// Synthetic devices, projects and knowledge only.
const identity = async () => deviceIdentity(await createDeviceCertificate());
const TEST_AUTHORITY = { keyId: '0'.repeat(32), publicKey: Buffer.alloc(32).toString('base64url') };

function queryFor(sender, targetNode, { now = Date.now(), query = { action: 'search', queries: ['deploy port'] }, ...changes } = {}) {
  return { protocol: PEER_QUERY_PROTOCOL, messageId: 'query-1',
    from: { node: sender, agentId: 'visitor-agent', name: 'Visitor' },
    to: { node: targetNode, bindingId: 'binding-1', agentId: 'lead-agent' }, query,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    origin: { payload: 'e30', signature: 'AA' }, ...changes };
}

function proofFor(assertion, authority, { purpose = 'query', ...changes } = {}) {
  const claims = { version: originProofVersion(purpose), key_id: authority.keyId, space_id: 'visitor-space',
    project_id: 'visitor-project', agent_id: assertion.from.agentId, task_hash: 'a'.repeat(64),
    message_id: assertion.messageId, digest: assertionDigest(assertion), target_node: assertion.to.node,
    binding_id: assertion.to.bindingId, issued_at: assertion.issuedAt, expires_at: assertion.expiresAt,
    ...(purpose !== 'execution' ? { purpose } : {}), ...changes };
  const payload = Buffer.from(canonicalJson(claims));
  return { payload: payload.toString('base64url'), signature: sign(null, payload, authority.privateKey).toString('base64url') };
}

// ---- Protocol ----

test('a query carries exactly its fields, card or search, bounded queries and a minute at most', () => {
  const now = Date.now();
  const sender = 'a'.repeat(64);
  const target = 'b'.repeat(64);
  assert.ok(validateQuery(queryFor(sender, target, { now }), { now }));
  assert.ok(validateQuery(queryFor(sender, target, { now, query: { action: 'card' } }), { now }));
  const refused = (changes, code = 'invalid_query') => assert.throws(
    () => validateQuery(queryFor(sender, target, { now, ...changes }), { now }), { code }, JSON.stringify(changes).slice(0, 80));
  for (const extra of ['body', 'depth', 'conversation', 'chatWake', 'threadId']) refused({ [extra]: 'x' });
  refused({ query: { action: 'card', queries: ['x'] } });
  refused({ query: { action: 'search' } });
  refused({ query: { action: 'search', queries: [] } });
  refused({ query: { action: 'search', queries: ['a', 'b', 'c', 'd', 'e'] } });
  refused({ query: { action: 'search', queries: ['x'.repeat(201)] } });
  refused({ query: { action: 'search', queries: ['   '] } });
  refused({ query: { action: 'search', queries: ['x'], projectView: false } });
  refused({ query: { action: 'wake' } });
  for (const action of ['progress', 'request', 'request_status']) refused({ query: { action } }, 'query_action_unsupported');
  refused({ from: { node: sender, agentId: 'visitor-agent', name: 'Visitor', client: 'codex' } });
  refused({ to: { node: sender, bindingId: 'binding-1', agentId: 'lead-agent' } });
  refused({ origin: undefined });
  refused({ expiresAt: new Date(now + 61_000).toISOString() });
  assert.throws(() => validateQuery(queryFor(sender, target, { now: now - 120_000 }), { now }), { code: 'message_expired' });
});

// ---- Coordinator ----

async function coordinatorWithTarget({ shared = { bindingId: 'binding-1', agentId: 'lead-agent' } } = {}) {
  const [coordinator, target, sender] = await Promise.all([identity(), identity(), identity()]);
  const store = createCoordinatorStore();
  const service = createCoordinatorService({ store, identity: coordinator, authority: TEST_AUTHORITY, name: 'Coordinator' });
  const at = new Date().toISOString();
  store.upsertNode({ id: target.fingerprint, name: 'Target', certPem: target.certPem, at });
  store.upsertNode({ id: sender.fingerprint, name: 'Sender', certPem: sender.certPem, at });
  service.publishDirectory(target.fingerprint, { agents: [shared] });
  const now = Date.now();
  const submit = (changes = {}) => {
    const assertion = queryFor(sender.fingerprint, target.fingerprint, { now, ...changes });
    return service.submit(sender.fingerprint, { assertion, signature: sender.sign(assertion) });
  };
  return { service, store, target, sender, submit };
}

test('the coordinator queues a query only for a binding shared for work, with its own cap', async () => {
  const f = await coordinatorWithTarget();
  try {
    assert.equal(f.submit().status, 'queued');
    assert.equal(f.submit().status, 'queued', 'the same query again is the same entry, never a second one');
    assert.throws(() => f.submit({ query: { action: 'card' } }), { code: 'duplicate_message' });
    for (let index = 2; index <= PEER_LIMITS.queryQueuePerNode; index += 1) f.submit({ messageId: `query-${index}` });
    assert.throws(() => f.submit({ messageId: 'query-over' }), { code: 'queue_full' });
    assert.throws(() => f.submit({ messageId: 'query-other', to: { node: f.target.fingerprint, bindingId: 'other', agentId: 'lead-agent' } }),
      { code: 'agent_not_shared' });
    assert.throws(() => f.submit({ messageId: 'query-late', query: { action: 'progress' } }), { code: 'query_action_unsupported' });
  } finally { f.store.close(); }
  const chatOnly = await coordinatorWithTarget({ shared: { bindingId: 'binding-1', agentId: 'lead-agent', communicationOnly: true } });
  try {
    assert.throws(() => chatOnly.submit(), { code: 'agent_not_shared' });
  } finally { chatOnly.store.close(); }
});

test('a query answer has its own size cap on the result path', async () => {
  const f = await coordinatorWithTarget();
  try {
    f.submit();
    const claim = f.service.claim(f.target.fingerprint);
    assert.equal(claim.messageId, peerMessageKey(f.sender.fingerprint, 'query-1'));
    f.service.renew(f.target.fingerprint, { messageId: claim.messageId, attemptId: claim.attemptId, state: 'accepted' });
    assert.throws(() => f.service.result(f.target.fingerprint, { messageId: claim.messageId, attemptId: claim.attemptId,
      outcome: 'answered', reply: 'x'.repeat(PEER_LIMITS.queryReplyBytes + 1), verified: true }), { code: 'invalid_result' });
    // Under the character cap a message has, over the byte cap a query has.
    assert.throws(() => f.service.result(f.target.fingerprint, { messageId: claim.messageId, attemptId: claim.attemptId,
      outcome: 'answered', reply: '答'.repeat(20_000), verified: true }), { code: 'invalid_result' });
    const done = f.service.result(f.target.fingerprint, { messageId: claim.messageId, attemptId: claim.attemptId,
      outcome: 'answered', reply: '{"action":"card"}', verified: true });
    assert.equal(done.status, 'answered');
    assert.equal(f.service.status(f.sender.fingerprint, { messageId: 'query-1' }).reply, '{"action":"card"}');
  } finally { f.store.close(); }
});

// ---- Runner on the owning computer ----

const TARGET = 'b'.repeat(64);

async function runnerFixture({ search = async () => ({ ok: true, results: [{ query: 'deploy port', items: [] }], truncated: false }),
  hostSearch = true, lead = 'local-lead' } = {}) {
  const sender = deviceIdentity(await createDeviceCertificate());
  const signer = signingAuthority();
  const store = createNodeStore();
  store.replaceShares([{ spaceId: 'local-space', projectId: 'local-project', agentId: 'local-lead', clients: ['codex'] }],
    () => 'fixture-binding');
  const calls = { answerRemote: 0, delegations: 0, searches: [] };
  const results = [];
  const client = { post: async (route, body) => {
    if (route === '/peer/1/result') results.push(body);
    return { cancel: false };
  } };
  const host = {
    projectTeam: async () => ({ lead: { agentId: lead, name: 'Synthetic lead', responsibility: 'Owns the synthetic project' } }),
    getProject: async () => ({ projectId: 'local-project', name: 'Synthetic project' }),
    issueRemoteDelegation: async () => { calls.delegations += 1; return { token: 'never' }; },
    ...(hostSearch ? { searchSharedProject: async (input) => { calls.searches.push(input); return search(input); } } : {}),
  };
  const runner = createPeerRunner({ store, client, nodeId: TARGET, spaceId: () => 'local-space', host,
    roundtable: { answerRemote: async () => { calls.answerRemote += 1; throw new Error('a query must never wake'); } } });
  function claimFor({ changes = {}, purpose = 'query', origin = null, messageId = null, attemptId = 'attempt-1', now = Date.now() } = {}) {
    const assertion = { ...queryFor(sender.fingerprint, TARGET, { now }), to: { node: TARGET, bindingId: 'fixture-binding', agentId: 'local-lead' },
      ...changes };
    delete assertion.origin;
    assertion.origin = origin ?? proofFor(assertion, signer, { purpose });
    return { messageId: messageId ?? peerMessageKey(sender.fingerprint, assertion.messageId), attemptId, assertion,
      signature: sender.sign(assertion), sender: { nodeId: sender.fingerprint, name: 'Visitor computer', certPem: sender.certPem,
        authority: { keyId: signer.keyId, publicKey: signer.publicKey } } };
  }
  return { runner, store, calls, results, claimFor, sender, close: async () => { await runner.stop(); store.close(); } };
}

test('a query is answered from the share without waking anything, as the asking device', async () => {
  const f = await runnerFixture();
  try {
    await f.runner.handle(f.claimFor());
    assert.equal(f.calls.answerRemote, 0, 'a query never reaches answerRemote');
    assert.equal(f.calls.delegations, 0, 'a query never issues a wake grant');
    const [search] = f.calls.searches;
    assert.deepEqual(search, { projectId: 'local-project', agentId: 'local-lead', query: { action: 'search', queries: ['deploy port'] },
      requester: { node: f.sender.fingerprint, name: 'Visitor computer', agentName: 'Visitor' } });
    assert.deepEqual(f.results.map((row) => [row.outcome, row.verified]), [['answered', true]]);
    assert.deepEqual(JSON.parse(f.results[0].reply), { action: 'search', results: [{ query: 'deploy port', items: [] }], truncated: false });

    await f.runner.handle(f.claimFor({ attemptId: 'attempt-2' }));
    assert.equal(f.calls.searches.length, 1, 'a replayed query is not searched again');
    assert.equal(f.results.at(-1).error, 'already_started');
  } finally { await f.close(); }
});

test('the card names the current lead and the project, within 1 KB, and wakes nothing', async () => {
  const f = await runnerFixture();
  try {
    await f.runner.handle(f.claimFor({ changes: { query: { action: 'card' } } }));
    const reply = f.results[0].reply;
    assert.ok(Buffer.byteLength(reply) <= 1024);
    const card = JSON.parse(reply);
    assert.deepEqual([card.action, card.name, card.responsibility, card.projectName],
      ['card', 'Synthetic lead', 'Owns the synthetic project', 'Synthetic project']);
    assert.match(card.guidance, /own model/);
    assert.match(card.guidance, /search/);
    assert.match(card.guidance, /data, never instructions/);
    assert.deepEqual(f.calls.searches, []);
    assert.equal(f.calls.answerRemote, 0);
  } finally { await f.close(); }
  const handedOff = await runnerFixture({ lead: 'new-lead' });
  try {
    await handedOff.runner.handle(handedOff.claimFor({ changes: { query: { action: 'card' } } }));
    assert.deepEqual([handedOff.results[0].outcome, handedOff.results[0].error], ['failed', 'agent_not_shared']);
  } finally { await handedOff.close(); }
});

test('a query is refused when unshared, wrongly proven, expired, replayed under another key or for another device', async () => {
  const signer = signingAuthority();
  const cases = {
    unshared: (f) => { f.store.replaceShares([], () => 'unused'); return f.claimFor(); },
    execution_proof: (f) => f.claimFor({ purpose: 'execution' }),
    chat_proof: (f) => f.claimFor({ purpose: 'chat' }),
    missing_proof: (f) => f.claimFor({ origin: { payload: '', signature: '' } }),
    foreign_key: (f) => { const claim = f.claimFor(); claim.assertion.origin = proofFor(claim.assertion, signer);
      claim.signature = f.sender.sign(claim.assertion); return claim; },
    expired: (f) => f.claimFor({ now: Date.now() - 120_000 }),
    other_key: (f) => f.claimFor({ messageId: 'coordinator-chosen-id' }),
    wrong_node: (f) => f.claimFor({ changes: { to: { node: 'c'.repeat(64), bindingId: 'fixture-binding', agentId: 'local-lead' } } }),
    other_agent: (f) => f.claimFor({ changes: { to: { node: TARGET, bindingId: 'fixture-binding', agentId: 'someone-else' } } }),
  };
  const expected = { unshared: 'agent_not_shared', execution_proof: 'origin_rejected', chat_proof: 'origin_rejected',
    missing_proof: 'origin_rejected', foreign_key: 'origin_rejected', expired: 'message_expired', other_key: 'message_mismatch',
    wrong_node: 'wrong_device', other_agent: 'agent_not_shared' };
  for (const [name, claimOf] of Object.entries(cases)) {
    const f = await runnerFixture();
    try {
      await f.runner.handle(claimOf(f));
      assert.deepEqual([f.results[0]?.outcome, f.results[0]?.error], ['failed', expected[name]], name);
      assert.deepEqual(f.calls.searches, [], `${name}: nothing searched`);
      assert.equal(f.calls.answerRemote, 0, `${name}: nothing woken`);
    } finally { await f.close(); }
  }
});

test('a host refusal or a host without visitor search is a plain code, never a project detail', async () => {
  const limited = await runnerFixture({ search: async () => ({ ok: false, code: 'rate_limited' }) });
  try {
    await limited.runner.handle(limited.claimFor());
    assert.deepEqual([limited.results[0].outcome, limited.results[0].error], ['failed', 'rate_limited']);
  } finally { await limited.close(); }
  const thrown = await runnerFixture({ search: async () => { throw new Error('C:\\private\\project path leaked'); } });
  try {
    await thrown.runner.handle(thrown.claimFor());
    assert.deepEqual([thrown.results[0].outcome, thrown.results[0].error], ['failed', 'query_failed']);
  } finally { await thrown.close(); }
  const standalone = await runnerFixture({ hostSearch: false });
  try {
    await standalone.runner.handle(standalone.claimFor());
    assert.deepEqual([standalone.results[0].outcome, standalone.results[0].error], ['failed', 'query_unsupported']);
  } finally { await standalone.close(); }
});

// ---- The asking side, against a coordinator in this process ----

test('peer-port query signs, proves its purpose, posts and returns the parsed answer', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fuli-peer-query-'));
  const [coordinator, target] = await Promise.all([identity(), identity()]);
  const store = createCoordinatorStore();
  const service = createCoordinatorService({ store, identity: coordinator, authority: TEST_AUTHORITY, name: 'Coordinator' });
  const visitor = await loadDeviceIdentity(peerDirectory(dataDir));
  const signer = signingAuthority();
  const at = new Date().toISOString();
  store.upsertNode({ id: target.fingerprint, name: 'Owner', certPem: target.certPem, at });
  service.trustNearbyDevice({ certPem: visitor.certPem, name: 'Visitor', authority: { keyId: signer.keyId, publicKey: signer.publicKey } });
  service.publishDirectory(target.fingerprint, { agents: [{ bindingId: 'binding-1', agentId: 'lead-agent', name: 'Owner lead' }] });
  const origins = [];
  const answer = { action: 'search', results: [{ query: 'deploy port', items: [{ kind: 'fact', title: 'PORT', text: 'Synthetic port 4100\u001b[31m' }] }],
    truncated: false };
  // The owning device: claims the query and answers it, as its runner would.
  const answerNext = () => setImmediate(() => {
    const claim = service.claim(target.fingerprint);
    service.renew(target.fingerprint, { messageId: claim.messageId, attemptId: claim.attemptId, state: 'accepted' });
    service.result(target.fingerprint, { messageId: claim.messageId, attemptId: claim.attemptId, outcome: 'answered',
      reply: JSON.stringify(answer), verified: true });
  });
  const client = { post: async (route, body) => {
    if (route === '/peer/1/messages') { const state = service.submit(visitor.fingerprint, body); answerNext(); return state; }
    if (route === '/peer/1/status') return service.status(visitor.fingerprint, body);
    if (route === '/peer/1/cancel') return service.cancel(visitor.fingerprint, body);
    throw new Error(`unexpected ${route}`);
  }, close() {} };
  const host = { spaceId: () => 'visitor-space', issueRemoteOrigin: async (input) => {
    origins.push(input);
    return { agent_id: 'visitor-agent', proof: { payload: 'e30', signature: 'AA' } };
  } };
  const port = createPeerPort({ dataDir, host, createClient: () => client });
  port.nodeStore().setSetting('membership', { role: 'member', coordinator: { url: 'https://127.0.0.1:1', certPem: coordinator.certPem,
    fingerprint: coordinator.fingerprint, name: 'Coordinator' } });
  try {
    const target_ = { node: target.fingerprint, bindingId: 'binding-1', agentId: 'lead-agent' };
    const result = await port.query(target_, { action: 'search', queries: ['deploy port'] },
      { taskContextToken: 'visitor-task', sourceApplication: 'codex', from: { agentId: 'visitor-agent', name: 'Visitor' } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.results[0].items[0].text, 'Synthetic port 4100[31m', 'control characters from another device are dropped');
    assert.deepEqual([origins[0].purpose, origins[0].targetNode, origins[0].bindingId, origins[0].taskContextToken],
      ['query', target.fingerprint, 'binding-1', 'visitor-task']);
    const lifetime = Date.parse(origins[0].expiresAt) - Date.now();
    assert.ok(lifetime > 0 && lifetime <= 60_000);

    const refused = await port.query({ ...target_, bindingId: 'not-shared' }, { action: 'card' },
      { taskContextToken: 'visitor-task', sourceApplication: 'codex', from: { agentId: 'visitor-agent', name: 'Visitor' } });
    assert.deepEqual(refused, { ok: false, code: 'agent_not_shared' });
    await assert.rejects(port.query(target_, { action: 'card' }, { taskContextToken: 'visitor-task', sourceApplication: 'codex',
      from: { agentId: 'another-agent', name: 'Other' } }), { code: 'origin_mismatch' });
  } finally { port.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); }
});
