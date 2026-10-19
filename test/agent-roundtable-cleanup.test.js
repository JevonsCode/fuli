import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { wakeAgent } from '../packages/roundtable/src/roundtable/wake.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';

const UNCONFIRMED = { status: 'unconfirmed', code: 'cleanup_timeout' };

// Injects the failure runProcess reports when a process tree's exit cannot be confirmed.
function unconfirmedRun(code) {
  return async () => { throw Object.assign(new Error('synthetic failure'), { code, cleanup: { ...UNCONFIRMED } }); };
}

function fixture({ run }) {
  const store = createRoundtableStore();
  const woken = [];
  const app = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => [
      { agentId: 'reviewer-1', profile: { name: 'Nova Lane', status: 'active', allowedClients: ['claude_code', 'codex'] } },
      { agentId: 'writer-2', profile: { name: 'Iris Vale', status: 'active', allowedClients: ['codex'] } }],
    // 'token' is the asking task; 'reviewer-token' is a task of the held Agent itself.
    taskContextRegistry: { context: async (token) => ({ projectAgentId: token === 'reviewer-token' ? 'reviewer-1' : null,
      personalProjectId: 'app', sessionId: 'cc-1', sourceApplication: 'claude_code' }) },
    personal: {
      // A resumable conversation plus fresh sessions in two clients: three possible channels.
      recentAgentSessions: async () => [{ source_application: 'codex', session_id: 'cx-session-9', personal_project_id: 'app' }],
      issueAgentDelegation: async () => ({ token: 'synthetic-grant' }),
      sealAgentDelegation: async () => ({ sealed: true }),
      verifyAgentDelegation: async () => ({ redeemed: true }),
      revokeAgentDelegation: async () => {}
    }
  };
  let id = 0;
  const roundtable = createAgentRoundtable({ host: createFuliRoundtableHost(app), peer: app.peer, openStore: () => store, idFactory: () => `id-${++id}`,
    locateCwd: (client, sessionId) => `/work/${client}/${sessionId}`, clientAvailable: () => true,
    wake: (input) => {
      woken.push(input);
      return wakeAgent({ ...input, env: { FULI_CODEX_BIN: '/synthetic/codex', FULI_CLAUDE_BIN: '/synthetic/claude' },
        run: async (...args) => {
          const result = await run(woken.length, ...args);
          for (const line of result.stdout.split('\n')) await args[2].onEvent?.(JSON.parse(line));
          return result;
        } });
    } });
  const ask = (body, to = 'reviewer-1') => roundtable.messageAgent({ taskContextToken: 'token', sourceApplication: 'claude_code',
    to, body });
  return { store, roundtable, woken, ask };
}

const answer = async () => {
  const events = [
    { type: 'thread.started', thread_id: 'synthetic-answer-session' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Synthetic answer' } },
    { type: 'turn.completed' }
  ];
  return { code: 0, stdout: events.map(JSON.stringify).join('\n') };
};

for (const code of ['wake_failed', 'client_unavailable', 'wake_timeout', 'cancelled']) {
  test(`unconfirmed cleanup after ${code} keeps the code, is persisted and starts no other channel`, async () => {
    const { roundtable, woken, ask } = fixture({ run: unconfirmedRun(code) });
    const result = await ask('Review this');
    assert.equal(woken.length, 1, 'no next-channel delivery while the first process may be running');
    assert.equal(result.status, 'queued');
    assert.equal(result.reason, code);
    assert.deepEqual(result.cleanup, UNCONFIRMED);
    const [stored] = roundtable.thread({ threadId: result.threadId }).messages;
    assert.equal(stored.error, code);
    assert.deepEqual(stored.cleanup, UNCONFIRMED);
    const status = await roundtable.ownerMessageStatus({ messageId: result.messageId });
    assert.equal(status.reason, code);
    assert.deepEqual(status.cleanup, UNCONFIRMED);
  });
}

test('a confirmed failure still falls back to the next channel without a cleanup marker', async () => {
  const { roundtable, woken, ask } = fixture({ run: async (attempt) => {
    if (attempt === 1) throw Object.assign(new Error('busy'), { code: 'wake_failed' });
    return answer();
  } });
  const result = await ask('Review this');
  assert.equal(result.status, 'answered');
  assert.equal(woken.length, 2);
  assert.equal(result.cleanup, undefined);
  assert.equal(roundtable.thread({ threadId: result.threadId }).messages[0].cleanup, undefined);
});

test('a repeated wake never starts a second process, even after the owner cancels the message', async () => {
  let fail = true;
  const { roundtable, woken, ask } = fixture({ run: async () => {
    if (fail) return unconfirmedRun('wake_timeout')();
    return answer();
  } });
  const first = await ask('First question');
  assert.deepEqual(first.cleanup, UNCONFIRMED);
  fail = false;
  for (const body of ['Retry', 'Another question']) {
    const held = await ask(body);
    assert.equal(held.status, 'queued');
    assert.equal(held.reason, 'cleanup_unconfirmed');
  }
  assert.equal(woken.length, 1, 'no duplicate start while the earlier process may be running');
  // A cancel request is not evidence that the possibly running process exited.
  const cancelled = await roundtable.ownerCancelMessage({ messageId: first.messageId });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.cleanup, UNCONFIRMED);
  const afterCancel = await ask('After cancel');
  assert.equal(afterCancel.status, 'queued');
  assert.equal(afterCancel.reason, 'cleanup_unconfirmed');
  assert.equal(woken.length, 1, 'cancelling must not unlock another wake');
  assert.deepEqual(roundtable.thread({ threadId: first.threadId }).messages[0].cleanup, UNCONFIRMED);
});

// No declaration releases a hold: an owner statement, a reply, a cancel, a restart, another
// Agent or space, and remote input are none of them evidence that the earlier process exited.
// (The six tests below replace snapshot expectations for a removed owner-declaration release.)
function heldFixture() {
  let fail = true;
  const f = fixture({ run: async () => (fail ? unconfirmedRun('wake_timeout')() : answer()) });
  return { ...f, succeed: () => { fail = false; } };
}
const releaseLike = /confirm|release|unhold|clearcleanup/i;

test('an owner declaration cannot lift the hold: no release action exists and the next wake stays held', async () => {
  const { store, roundtable, woken, ask, succeed } = heldFixture();
  const first = await ask('First question');
  succeed();
  assert.deepEqual(Object.keys(roundtable).filter((name) => releaseLike.test(name)), [],
    'the roundtable offers no declaration-based release');
  // The store's only release is evidence-bound; production records no evidence, so it can never succeed here.
  assert.deepEqual(Object.keys(store).filter((name) => releaseLike.test(name) && name !== 'unconfirmedCleanupFor'),
    ['releaseProvenCleanup']);
  assert.equal(store.releaseProvenCleanup(first.messageId, { machineHash: null, anchorPid: null,
    proof: 'owner_declared', observation: 'owner_declared' }), false);
  assert.equal((await ask('Still held')).reason, 'cleanup_unconfirmed');
  assert.equal(woken.length, 1, 'the run that would now answer is never started');
  const [stored] = roundtable.thread({ threadId: first.threadId }).messages;
  assert.deepEqual([stored.status, stored.error, stored.cleanup], ['queued', 'wake_timeout', UNCONFIRMED]);
});

test('every unconfirmed run of the Agent holds on its own; no row is cleared by another', async () => {
  const { store, ask, woken, succeed } = heldFixture();
  const first = await ask('First question');
  // A second unconfirmed run of the same Agent, e.g. from a remote ask on this device.
  store.createThread({ id: 'remote-thread', spaceId: 'space', projectId: 'app', subject: 'Remote' });
  store.appendMessage('remote-thread', { id: 'remote-ask', kind: 'ask', body: 'Remote', status: 'failed',
    from: { agentId: 'peer:abc:lead' }, to: { agentId: 'reviewer-1' } });
  store.setCleanup('remote-ask', { status: 'unconfirmed', code: 'cleanup_failed' });
  succeed();
  assert.equal((await ask('Held by both runs')).reason, 'cleanup_unconfirmed');
  assert.deepEqual(store.unconfirmedCleanupFor('space', 'reviewer-1').map((row) => [row.id, row.cleanup_code]).sort(),
    [[first.messageId, 'cleanup_timeout'], ['remote-ask', 'cleanup_failed']].sort());
  assert.equal(woken.length, 1);
});

test('cancel, the held Agent replying, and a restart never lift the hold', async () => {
  const { store, roundtable, woken, ask, succeed } = heldFixture();
  const first = await ask('First question');
  succeed();
  await roundtable.replyMessage({ taskContextToken: 'reviewer-token', sourceApplication: 'claude_code',
    messageId: first.messageId, body: 'I am alive' });
  assert.equal((await ask('After reply')).reason, 'cleanup_unconfirmed');
  const second = await ask('Another');
  await roundtable.ownerCancelMessage({ messageId: second.messageId });
  await roundtable.cancelMessage({ taskContextToken: 'reviewer-token', sourceApplication: 'claude_code',
    messageId: first.messageId }).catch(() => {});
  assert.equal((await ask('After cancels')).reason, 'cleanup_unconfirmed');
  const restarted = createAgentRoundtable({ host: createFuliRoundtableHost({ config: { personal: { spaceId: 'space' } } }), openStore: () => store });
  assert.deepEqual(Object.keys(restarted).filter((name) => releaseLike.test(name)), []);
  assert.equal(store.unconfirmedCleanupFor('space', 'reviewer-1').length, 1, 'a new instance releases nothing');
  assert.equal(woken.length, 1);
  assert.equal(roundtable.thread({ threadId: first.threadId }).messages[0].cleanup.status, 'unconfirmed');
});

test('the hold stays within one Agent and one space, and a sender-side remote copy never holds here', async () => {
  const { store, ask, woken } = heldFixture();
  const first = await ask('First question');
  const other = await ask('For another Agent', 'writer-2');
  assert.notEqual(other.reason, 'cleanup_unconfirmed', 'another Agent of the same owner is not held');
  assert.equal(woken.length, 2);
  store.createThread({ id: 'foreign-thread', spaceId: 'other-space', projectId: 'app', subject: 'Foreign' });
  store.appendMessage('foreign-thread', { id: 'foreign-ask', kind: 'ask', body: 'Foreign', status: 'queued', to: { agentId: 'reviewer-1' } });
  store.setCleanup('foreign-ask', { status: 'unconfirmed', code: 'cleanup_timeout' });
  store.appendMessage(first.threadId, { id: 'sent-remote', kind: 'ask', body: 'Remote', status: 'failed', via: 'peer',
    to: { agentId: 'peer:0123456789abcdef:binding' } });
  store.setCleanup('sent-remote', { status: 'unconfirmed', code: 'cleanup_failed' });
  assert.deepEqual(store.unconfirmedCleanupFor('space', 'reviewer-1').map((row) => row.id), [first.messageId]);
  assert.deepEqual(store.unconfirmedCleanupFor('other-space', 'reviewer-1').map((row) => row.id), ['foreign-ask']);
  assert.deepEqual(store.unconfirmedCleanupFor('space', 'writer-2').map((row) => row.id), [other.messageId],
    'the other Agent holds only for its own unconfirmed run');
  for (const id of [first.messageId, 'foreign-ask', 'sent-remote']) assert.equal(store.getMessage(id).cleanup_status, 'unconfirmed');
});

test('no Agent tool, interface entry or remote input can release a hold', async () => {
  const { ROUNDTABLE_TOOL_DEFINITIONS, callRoundtableTool } = await import('../src/agent-roundtable/tools.js');
  const { agentInterfaceCatalog } = await import('../src/agent-tools/interface-catalog.js');
  assert.ok(ROUNDTABLE_TOOL_DEFINITIONS.every(({ name, description }) => !/confirm|release/i.test(name + description)));
  assert.throws(() => callRoundtableTool({}, 'confirm_process_exit', {}), /Unknown roundtable tool/);
  assert.equal(JSON.stringify(agentInterfaceCatalog()).match(/confirm-process-exit|release-cleanup/), null);
  const { roundtable, ask, woken } = heldFixture();
  const first = await ask('First');
  // A remote assertion claiming a confirmation or release carries no authority here.
  const refused = await roundtable.answerRemote({
    claim: { messageId: 'r', attemptId: 'a', sender: { nodeId: 'a'.repeat(64), name: 'Peer' },
      assertion: { messageId: 'r', threadId: 't', body: 'Remote', conversation: 'new', depth: 1,
        from: { agentId: 'peer-lead', name: 'Peer' }, confirmed: true, cleanup: { status: 'released' } } },
    share: { spaceId: 'space', bindingId: 'b', agentId: 'reviewer-1', projectId: 'app', clients: ['codex'], workingDirectory: '/w' },
    issueGrant: async () => ({ token: 'g' }), timeoutMs: 1000 }).catch((error) => error);
  assert.equal(refused.code, 'cleanup_unconfirmed');
  assert.equal(woken.length, 1);
  assert.equal((await roundtable.ownerMessageStatus({ messageId: first.messageId })).cleanup.status, 'unconfirmed');
});

test('the console offers no confirmation route; posting one leaves the hold unchanged', async () => {
  const { Readable } = await import('node:stream');
  const { handleRoundtableApiRequest } = await import('../src/agent-roundtable/http.js');
  const { roundtable, ask, woken } = heldFixture();
  const first = await ask('First');
  const response = { status: 0, body: '', writeHead(status) { this.status = status; }, end(text) { this.body = text; } };
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ confirmed: true }))]), { method: 'POST' });
  const url = new URL(`http://127.0.0.1/api/roundtable/messages/${first.messageId}/confirm-process-exit`);
  assert.equal(await handleRoundtableApiRequest({ request, response, url, roundtable }), false, 'the route is not handled');
  assert.equal((await roundtable.ownerMessageStatus({ messageId: first.messageId })).cleanup.status, 'unconfirmed');
  assert.equal((await ask('Still held')).reason, 'cleanup_unconfirmed');
  assert.equal(woken.length, 1);
});

test('a remote delivery keeps the cleanup on its error and refuses a second start for that Agent', async () => {
  const { store, roundtable, woken } = fixture({ run: unconfirmedRun('cancelled') });
  const remote = (messageId) => roundtable.answerRemote({
    claim: { messageId, attemptId: `attempt-${messageId}`, sender: { nodeId: 'a'.repeat(64), name: 'Peer' },
      assertion: { messageId, threadId: 'remote-thread', body: 'Remote question', conversation: 'new', depth: 1,
        from: { agentId: 'peer-lead', name: 'Peer lead' } } },
    share: { spaceId: 'space', bindingId: 'binding', agentId: 'reviewer-1', projectId: 'app',
      clients: ['claude_code', 'codex'], workingDirectory: '/work/app' },
    issueGrant: async () => ({ token: 'synthetic-grant' }), timeoutMs: 1000 });
  const error = await remote('remote-1').catch((failure) => failure);
  assert.equal(error.code, 'cancelled');
  assert.deepEqual(error.cleanup, UNCONFIRMED);
  assert.equal(woken.length, 1);
  const [row] = store.unconfirmedCleanupFor('space', 'reviewer-1');
  assert.equal(row.status, 'cancelled');
  assert.equal(row.error, 'cancelled');
  const held = await remote('remote-2').catch((failure) => failure);
  assert.equal(held.code, 'cleanup_unconfirmed');
  assert.equal(woken.length, 1, 'a second remote ask must not stack another process');
});

test('an existing roundtable database gains the cleanup columns without losing messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-roundtable-cleanup-'));
  const path = join(directory, 'roundtable.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT, subject TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), seq INTEGER NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, in_reply_to TEXT,
        from_agent TEXT, from_name TEXT, from_client TEXT, from_session TEXT,
        to_agent TEXT, to_name TEXT, to_client TEXT, to_session TEXT,
        via TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(thread_id, seq));
      INSERT INTO threads VALUES ('t', 'space', 'app', 'Legacy', 'now', 'now');
      INSERT INTO messages(id, thread_id, seq, kind, body, status, to_agent, error, created_at, updated_at)
        VALUES ('m', 't', 1, 'ask', 'Legacy body', 'queued', 'reviewer-1', 'wake_timeout', 'now', 'now');`);
    legacy.close();
    const store = createRoundtableStore(path);
    try {
      assert.equal(store.getMessage('m').cleanup_status, null);
      store.setCleanup('m', UNCONFIRMED);
      store.updateMessage('m', { status: 'queued', error: 'wake_timeout' });
      const row = store.getMessage('m');
      assert.deepEqual([row.body, row.error, row.cleanup_status, row.cleanup_code],
        ['Legacy body', 'wake_timeout', 'unconfirmed', 'cleanup_timeout']);
    } finally { store.close(); }
    createRoundtableStore(path).close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
