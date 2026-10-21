import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createJudgmentEngine } from '../src/judgment/engine.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { knowledgeHardDelete } from '../src/knowledge-hard-delete/console-port.js';
import { deletedKnowledgeBeside, hardDeleteLedger } from '../src/knowledge-hard-delete/delete-ledger.js';
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';
import { PREVIEW_ID, syntheticGraph } from '../test-support/hard-delete-graph.js';
import { completePreferences } from './fixtures/collaboration-preferences.js';

// rec#5 C9, dot's review of #273: a delete whose answer is lost or whose
// console crashes is settled from its recorded operation and cleaned up to
// the end, and work that started before a delete never writes the deleted
// words back into a local store. Synthetic graph, synthetic records.

const SPACE = 'personal-space';
const PASTED = 'SYNTHETIC-PASTED-KEY-0000-not-a-real-secret';
const CONFIRM = { personalSpaceId: SPACE, itemKind: 'entity', itemId: 'item-2', previewId: PREVIEW_ID, confirmation: '删除' };

function dataDirectory(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-hard-delete-recovery-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

// A Tonborg judgment that kept the words of item-2, as a store holds it.
function rememberWords(dataDir) {
  const store = new JudgmentStore(join(dataDir, 'judgment.sqlite'));
  store.record(SPACE, { kind: 'review', target: 'entity:item-2', title: `Deploy with ${PASTED}`,
    summary: `Approve ${PASTED}`, evidence: [], outcome: 'escalate', confidence: 0.4 }, 'review:item-2');
  store.close();
}

function storesHold(dataDir, words = PASTED) {
  return ['judgment.sqlite', 'role-work.sqlite'].flatMap((name) => [name, `${name}-wal`, `${name}-journal`])
    .filter((file) => existsSync(join(dataDir, file)) && readFileSync(join(dataDir, file)).includes(Buffer.from(words)));
}

const ledgerState = (dataDir) => hardDeleteLedger(dataDir).find(SPACE, 'item-2')?.state;

test('an answer lost after the graph committed is settled by asking, then cleaned up to the end', async (t) => {
  const dataDir = dataDirectory(t);
  rememberWords(dataDir);
  const graph = syntheticGraph();
  graph.answerDelete = 'lost';
  const result = await knowledgeHardDelete(dataDir, { send: graph.send }).confirm(CONFIRM);
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(result.deleted_item_ids, ['item-2', 'item-1', 'fact-1']);
  // The delete was sent once; the outcome came from the status read.
  assert.equal(graph.calls.filter((call) => call.path.endsWith('/hard-delete')).length, 1);
  assert.equal(graph.calls.at(-1).path, '/v1/knowledge/items/item-2/hard-delete/status');
  assert.equal(ledgerState(dataDir), 'complete');
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
  // A retried confirm whose delete answers 410 settles the same way.
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

test('only a refusal the graph answered says nothing was deleted; an unreachable graph stays unknown', async (t) => {
  const dataDir = dataDirectory(t);
  rememberWords(dataDir);
  const refused = syntheticGraph();
  refused.answerDelete = 'refused';
  await assert.rejects(knowledgeHardDelete(dataDir, { send: refused.send }).confirm(CONFIRM),
    (error) => error.status === 422 && error.code === 'hard_delete_unconfirmed');
  assert.equal(ledgerState(dataDir), 'not_deleted');
  // A refused delete leaves the fence: the item's words may be stored again.
  assert.equal(deletedKnowledgeBeside(join(dataDir, 'judgment.sqlite'))().names('entity:item-2'), false);

  const unknown = dataDirectory(t);
  const down = syntheticGraph();
  down.answerDelete = 'down';
  down.statusDown = true;
  let clock = new Date('2026-10-22T01:00:00Z');
  const port = () => knowledgeHardDelete(unknown, { send: down.send, now: () => clock });
  assert.equal((await port().confirm(CONFIRM)).outcome, 'unknown');
  down.statusDown = false;
  // Still there right after: not yet proof, it stays unknown.
  assert.equal((await port().status(CONFIRM)).outcome, 'unknown');
  // Still there long after any delete could have committed: proven not deleted.
  clock = new Date('2026-10-22T02:00:00Z');
  assert.equal((await port().status(CONFIRM)).outcome, 'not_deleted');
  assert.equal(hardDeleteLedger(unknown).find(SPACE, 'item-2').state, 'not_deleted');
});

test('a Tonborg review that was answering when the person deleted never records the deleted words', async (t) => {
  const dataDir = dataDirectory(t);
  const candidates = [{ candidate_key: 'entity:item-2', title: `Deploy with ${PASTED}`, content: PASTED,
    confirmation_status: 'confirmed', changed_at: '2026-01-01', reasons: [], project_ids: ['p'] }];
  const app = { config: { personal: { spaceId: SPACE } },
    listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'],
      capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => completePreferences(),
    inspectProjectAgentMemory: async () => ({ current: null, revision: 0 }),
    employees: { authorize: async () => ({}) }, personal: {},
    startKnowledgeReview: async () => ({ review_id: 'review' }), finishKnowledgeReview: async () => ({}),
    listKnowledgeReviewCandidates: async () => ({ candidates, total_candidate_count: candidates.length }),
    recordKnowledgeReviewProgress: async () => ({ outcome: 'ai_reviewed' }), listExecutors: async () => [] };
  // Barrier: the person deletes the item, and the cleanup finishes, while the model answers.
  const judge = async () => {
    const deleted = await knowledgeHardDelete(dataDir, { send: syntheticGraph().send }).confirm(CONFIRM);
    assert.equal(deleted.outcome, 'complete');
    return { body: JSON.stringify({ decisions: [{ target: 'entity:item-2', outcome: 'approve',
      summary: `Keep ${PASTED}`, evidence: [`said ${PASTED}`], confidence: 0.95 }] }), client: 'codex', model: null,
    sessionId: 'synthetic-session' };
  };
  const service = createJudgmentService({ app, engine: createJudgmentEngine({ app, judge }),
    openStore: () => new JudgmentStore(join(dataDir, 'judgment.sqlite')) });
  t.after(() => service.close());
  service.store().setPolicy(SPACE, '', { mode: 'shared', quality: 'quality', client: 'codex' }, 0);
  const result = await service.review({ personalSpaceId: SPACE, personalProjectId: 'p', requestId: 'barrier-1', limit: 10 });
  assert.equal(result.records.some((record) => record.target === 'entity:item-2'), false);
  service.close();
  assert.deepEqual(storesHold(dataDir), []);
});

test('a late answer or result of handed-off work keeps no deleted words', async (t) => {
  const dataDir = dataDirectory(t);
  const path = join(dataDir, 'role-work.sqlite');
  const at = new Date('2026-10-22T00:00:00Z');
  // A long-running process holds the store from before the delete.
  const running = new RoleWorkStore(path);
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
