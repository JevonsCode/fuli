import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { cleanupReleaseProof, createAgentRoundtable } from '../src/agent-roundtable/service.js';
import { createRoundtableStore } from '../src/agent-roundtable/store.js';
import { readWindowsBootAnchor } from '../src/native-runtime/windows-processes.js';

const UNCONFIRMED = { status: 'unconfirmed', code: 'cleanup_timeout' };
const EVIDENCE = { version: 1, machineHash: 'm'.repeat(64), anchor: { pid: 1736, image: 'wininit.exe', critical: true } };

// One coordinator (MCP process) over a store; wakes are injected, never real clients.
function coordinator(store, { wake, bootEvidence } = {}) {
  const woken = [];
  let id = 0;
  const prefix = Math.random().toString(36).slice(2, 8);
  const app = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => [
      { agentId: 'reviewer-1', profile: { name: 'Nova Lane', status: 'active', allowedClients: ['codex'] } },
      { agentId: 'writer-2', profile: { name: 'Iris Vale', status: 'active', allowedClients: ['codex'] } }],
    taskContextRegistry: { context: async (token) => ({ projectAgentId: token === 'reviewer-token' ? 'reviewer-1' : null,
      personalProjectId: 'app', sessionId: 'cc-1', sourceApplication: 'claude_code' }) },
    personal: {
      recentAgentSessions: async () => [],
      issueAgentDelegation: async () => ({ token: 'synthetic-grant' }),
      verifyAgentDelegation: async () => ({ redeemed: true }),
      revokeAgentDelegation: async () => {}
    }
  };
  const roundtable = createAgentRoundtable({ app, openStore: () => store, idFactory: () => `${prefix}-${++id}`,
    clientAvailable: () => true, locateCwd: () => '/work', ...(bootEvidence ? { bootEvidence } : {}),
    wake: async (input) => { woken.push(input); return wake(woken.length, input); } });
  const ask = (body, to = 'reviewer-1') => roundtable.messageAgent({ taskContextToken: 'token', sourceApplication: 'claude_code',
    to, body, projectPath: '/work' });
  return { roundtable, woken, ask };
}
const answered = async () => ({ body: 'Synthetic answer', sessionId: 'woken-session' });
const unconfirmed = async () => { throw Object.assign(new Error('synthetic'), { code: 'wake_timeout', cleanup: { ...UNCONFIRMED } }); };

async function sharedFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-cleanup-evidence-'));
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'roundtable.sqlite');
  return () => { const store = createRoundtableStore(path); stores.push(store); return store; };
}

// ---- Stage 1: evidence is recorded with the hold, never invented ----

test('a hold records injected boot evidence once; production default and acquisition errors record none and stay held', async () => {
  for (const [label, bootEvidence, expected] of [
    ['injected', async () => EVIDENCE, ['1', EVIDENCE.machineHash, '1736', '1']],
    ['default', undefined, [null, null, null, null]],
    ['throws', async () => { throw new Error('acquisition failed'); }, [null, null, null, null]],
    ['unversioned', async () => ({ machineHash: 'x', anchor: { pid: 1, critical: true } }), [null, null, null, null]]]) {
    const store = createRoundtableStore();
    try {
      const { ask, woken } = coordinator(store, { wake: unconfirmed, bootEvidence });
      const first = await ask('First');
      const row = store.getMessage(first.messageId);
      assert.deepEqual([row.cleanup_evidence_version, row.cleanup_machine_hash, row.cleanup_anchor_pid, row.cleanup_anchor_critical],
        expected, label);
      assert.deepEqual([row.cleanup_status, row.cleanup_code, row.error], ['unconfirmed', 'cleanup_timeout', 'wake_timeout'], label);
      assert.equal((await ask('Again')).reason, 'cleanup_unconfirmed', label);
      assert.equal(woken.length, 1, label);
    } finally { store.close(); }
  }
});

test('a later setCleanup never rewrites recorded evidence', () => {
  const store = createRoundtableStore();
  try {
    store.createThread({ id: 't', spaceId: 'space', subject: 'T' });
    store.appendMessage('t', { id: 'a', kind: 'ask', body: 'A', status: 'queued', to: { agentId: 'reviewer-1' } });
    store.setCleanup('a', UNCONFIRMED, EVIDENCE);
    store.setCleanup('a', { status: 'unconfirmed', code: 'cleanup_failed' },
      { ...EVIDENCE, machineHash: 'n'.repeat(64), anchor: { ...EVIDENCE.anchor, pid: 9 } });
    const row = store.getMessage('a');
    assert.deepEqual([row.cleanup_machine_hash, row.cleanup_anchor_pid, row.cleanup_code], [EVIDENCE.machineHash, '1736', 'cleanup_failed']);
  } finally { store.close(); }
});

test('an existing database gains the evidence and claim columns; its legacy hold stays held and unreleasable', async (t) => {
  const open = await sharedFile(t);
  const seed = open();
  seed.createThread({ id: 't', spaceId: 'space', subject: 'Legacy' });
  seed.appendMessage('t', { id: 'legacy', kind: 'ask', body: 'Legacy', status: 'queued', to: { agentId: 'reviewer-1' } });
  seed.setCleanup('legacy', UNCONFIRMED);
  const store = open();
  const row = store.getMessage('legacy');
  assert.equal(row.cleanup_evidence_version, null);
  assert.equal(cleanupReleaseProof(row, { ...EVIDENCE, anchor: { ...EVIDENCE.anchor, pid: 4242 } }), null);
  assert.equal(store.releaseProvenCleanup('legacy', { machineHash: EVIDENCE.machineHash, anchorPid: 1736,
    proof: 'boot_anchor_replaced', observation: 'anchor_pid_changed' }), false);
  const { ask, woken } = coordinator(store, { wake: answered });
  assert.equal((await ask('After migration')).reason, 'cleanup_unconfirmed');
  assert.equal(woken.length, 0);
});

test('a pre-existing roundtable file without the new columns is migrated in place', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-cleanup-evidence-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'roundtable.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT, subject TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), seq INTEGER NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, in_reply_to TEXT, from_agent TEXT, from_name TEXT,
      from_client TEXT, from_session TEXT, to_agent TEXT, to_name TEXT, to_client TEXT, to_session TEXT, via TEXT, error TEXT,
      cleanup_status TEXT, cleanup_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(thread_id, seq));
    INSERT INTO threads VALUES ('t', 'space', 'app', 'Legacy', 'now', 'now');
    INSERT INTO messages(id, thread_id, seq, kind, body, status, to_agent, error, cleanup_status, cleanup_code, created_at, updated_at)
      VALUES ('m', 't', 1, 'ask', 'Legacy body', 'queued', 'reviewer-1', 'wake_timeout', 'unconfirmed', 'cleanup_timeout', 'now', 'now');`);
  legacy.close();
  const store = createRoundtableStore(path);
  try {
    const row = store.getMessage('m');
    assert.deepEqual([row.body, row.cleanup_status, row.cleanup_released_at, row.execution_claim],
      ['Legacy body', 'unconfirmed', null, null]);
    assert.deepEqual(store.claimExecution('space', 'reviewer-1', 'new-ask'), { claimed: false, reason: 'cleanup_unconfirmed' });
  } finally { store.close(); }
});

test('the Windows boot-anchor reader returns evidence only for one critical session-0 wininit and null otherwise', async () => {
  const guid = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
  const valid = { anchors: [{ pid: 1736, image: 'C:\\Windows\\System32\\wininit.exe', critical: true }], machineGuid: guid };
  let scripts = 0;
  const read = (result, options = {}) => readWindowsBootAnchor({ salt: 'fuli-test', platform: 'win32',
    run: async (script) => { scripts++; assert.doesNotMatch(script, /CommandLine/); if (result instanceof Error) throw result; return result; },
    ...options });
  const evidence = await read(valid);
  assert.equal(evidence.version, 1);
  assert.deepEqual(evidence.anchor, { pid: 1736, image: 'wininit.exe', critical: true });
  assert.match(evidence.machineHash, /^[0-9a-f]{64}$/);
  assert.equal(evidence.machineHash.includes(guid.replaceAll('-', '')), false, 'the raw machine id is not stored');
  assert.equal((await read({ ...valid, machineGuid: guid.toUpperCase() })).machineHash, evidence.machineHash);
  assert.notEqual((await read(valid, { salt: 'other' })).machineHash, evidence.machineHash);
  for (const [label, result] of [
    ['error', new Error('access denied')],
    ['two anchors', { ...valid, anchors: [valid.anchors[0], { ...valid.anchors[0], pid: 1800 }] }],
    ['no anchor', { ...valid, anchors: [] }],
    ['critical unknown', { ...valid, anchors: [{ ...valid.anchors[0], critical: null }] }],
    ['not critical', { ...valid, anchors: [{ ...valid.anchors[0], critical: false }] }],
    ['other image', { ...valid, anchors: [{ ...valid.anchors[0], image: 'C:\\Temp\\wininit.exe.bak' }] }],
    ['bad pid', { ...valid, anchors: [{ ...valid.anchors[0], pid: 0 }] }],
    ['no machine id', { ...valid, machineGuid: '' }],
    ['partial', null]]) {
    assert.equal(await read(result), null, label);
  }
  const before = scripts;
  assert.equal(await read(valid, { platform: 'linux' }), null);
  assert.equal(await read(valid, { salt: '' }), null);
  assert.equal(scripts, before, 'nothing is queried off Windows or without a salt');
});

// ---- Stage 2: evidence-bound release exists only as an internal CAS ----

function heldRow(store, id = 'held', evidence = EVIDENCE, { spaceId = 'space', agentId = 'reviewer-1' } = {}) {
  if (!store.getThread(`t-${spaceId}`)) store.createThread({ id: `t-${spaceId}`, spaceId, subject: 'T' });
  store.appendMessage(`t-${spaceId}`, { id, kind: 'ask', body: 'Held', status: 'queued', to: { agentId } });
  store.setCleanup(id, UNCONFIRMED, evidence);
  return store.getMessage(id);
}
const replaced = { ...EVIDENCE, anchor: { ...EVIDENCE.anchor, pid: 4242 } };

test('a release proof needs same-machine, recorded-critical evidence and a different current critical anchor', () => {
  const store = createRoundtableStore();
  try {
    const row = heldRow(store);
    assert.deepEqual(cleanupReleaseProof(row, replaced), { machineHash: EVIDENCE.machineHash, anchorPid: '1736',
      proof: 'boot_anchor_replaced', observation: 'anchor_pid_changed' });
    for (const [label, current] of [
      ['same anchor', EVIDENCE],
      ['other machine', { ...replaced, machineHash: 'n'.repeat(64) }],
      ['current not critical', { ...replaced, anchor: { ...replaced.anchor, critical: null } }],
      ['current unknown', null],
      ['current unversioned', { ...replaced, version: 2 }]]) {
      assert.equal(cleanupReleaseProof(row, current), null, label);
    }
    const notCritical = heldRow(store, 'not-critical', { ...EVIDENCE, anchor: { ...EVIDENCE.anchor, critical: false } });
    assert.equal(cleanupReleaseProof(notCritical, replaced), null, 'an anchor never observed critical proves nothing');
    assert.equal(cleanupReleaseProof(heldRow(store, 'no-evidence', null), replaced), null);
  } finally { store.close(); }
});

test('the evidence-bound release succeeds once across coordinators, keeps history, and lifts only its own hold', async (t) => {
  const open = await sharedFile(t);
  const [first, second] = [open(), open()];
  const row = heldRow(first);
  heldRow(first, 'other-space-held', EVIDENCE, { spaceId: 'other-space' });
  const proof = cleanupReleaseProof(row, replaced);
  assert.deepEqual([first.releaseProvenCleanup('held', proof), second.releaseProvenCleanup('held', proof)], [true, false]);
  assert.equal(first.releaseProvenCleanup('held', proof), false, 'a replay changes nothing');
  const released = second.getMessage('held');
  assert.deepEqual([released.cleanup_status, released.cleanup_code, released.status, released.cleanup_release_proof,
    released.cleanup_release_observation, released.cleanup_machine_hash], ['unconfirmed', 'cleanup_timeout', 'queued',
    'boot_anchor_replaced', 'anchor_pid_changed', EVIDENCE.machineHash]);
  assert.match(released.cleanup_released_at, /^\d{4}-/);
  assert.equal(first.releaseProvenCleanup('other-space-held', { ...proof, machineHash: 'n'.repeat(64) }), false);
  assert.deepEqual(second.unconfirmedCleanupFor('space', 'reviewer-1'), []);
  assert.equal(second.unconfirmedCleanupFor('other-space', 'reviewer-1').length, 1, 'another space is untouched');
});

test('production never releases: with recorded evidence and a replaced anchor available, reply, cancel and restart stay held', async (t) => {
  const open = await sharedFile(t);
  const store = open();
  const { roundtable, ask, woken } = coordinator(store, { wake: unconfirmed, bootEvidence: async () => EVIDENCE });
  const first = await ask('First');
  // Even when a new boot would already prove release, no production path evaluates it.
  const later = coordinator(open(), { wake: answered, bootEvidence: async () => replaced });
  await roundtable.replyMessage({ taskContextToken: 'reviewer-token', sourceApplication: 'claude_code', messageId: first.messageId, body: 'alive' });
  await roundtable.ownerCancelMessage({ messageId: first.messageId }).catch(() => {});
  assert.equal((await later.ask('After restart')).reason, 'cleanup_unconfirmed');
  const row = store.getMessage(first.messageId);
  assert.deepEqual([row.cleanup_released_at, row.cleanup_release_proof, row.execution_claim], [null, null, 'active']);
  assert.equal(woken.length + later.woken.length, 1);
});

// ---- Stage 3: one durable, atomic execution claim before any wake ----

function barrier() {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  return { gate, open, started, entered };
}

test('two coordinators on one database start exactly one wake for the same Agent', async (t) => {
  const open = await sharedFile(t);
  const hold = barrier();
  const a = coordinator(open(), { wake: async () => { hold.entered(); await hold.gate; return answered(); } });
  const b = coordinator(open(), { wake: answered });
  const pending = a.ask('From coordinator A');
  await hold.started;
  const refused = await b.ask('From coordinator B');
  assert.deepEqual([refused.status, refused.reason], ['queued', 'execution_claimed']);
  const other = await b.ask('Another Agent is not blocked', 'writer-2');
  assert.equal(other.status, 'answered');
  hold.open();
  assert.equal((await pending).status, 'answered');
  assert.equal(a.woken.length + b.woken.length, 2, 'one wake for reviewer-1 and one for writer-2');
  assert.equal((await b.ask('After the first run ended')).status, 'answered', 'an observed end finishes the claim');
});

test('concurrent claims inside one tick still yield a single owner', async (t) => {
  const open = await sharedFile(t);
  const [one, two] = [open(), open()];
  for (const store of [one, two]) {
    if (!store.getThread('t')) store.createThread({ id: 't', spaceId: 'space', subject: 'T' });
  }
  one.appendMessage('t', { id: 'x', kind: 'ask', body: 'X', status: 'queued', to: { agentId: 'reviewer-1' } });
  two.appendMessage('t', { id: 'y', kind: 'ask', body: 'Y', status: 'queued', to: { agentId: 'reviewer-1' } });
  const results = await Promise.all([Promise.resolve().then(() => one.claimExecution('space', 'reviewer-1', 'x')),
    Promise.resolve().then(() => two.claimExecution('space', 'reviewer-1', 'y'))]);
  assert.deepEqual(results.map((result) => result.claimed).sort(), [false, true]);
  assert.equal(one.claimExecution('space', 'reviewer-1', 'x').claimed, false, 'an existing claim is never re-taken');
});

test('a reply before the process ends and a restart keep the claim; an unknown crash leaves it held', async (t) => {
  const open = await sharedFile(t);
  const hold = barrier();
  const store = open();
  const a = coordinator(store, { wake: async () => { hold.entered(); await hold.gate; return answered(); } });
  const pending = a.ask('Long run');
  await hold.started;
  // The held Agent answers in its inbox while the process is still running: not evidence it exited.
  const target = (await a.roundtable.threads()).threads[0];
  const message = a.roundtable.thread({ threadId: target.id }).messages[0];
  await a.roundtable.replyMessage({ taskContextToken: 'reviewer-token', sourceApplication: 'claude_code', messageId: message.id, body: 'early' })
    .catch(() => {});
  const restarted = coordinator(open(), { wake: answered });
  assert.equal((await restarted.ask('After reply and restart')).reason, 'execution_claimed');
  assert.equal(restarted.woken.length, 0);
  // Simulated host crash: the run never reports. The claim stays; nothing expires it.
  assert.equal(store.getMessage(message.id).execution_claim, 'active');
  hold.open();
  await pending;
});

test('cancel and an unconfirmed cleanup keep the claim; a wake that never started finishes it', async (t) => {
  const open = await sharedFile(t);
  const store = open();
  const held = coordinator(store, { wake: unconfirmed });
  const first = await held.ask('Unconfirmed');
  await held.roundtable.ownerCancelMessage({ messageId: first.messageId }).catch(() => {});
  assert.equal(store.getMessage(first.messageId).execution_claim, 'active');
  assert.equal((await coordinator(open(), { wake: answered }).ask('Next')).reason, 'cleanup_unconfirmed');

  const fresh = open();
  const notStarted = coordinator(fresh, { wake: async () => {
    throw Object.assign(new Error('cancelled before start'), { code: 'cancelled', started: false });
  } });
  const refused = await notStarted.ask('Never started', 'writer-2');
  assert.equal(refused.reason, 'cancelled');
  assert.equal(fresh.getMessage(refused.messageId).execution_claim, 'finished');
  assert.equal((await coordinator(open(), { wake: answered }).ask('Writer free again', 'writer-2')).status, 'answered');
});
