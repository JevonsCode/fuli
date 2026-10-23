import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { mapHttpError } from '../src/http/error-mapping.js';
import { createJudgmentEngine } from '../src/judgment/engine.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { knowledgeHardDelete } from '../src/knowledge-hard-delete/console-port.js';
import { HARD_DELETE_LEDGER_FILE, deletedKnowledgeBeside, hardDeleteLedger } from '../src/knowledge-hard-delete/delete-ledger.js';
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';
import { PREVIEW_ID, syntheticGraph } from '../test-support/hard-delete-graph.js';
import { completePreferences } from './fixtures/collaboration-preferences.js';
import { MODEL_ANSWER, trustedTonborg } from './fixtures/model-trust.js';

// rec#5 C9, dot's review of #273: a delete whose answer is lost or whose
// console crashes is settled from its recorded operation and cleaned up to
// the end, and work that started before a delete never writes the deleted
// words back into a local store. Synthetic graph, synthetic records.

const SPACE = 'personal-space';
// These legacy cleanup tests isolate their fence from the separately tested recovery gate.
const recoveryGate = { state: () => ({ state: 'open' }) };
const PASTED = 'SYNTHETIC-PASTED-KEY-0000-not-a-real-secret';
const CONFIRM = { personalSpaceId: SPACE, itemKind: 'entity', itemId: 'item-2', previewId: PREVIEW_ID, confirmation: '删除' };

function dataDirectory(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-hard-delete-recovery-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

// A Tonborg judgment that kept the words of item-2, as a store holds it.
function rememberWords(dataDir) {
  const store = new JudgmentStore(join(dataDir, 'judgment.sqlite'), { recoveryGate });
  store.record(SPACE, { kind: 'review', target: 'entity:item-2', title: `Deploy with ${PASTED}`,
    summary: `Approve ${PASTED}`, evidence: [], outcome: 'escalate', confidence: 0.4 }, 'review:item-2');
  store.close();
}

function storesHold(dataDir, words = PASTED) {
  return ['judgment.sqlite', 'role-work.sqlite'].flatMap((name) => [name, `${name}-wal`, `${name}-journal`])
    .filter((file) => existsSync(join(dataDir, file)) && readFileSync(join(dataDir, file)).includes(Buffer.from(words)));
}

const ledgerState = (dataDir) => hardDeleteLedger(dataDir).find(SPACE, 'item-2')?.state;
const fenced = (dataDir) => deletedKnowledgeBeside(join(dataDir, 'judgment.sqlite'))().names('entity:item-2');

test('an answer lost after the graph committed is settled by asking, then cleaned up to the end', async (t) => {
  const dataDir = dataDirectory(t);
  rememberWords(dataDir);
  const graph = syntheticGraph();
  graph.answerDelete = 'lost';
  const result = await knowledgeHardDelete(dataDir, { send: graph.send }).confirm(CONFIRM);
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(result.deleted_item_ids, ['item-2', 'item-1', 'fact-1']);
  // The delete was sent once, named by its operation; the outcome came from
  // the graph's record of that operation.
  const deletes = graph.calls.filter((call) => call.path.endsWith('/hard-delete'));
  assert.equal(deletes.length, 1);
  const operation = hardDeleteLedger(dataDir).find(SPACE, 'item-2');
  assert.equal(deletes[0].payload.operation_id, operation.id);
  assert.equal(graph.calls.at(-1).path, `/v1/knowledge/hard-delete-operations/${operation.id}`);
  assert.equal(operation.state, 'complete');
  assert.deepEqual(storesHold(dataDir), []);
});

test('a crash after the graph committed is finished by the next console start', async (t) => {
  const dataDir = dataDirectory(t);
  rememberWords(dataDir);
  const graph = syntheticGraph();
  // The answer is lost and the graph cannot be asked before the console stops.
  graph.answerDelete = 'lost';
  graph.statusDown = true;
  const first = await knowledgeHardDelete(dataDir, { send: graph.send }).confirm(CONFIRM);
  assert.equal(first.outcome, 'unknown');
  assert.equal(ledgerState(dataDir), 'pending');
  assert.deepEqual(storesHold(dataDir), ['judgment.sqlite'], 'nothing was claimed or cleaned yet');
  // The next start reconciles from the record, without sending the delete again.
  graph.statusDown = false;
  const sent = graph.calls.filter((call) => call.path.endsWith('/hard-delete')).length;
  const [settled] = await knowledgeHardDelete(dataDir, { send: graph.send }).reconcile();
  assert.equal(settled.outcome, 'complete');
  assert.equal(graph.calls.filter((call) => call.path.endsWith('/hard-delete')).length, sent);
  assert.equal(ledgerState(dataDir), 'complete');
  assert.deepEqual(storesHold(dataDir), []);
});

test('a crash between the graph commit and the local cleanup is cleaned up from the record', async (t) => {
  const dataDir = dataDirectory(t);
  rememberWords(dataDir);
  const graph = syntheticGraph();
  const broken = [{ name: 'judgment.sqlite', forget: () => { throw new Error('synthetic crash before cleanup'); } }];
  const first = await knowledgeHardDelete(dataDir, { send: graph.send, localStores: broken }).confirm(CONFIRM);
  assert.equal(first.outcome, 'local_pending');
  assert.equal(ledgerState(dataDir), 'graph_deleted');
  const [finished] = await knowledgeHardDelete(dataDir, { send: graph.send }).reconcile();
  assert.equal(finished.outcome, 'complete');
  assert.equal(ledgerState(dataDir), 'complete');
  assert.deepEqual(storesHold(dataDir), []);
  assert.deepEqual(await knowledgeHardDelete(dataDir, { send: graph.send }).reconcile(), []);
});

test('a retry after a 410, or an old link\'s page, finishes the cleanup the graph delete needs', async (t) => {
  const dataDir = dataDirectory(t);
  rememberWords(dataDir);
  const graph = syntheticGraph();
  graph.deleted = true;
  // Deleted from another console: this one never sent it.
  const page = await knowledgeHardDelete(dataDir, { send: graph.send }).status(CONFIRM);
  assert.equal(page.outcome, 'complete');
  assert.deepEqual(storesHold(dataDir), []);
  // A retried confirm whose delete answers 410: the graph recorded the refusal
  // as "already deleted", and the console cleans up after that delete.
  const again = dataDirectory(t);
  rememberWords(again);
  const retried = syntheticGraph();
  retried.answerDelete = 'gone';
  const port = knowledgeHardDelete(again, { send: async (path, payload, options) => {
    if (path.endsWith('/hard-delete')) retried.deleted = true;
    return retried.send(path, payload, options);
  } });
  assert.equal((await port.confirm(CONFIRM)).outcome, 'complete');
  assert.deepEqual(storesHold(again), []);
});

test('only a refusal the graph recorded says nothing was deleted, and it releases the fence', async (t) => {
  const dataDir = dataDirectory(t);
  rememberWords(dataDir);
  const refused = syntheticGraph();
  refused.answerDelete = 'refused';
  await assert.rejects(knowledgeHardDelete(dataDir, { send: refused.send }).confirm(CONFIRM),
    (error) => error.status === 422 && error.code === 'hard_delete_unconfirmed');
  assert.equal(ledgerState(dataDir), 'not_deleted');
  assert.equal(fenced(dataDir), false);
});

test('a delete held past the window, then committed, stays unknown with the fence held and ends fully cleaned', async (t) => {
  const dataDir = dataDirectory(t);
  rememberWords(dataDir);
  const graph = syntheticGraph();
  // Real time: the console stops waiting after 50 ms and may abort after
  // 150 ms; the graph holds the delete's transaction for 600 ms, then commits.
  graph.holdMs = 600;
  const port = () => knowledgeHardDelete(dataDir, { send: graph.send, deleteTimeoutMs: 50, abortAfterMs: 150 });
  const started = Date.now();
  assert.equal((await port().confirm(CONFIRM)).outcome, 'unknown');
  assert.equal(ledgerState(dataDir), 'pending');
  assert.equal(fenced(dataDir), true, 'unknown keeps the fence');
  assert.equal((await port().status(CONFIRM)).outcome, 'unknown');
  assert.equal(fenced(dataDir), true);
  await delay(200);
  assert.ok(Date.now() - started > 150, 'past the window');
  assert.equal(graph.deleted, false, 'the delete still runs');
  // Past the window the console asks the graph to abort: the abort waits for
  // the running delete, which commits, so the answer is committed.
  const settled = await port().status(CONFIRM);
  assert.equal(settled.outcome, 'complete');
  assert.ok(Date.now() - started >= 600, 'the answer came only after the commit');
  assert.equal(graph.deleted, true);
  assert.equal(ledgerState(dataDir), 'complete');
  assert.equal(fenced(dataDir), true, 'a deleted item stays fenced');
  assert.deepEqual(storesHold(dataDir), []);
});

test('an abort that wins proves nothing was deleted, and a delete that arrives after it is refused', async (t) => {
  const dataDir = dataDirectory(t);
  rememberWords(dataDir);
  const graph = syntheticGraph();
  // The delete is stuck on its way for 500 ms; the console gave up after 50.
  graph.arriveAfterMs = 500;
  const port = () => knowledgeHardDelete(dataDir, { send: graph.send, deleteTimeoutMs: 50, abortAfterMs: 150 });
  assert.equal((await port().confirm(CONFIRM)).outcome, 'unknown');
  assert.equal(fenced(dataDir), true);
  await delay(200);
  const operation = hardDeleteLedger(dataDir).find(SPACE, 'item-2');
  const settled = await port().status(CONFIRM);
  assert.equal(settled.outcome, 'not_deleted');
  assert.equal(graph.operations.get(operation.id).state, 'aborted');
  assert.equal(fenced(dataDir), false, 'only a confirmed outcome releases the fence');
  // The late delete arrives, finds the abort under the same lock and is refused.
  await delay(450);
  assert.equal(graph.deleted, false);
  assert.equal(graph.operations.get(operation.id).state, 'aborted');
});

// Tonborg's configured model is trusted (rec#10 D-36.7): the fence holds all the same.
test('a Tonborg review that was answering when the person deleted never records the deleted words', async (t) => {
  const dataDir = dataDirectory(t);
  const candidates = [{ candidate_key: 'entity:item-2', title: `Deploy with ${PASTED}`, content: PASTED,
    confirmation_status: 'confirmed', changed_at: '2026-01-01', reasons: [], project_ids: ['p'] }];
  const writes = [];
  const app = { config: { personal: { spaceId: SPACE } },
    listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'],
      capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => completePreferences(),
    inspectProjectAgentMemory: async () => ({ current: null, revision: 0 }),
    employees: { authorize: async () => ({}) }, personal: {},
    startKnowledgeReview: async () => ({ review_id: 'review' }), finishKnowledgeReview: async () => ({}),
    listKnowledgeReviewCandidates: async () => ({ candidates, total_candidate_count: candidates.length }),
    getCapturePolicy: () => ({ enabled: true }),
    recordKnowledgeReviewProgress: async (input) => { writes.push(input); return { outcome: 'ai_reviewed' }; }, listExecutors: async () => [] };
  // Barrier: the person deletes the item, and the cleanup finishes, while the model answers.
  const judge = async () => {
    const deleted = await knowledgeHardDelete(dataDir, { send: syntheticGraph().send }).confirm(CONFIRM);
    assert.equal(deleted.outcome, 'complete');
    return { body: JSON.stringify({ decisions: [{ target: 'entity:item-2', outcome: 'approve',
      summary: `Keep ${PASTED}`, evidence: [`said ${PASTED}`], confidence: 0.95 }] }), ...MODEL_ANSWER, client: 'codex',
    sessionId: 'synthetic-session' };
  };
  const service = createJudgmentService({ app, engine: createJudgmentEngine({ app, judge, trust: trustedTonborg() }),
    openStore: () => new JudgmentStore(join(dataDir, 'judgment.sqlite'), { recoveryGate }) });
  t.after(() => service.close());
  service.store().setPolicy(SPACE, '', { mode: 'shared', quality: 'quality', client: 'codex' }, 0);
  const result = await service.review({ personalSpaceId: SPACE, personalProjectId: 'p', requestId: 'barrier-1', limit: 10 });
  assert.equal(result.records.some((record) => record.target === 'entity:item-2'), false);
  assert.deepEqual(writes, []);
  service.close();
  assert.deepEqual(storesHold(dataDir), []);
});

test('a late answer or result of handed-off work keeps no deleted words', async (t) => {
  const dataDir = dataDirectory(t);
  const path = join(dataDir, 'role-work.sqlite');
  const at = new Date('2026-10-22T00:00:00Z');
  // A long-running process holds the store from before the delete.
  const running = new RoleWorkStore(path, { recoveryGate });
  t.after(() => running.close());
  const pkg = running.create({ request: { role: 'tonborg', operation: 'review', requestId: 'late-1',
    scope: { personalSpaceId: SPACE, personalProjectId: null, sessionRef: null }, versions: { evidence: 'e', policy: 'p' },
    instructions: 'Review these candidates.', evidence: [{ key: 'candidates', value: [
      { candidate_key: 'entity:item-2', item_id: 'item-2', title: `Deploy with ${PASTED}` }] }] },
  reason: 'no_model', at, ttlMs: 60_000 });
  running.claim(pkg.packageId, { sessionRef: 's', sourceApplication: 'codex' }, { leaseToken: 'lease', leaseExpiresAt: new Date(at.getTime() + 60_000), at });
  assert.equal((await knowledgeHardDelete(dataDir, { send: syntheticGraph().send }).confirm(CONFIRM)).outcome, 'complete');
  // Barrier: the answer and the result arrive after the delete and its cleanup.
  running.transition(pkg.packageId, ['claimed'], { submission: { decisions: [{ target: 'entity:item-2',
    summary: `Keep ${PASTED}` }] }, result: { candidate_key: 'entity:item-2', title: `Deploy with ${PASTED}` } },
  { name: 'submitted', detail: { candidate_key: 'entity:item-2', reason: `about ${PASTED}` } }, at);
  const stored = running.get(pkg.packageId);
  assert.deepEqual([stored.submission.decisions[0].summary, stored.result.title, stored.result.hard_deleted], [null, null, true]);
  running.close();
  assert.deepEqual(storesHold(dataDir), []);
});

test('a reader that pins an old snapshot keeps the cleanup pending until it closes', async (t) => {
  const dataDir = dataDirectory(t);
  const path = join(dataDir, 'judgment.sqlite');
  new JudgmentStore(path).close();
  const setup = new DatabaseSync(path);
  setup.exec('PRAGMA journal_mode = WAL');
  setup.close();
  rememberWords(dataDir);
  // Another connection holds an open read transaction on the old snapshot.
  const reader = new DatabaseSync(path);
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) AS n FROM judgment_records').get();
  const graph = syntheticGraph();
  const first = await knowledgeHardDelete(dataDir, { send: graph.send }).confirm(CONFIRM);
  assert.equal(first.outcome, 'local_pending');
  const [judgment] = first.local_stores;
  assert.deepEqual([judgment.store, judgment.status], ['judgment.sqlite', 'failed']);
  assert.match(judgment.reason, /older snapshot/);
  assert.equal(ledgerState(dataDir), 'graph_deleted');
  // The reader closes; the next run checkpoints fully and completes.
  reader.exec('COMMIT');
  const [finished] = await knowledgeHardDelete(dataDir, { send: graph.send }).reconcile();
  assert.equal(finished.outcome, 'complete');
  assert.equal(ledgerState(dataDir), 'complete');
  assert.equal(statSync(join(dataDir, 'judgment.sqlite-wal')).size, 0);
  assert.equal(reader.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  reader.close();
  assert.deepEqual(storesHold(dataDir), []);
});

const DAMAGED = {
  'operations missing': { version: 1 },
  'operations an object': { version: 1, operations: { id: 'x' } },
  'an illegal state': { version: 1, operations: [{ id: 'op-1', spaceId: SPACE, itemKind: 'entity', itemId: 'item-2',
    itemIds: ['item-2'], state: 'deleted-ish', previewId: null, deletionId: null, deletedAt: null,
    createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' }] },
  'an entry without its IDs': { version: 1, operations: [{ id: 'op-1', state: 'complete' }] }
};

for (const [shape, document] of Object.entries(DAMAGED)) {
  test(`a damaged ledger (${shape}) stops every fenced write and says how to repair it`, async (t) => {
    const dataDir = dataDirectory(t);
    rememberWords(dataDir);
    writeFileSync(join(dataDir, HARD_DELETE_LEDGER_FILE), JSON.stringify(document));
    const store = new JudgmentStore(join(dataDir, 'judgment.sqlite'), { recoveryGate });
    const write = () => store.record(SPACE, { kind: 'review', target: 'entity:other', title: 'Synthetic words' }, 'review:other');
    assert.throws(write, (error) => error.code === 'data_format_damaged' && /moving it out of the data directory/.test(error.message));
    store.close();
    const port = knowledgeHardDelete(dataDir, { send: syntheticGraph().send });
    const refused = await port.confirm(CONFIRM).catch((error) => error);
    assert.equal(refused.code, 'data_format_damaged');
    // The console route answers with the reason and the repair.
    const mapped = mapHttpError(refused);
    assert.equal(mapped.status, 503);
    assert.match(mapped.body.error, /restoring it from a format backup/);
    await assert.rejects(port.reconcile(), (error) => error.code === 'data_format_damaged');
    // Nothing was rewritten from what could be read.
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, HARD_DELETE_LEDGER_FILE), 'utf8')), document);
  });
}

test('a ledger that is not JSON at all is damaged too, while a missing one is a first use', async (t) => {
  const dataDir = dataDirectory(t);
  writeFileSync(join(dataDir, HARD_DELETE_LEDGER_FILE), '{"version": 1, "operations": [');
  assert.throws(() => deletedKnowledgeBeside(join(dataDir, 'judgment.sqlite'))(), (error) => error.code === 'data_format_damaged');
  const fresh = dataDirectory(t);
  assert.equal(deletedKnowledgeBeside(join(fresh, 'judgment.sqlite'))().names('entity:item-2'), false);
});

test('a ledger moved aside or restored from an older backup is rebuilt from the graph\'s deletion records', async (t) => {
  const dataDir = dataDirectory(t);
  const graph = syntheticGraph();
  const port = () => knowledgeHardDelete(dataDir, { send: graph.send, personalSpaceId: () => SPACE });
  assert.equal((await port().confirm(CONFIRM)).outcome, 'complete');
  // The record is lost (an older backup without this delete, or moved aside).
  rmSync(join(dataDir, HARD_DELETE_LEDGER_FILE));
  assert.equal(fenced(dataDir), false, 'without its record the fence is gone');
  rememberWords(dataDir);
  assert.deepEqual(storesHold(dataDir), ['judgment.sqlite'], 'so words could be stored again');
  // The next start takes the graph's deletion in again and cleans up.
  const [adopted] = await port().reconcile();
  assert.equal(adopted.outcome, 'complete');
  assert.equal(fenced(dataDir), true);
  assert.deepEqual(storesHold(dataDir), []);
  assert.deepEqual(await port().reconcile(), [], 'once known, it is not taken in twice');
});

test('restored-ledger recovery blocks local knowledge reads and writes while graph tombstones are pending', async (t) => {
  const dataDir = dataDirectory(t);
  rememberWords(dataDir);
  const store = new JudgmentStore(join(dataDir, 'judgment.sqlite'));
  t.after(() => store.close());
  const graph = syntheticGraph();
  graph.deleted = true;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const port = knowledgeHardDelete(dataDir, { personalSpaceId: () => SPACE,
    send: async (...args) => { await barrier; return graph.send(...args); } });
  const recovery = port.reconcile();
  try {
    assert.throws(() => store.records(SPACE), /recover|reconcil/i);
    assert.throws(() => store.record(SPACE, { kind: 'review', target: 'entity:item-2', title: PASTED },
      'restored-late-write'), /recover|reconcil/i);
  } finally {
    release();
    await recovery;
    store.close();
  }
  assert.deepEqual(storesHold(dataDir), []);
});
