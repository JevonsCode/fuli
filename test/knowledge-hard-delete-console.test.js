import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { handleKnowledgeHardDeleteRequest } from '../src/http/knowledge-hard-delete-api-router.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { knowledgeHardDelete } from '../src/knowledge-hard-delete/console-port.js';
import { hardDeleteLedger, readHardDeleteProof } from '../src/knowledge-hard-delete/delete-ledger.js';
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';
import { RoleSuggestionLog } from '../src/model-backends/suggestion-log.js';
import { PREVIEW_ID, syntheticGraph } from '../test-support/hard-delete-graph.js';
import { reachableModules } from '../test-support/module-graph.js';

// rec#5 C9 through the local console: only a person on this computer can
// preview and permanently delete, the provider call takes the human-review
// channel, and the local stores that keep words about knowledge forget it.
// Synthetic Provider and synthetic records only.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPACE = 'personal-space';
// Cleanup tests isolate the recovery gate; gate integration has separate coverage.
const recoveryGate = { state: () => ({ state: 'open' }) };
const PASTED = 'SYNTHETIC-PASTED-KEY-0000-not-a-real-secret';
const APP = { config: { personal: { spaceId: SPACE } } };

function body(value) {
  return Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]);
}

async function route(path, value, { remoteAddress = '127.0.0.1', hardDelete, app = APP, method = 'POST' } = {}) {
  const request = Object.assign(body(value), { method, headers: { 'content-type': 'application/json' },
    socket: { remoteAddress } });
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; return this; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  try {
    const handled = await handleKnowledgeHardDeleteRequest({ request, response, url: new URL(`http://127.0.0.1${path}`),
      app, hardDelete });
    return { handled, ...sent };
  } catch (error) {
    return { handled: true, ...mapHttpError(error) };
  }
}

function dataDirectory(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-hard-delete-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function recordingPort(t, graph = syntheticGraph()) {
  return { port: knowledgeHardDelete(dataDirectory(t), { localStores: [], send: graph.send }), calls: graph.calls, graph };
}

test('no MCP or Agent tool module reaches a hard delete, and no tool is named for one', () => {
  const deleting = ['src/knowledge-hard-delete/console-port.js', 'src/http/knowledge-hard-delete-api-router.js',
    'src/graphiti/human-review-channel.js'].map((path) => join(ROOT, path));
  for (const entry of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    const modules = reachableModules(join(ROOT, entry));
    assert.deepEqual(deleting.filter((path) => modules.has(path)), [], entry);
    assert.ok(modules.has(join(ROOT, 'src/knowledge-hard-delete/recovery-gate.js')), entry);
  }
  assert.deepEqual(listAgentTools().map((tool) => tool.name).filter((name) => /hard|purge|erase|permanent|recover|reconcile|tombstone|watermark/.test(name)), []);
  // The interface catalog tells an Agent these are the person's, not missing tools.
  const entries = agentInterfaceCatalog().uiMutationParity.filter((item) => item.route.includes('/hard-delete'));
  assert.deepEqual(entries.map((item) => [item.route, item.access]), [
    ['POST /api/knowledge/:itemKind/:itemId/hard-delete/preview', 'local_user_only'],
    ['POST /api/knowledge/:itemKind/:itemId/hard-delete/status', 'local_user_only'],
    ['POST /api/knowledge/:itemKind/:itemId/hard-delete', 'local_user_only']]);
});

test('an Agent revising knowledge cannot reach a hard delete through revise_personal_knowledge', async () => {
  const calls = [];
  const app = new FederatedGraphApplication({ version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'synthetic-token', principalId: 'synthetic-owner', spaceId: SPACE } }, { fetchImpl: async (url, options) => {
    calls.push({ path: new URL(url).pathname, headers: options.headers });
    return new Response(JSON.stringify({ detail: 'refused' }), { status: 422, headers: { 'content-type': 'application/json' } });
  } });
  for (const action of ['hard_delete', 'delete', 'purge']) {
    await assert.rejects(callAgentTool(app, 'revise_personal_knowledge', { personalSpaceId: SPACE, itemKind: 'entity',
      itemId: 'item-2', action, reason: 'Synthetic: an Agent asks to erase it', expectedVersion: 1 }));
  }
  assert.deepEqual(calls.filter((call) => call.path.includes('hard-delete')), []);
  assert.equal(calls.some((call) => call.headers?.['x-fuli-human-review-token']), false);
});

test('preview and delete are accepted only on this computer and in the active personal space', async (t) => {
  const { port, calls } = recordingPort(t);
  const lan = await route('/api/knowledge/entity/item-2/hard-delete', { personalSpaceId: SPACE, previewId: PREVIEW_ID,
    confirmation: '删除' }, { remoteAddress: '192.168.1.20', hardDelete: port });
  assert.equal(lan.status, 403);
  assert.equal(lan.body.code, 'local_user_only');
  const other = await route('/api/knowledge/entity/item-2/hard-delete/preview', { personalSpaceId: 'someone-else' },
    { hardDelete: port });
  assert.equal(other.status, 400);
  for (const invalid of [{ personalSpaceId: SPACE, previewId: 'short', confirmation: '删除' },
    { personalSpaceId: SPACE, previewId: PREVIEW_ID, confirmation: ' ' },
    { personalSpaceId: SPACE, previewId: PREVIEW_ID, confirmation: '删除', operationActor: 'agent' }]) {
    assert.equal((await route('/api/knowledge/entity/item-2/hard-delete', invalid, { hardDelete: port })).status, 400);
  }
  assert.equal((await route('/api/knowledge/entity/item-2/hard-delete', undefined, { hardDelete: port, method: 'GET' })).status, 405);
  assert.equal((await route('/api/knowledge/entity/item-2/hard-delete/preview', { personalSpaceId: SPACE })).status, 503);
  assert.deepEqual(calls, []);
});

test('the console sends the preview it showed and the person\'s words through the human-review channel', async (t) => {
  const { port, calls } = recordingPort(t);
  const preview = await route('/api/knowledge/relationship/fact%2F1/hard-delete/preview', { personalSpaceId: SPACE },
    { hardDelete: port });
  assert.equal(preview.status, 200);
  const done = await route('/api/knowledge/entity/item-2/hard-delete', { personalSpaceId: SPACE, previewId: PREVIEW_ID,
    confirmation: ' 删除 ' }, { hardDelete: port });
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.outcome, done.body.local_stores], ['complete', []]);
  // The confirm reads the preview again before it sends the delete it names.
  assert.deepEqual(calls.map(({ path, payload, review }) => [path, payload, review]), [
    ['/v1/knowledge/items/fact%2F1/hard-delete/preview', { personal_space_id: SPACE, item_kind: 'relationship' }, true],
    ['/v1/knowledge/items/item-2/hard-delete/preview', { personal_space_id: SPACE, item_kind: 'entity' }, true],
    ['/v1/knowledge/items/item-2/hard-delete', { personal_space_id: SPACE, item_kind: 'entity',
      preview_id: PREVIEW_ID, confirmation: '删除', operation_id: calls[2].payload.operation_id }, true]]);
  // The delete is named by the console's recorded operation, so its outcome can be asked for.
  assert.match(calls[2].payload.operation_id, /^[0-9a-f-]{36}$/);
});

test('a stale preview is a 409 the page can read again, and a deleted item a 410 with its time', async (t) => {
  // The graph's digest moved since the page read it: nothing is sent.
  const moved = recordingPort(t, syntheticGraph({ previewId: 'b'.repeat(64) }));
  const conflict = await route('/api/knowledge/entity/item-2/hard-delete', { personalSpaceId: SPACE,
    previewId: PREVIEW_ID, confirmation: '删除' }, { hardDelete: moved.port });
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'hard_delete_preview_stale']);
  assert.equal(moved.calls.some((call) => call.path.endsWith('/hard-delete')), false);
  const gone = recordingPort(t);
  gone.graph.deleted = true;
  const again = await route('/api/knowledge/entity/item-2/hard-delete/preview', { personalSpaceId: SPACE },
    { hardDelete: gone.port });
  assert.deepEqual([again.status, again.body.code, again.body.deletedAt], [410, 'hard_deleted', '2026-10-22T01:02:03Z']);
});

test('an old link to a deleted item answers 已彻底删除 (410) with when, never 404', async () => {
  const app = new FederatedGraphApplication({ version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'synthetic-token', principalId: 'synthetic-owner', spaceId: SPACE } }, { fetchImpl: async () =>
    new Response(JSON.stringify({ detail: { code: 'hard_deleted', message: 'this knowledge was permanently deleted by its owner',
      deleted_at: '2026-10-22T01:02:03.123456+00:00' } }), { status: 410, headers: { 'content-type': 'application/json' } }) });
  const request = Object.assign(body(), { method: 'GET', headers: {} });
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; }, end(text) { sent.body = JSON.parse(text); } };
  let result;
  try {
    await handleGraphApiRequest({ request, response, app,
      url: new URL(`http://127.0.0.1/api/knowledge/entity/item-1?personalSpaceId=${SPACE}`) });
    result = sent;
  } catch (error) {
    result = mapHttpError(error);
  }
  assert.equal(result.status, 410);
  assert.deepEqual([result.body.code, result.body.deletedAt], ['hard_deleted', '2026-10-22T01:02:03.123456+00:00']);
});

test('after the graph committed, Tonborg judgments and handed-off work forget the deleted items\' words', async (t) => {
  const dataDir = dataDirectory(t);
  // Long words spill into overflow pages, which an update frees; one store
  // writes through a write-ahead log, as a store another process set to WAL would.
  const long = `Deploy with ${PASTED} ${'synthetic filler '.repeat(400)}${PASTED}`;
  const judgment = new JudgmentStore(join(dataDir, 'judgment.sqlite'), { recoveryGate });
  judgment.close();
  const wal = new DatabaseSync(join(dataDir, 'judgment.sqlite'));
  wal.exec('PRAGMA journal_mode = WAL');
  wal.close();
  const judgmentAgain = new JudgmentStore(join(dataDir, 'judgment.sqlite'), { recoveryGate });
  const review = judgmentAgain.record(SPACE, { kind: 'review', target: 'entity:item-1', title: long,
    summary: `Approve ${PASTED}`, evidence: [`said ${PASTED}`], outcome: 'escalate', confidence: 0.4 }, 'review:item-1');
  judgmentAgain.execute(SPACE, review.id, 'applying', { reviewId: 'run-1', candidateKey: 'entity:item-1' });
  judgmentAgain.feedback(SPACE, review.id, 'down', `Do not keep ${PASTED}`, 0);
  const kept = judgmentAgain.record(SPACE, { kind: 'review', target: 'entity:other', title: 'Synthetic staging target',
    summary: 'Keep it', evidence: [], outcome: 'approve', confidence: 0.9 }, 'review:other');
  judgmentAgain.close();
  // Another process (the running console) keeps the store open, so its log stays.
  const holder = new DatabaseSync(join(dataDir, 'judgment.sqlite'));
  holder.prepare('SELECT count(*) AS n FROM judgment_records').get();
  const work = new RoleWorkStore(join(dataDir, 'role-work.sqlite'), { recoveryGate });
  const at = new Date('2026-10-22T00:00:00Z');
  const pkg = work.create({ request: { role: 'tonborg', operation: 'review', requestId: 'review-run-1',
    scope: { personalSpaceId: SPACE, personalProjectId: null, sessionRef: null }, versions: { evidence: 'e', policy: 'p' },
    instructions: 'Review these candidates.', evidence: [{ key: 'candidates', value: [
      { candidate_key: 'entity:item-1', item_id: 'item-1', title: long },
      { candidate_key: 'entity:other', item_id: 'other', title: 'Synthetic staging target' }] }] },
  reason: 'no_model', at, ttlMs: 60_000 });
  work.close();
  // A suggestion record as Jefa writes it today: identities, an evidence version and model text, no knowledge item ID.
  const suggestions = new RoleSuggestionLog(join(dataDir, 'role-suggestions.sqlite'), { now: () => at, recoveryGate });
  suggestions.record({ role: 'jefa', operation: 'board_match', personalSpaceId: SPACE, personalProjectId: 'garden',
    subject: { conversationId: 'conversation-synthetic-1' }, result: { status: 'suggested', hint: '可能是看板上的「Seed inventory」任务',
      suggestion: { taskId: 'task-seeds', title: 'Seed inventory', updatedAt: null, reason: `Quoted ${PASTED}`, uncertainty: null },
      confirmWith: 'call_employee_tool', suggestedBy: { mode: 'model_api', independent: true, model: 'qwen-test' },
      requestId: 'board_match:r1', evidenceVersion: 'e'.repeat(64), promptVersion: 'board_match:p1',
      gate: { status: 'suggestion_only', role: 'jefa', operation: 'board_match' } } });
  suggestions.close();

  const port = knowledgeHardDelete(dataDir, { send: syntheticGraph({ itemIds: ['item-2', 'item-1'] }).send });
  const done = await port.confirm({ personalSpaceId: SPACE, itemKind: 'entity', itemId: 'item-2', previewId: PREVIEW_ID,
    confirmation: '删除' });
  assert.deepEqual(done.local_stores.map(({ store, status }) => [store, status]),
    [['judgment.sqlite', 'forgotten'], ['role-work.sqlite', 'forgotten'], ['role-suggestions.sqlite', 'forgotten']]);
  assert.ok(done.local_stores.every((store) => store.changed > 0));
  // Its rows name no knowledge item, so every record of the space written up to the delete lost its words (D-30.9).
  const suggestionsAgain = new RoleSuggestionLog(join(dataDir, 'role-suggestions.sqlite'), { now: () => at, recoveryGate });
  const [record] = suggestionsAgain.list({ limit: 300, personalSpaceId: SPACE });
  assert.deepEqual([record.status, record.hint, record.suggestion, record.hard_deleted, record.subject],
    ['suggested', undefined, { taskId: 'task-seeds', updatedAt: null }, true, { conversationId: 'conversation-synthetic-1' }]);
  suggestionsAgain.close();

  const reopened = new JudgmentStore(join(dataDir, 'judgment.sqlite'), { recoveryGate });
  const forgotten = reopened.get(SPACE, review.id);
  assert.deepEqual([forgotten.title, forgotten.summary, forgotten.evidence, forgotten.hard_deleted, forgotten.outcome],
    [null, null, [], true, 'escalate']);
  assert.equal(forgotten.feedback.reason, '');
  assert.equal(reopened.get(SPACE, kept.id).title, 'Synthetic staging target');
  reopened.close();
  const reread = new RoleWorkStore(join(dataDir, 'role-work.sqlite'), { recoveryGate });
  const [gone, stays] = reread.get(pkg.packageId).request.evidence[0].value;
  assert.deepEqual([gone.title, gone.hard_deleted, stays.title], [null, true, 'Synthetic staging target']);
  reread.close();
  // Not in the file (its free pages included), not in a write-ahead log or journal.
  for (const file of ['judgment.sqlite', 'role-work.sqlite', 'role-suggestions.sqlite'].flatMap((name) => [name, `${name}-wal`, `${name}-journal`])) {
    const path = join(dataDir, file);
    if (existsSync(path)) assert.equal(readFileSync(path).includes(Buffer.from(PASTED)), false, file);
  }
  assert.equal(statSync(join(dataDir, 'judgment.sqlite-wal')).size, 0, 'the checkpoint emptied the log');
  assert.equal(holder.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  holder.close();
  // A store this FULI cannot open is reported, not hidden; the graph delete stands.
  const failing = knowledgeHardDelete(dataDirectory(t), { send: syntheticGraph().send,
    localStores: [{ name: 'judgment.sqlite', forget: () => { throw new Error('synthetic newer format'); } }] });
  const reported = await failing.confirm({ personalSpaceId: SPACE, itemKind: 'entity', itemId: 'item-2',
    previewId: PREVIEW_ID, confirmation: '删除' });
  assert.equal(reported.outcome, 'local_pending');
  assert.deepEqual(reported.local_stores, [{ store: 'judgment.sqlite', status: 'failed', reason: 'synthetic newer format' }]);
});

test('checking an old delete again never clears a suggestion record written after it', async (t) => {
  const dataDir = dataDirectory(t);
  const path = join(dataDir, 'role-suggestions.sqlite');
  const suggestion = (n) => ({ role: 'jefa', operation: 'board_match', personalSpaceId: SPACE, personalProjectId: 'garden',
    subject: { conversationId: `conversation-${n}` }, result: { status: 'suggested', hint: `hint ${n}`,
      suggestion: { taskId: `task-${n}`, title: `Task ${n}`, reason: `Reason ${n}`, uncertainty: null },
      gate: { status: 'suggestion_only', role: 'jefa', operation: 'board_match' } } });
  const write = (when, n) => {
    const log = new RoleSuggestionLog(path, { now: () => new Date(when), recoveryGate });
    try { log.record(suggestion(n)); } finally { log.close(); }
  };
  // T0, before the delete (the synthetic graph deletes at 2026-10-22T01:02:03Z).
  write('2026-10-22T00:00:00.000Z', 0);
  const port = knowledgeHardDelete(dataDir, { send: syntheticGraph({ itemIds: ['item-2'] }).send });
  // T1: the delete completes and clears the earlier record.
  const done = await port.confirm({ personalSpaceId: SPACE, itemKind: 'entity', itemId: 'item-2', previewId: PREVIEW_ID,
    confirmation: '删除' });
  assert.equal(done.outcome, 'complete');
  // T2: a legitimate new suggestion after the delete.
  write('2026-10-22T02:00:00.000Z', 1);
  // T3: an old link's status check of the same delete runs its cleanup again, bound to the same time.
  const again = await port.status({ personalSpaceId: SPACE, itemKind: 'entity', itemId: 'item-2' });
  assert.equal(again.outcome, 'complete');
  assert.equal(again.local_stores.find((store) => store.store === 'role-suggestions.sqlite').changed, 0);
  const log = new RoleSuggestionLog(path, { now: () => new Date('2026-10-22T03:00:00.000Z'), recoveryGate });
  try {
    const [after, before] = log.list({ personalSpaceId: SPACE });
    assert.deepEqual([after.suggestion.reason, after.hard_deleted], ['Reason 1', undefined]);
    assert.deepEqual([before.suggestion.reason, before.hard_deleted], [undefined, true]);
  } finally { log.close(); }
});

test('every cleanup run of one delete, first, retried, recovered or re-checked, uses the delete\'s recorded time', async (t) => {
  const dataDir = dataDirectory(t);
  const cutoffs = [];
  let failNext = true;
  const localStores = [{ name: 'role-suggestions.sqlite', forget: (space, references, { deletedAt }) => {
    cutoffs.push(deletedAt);
    if (failNext) { failNext = false; throw new Error('synthetic busy store'); }
    return 0;
  } }];
  const graph = syntheticGraph({ itemIds: ['item-2'], deletedAt: '2026-10-22T01:02:03Z' });
  const port = knowledgeHardDelete(dataDir, { send: graph.send, localStores, now: () => new Date('2026-10-23T05:00:00Z') });
  const input = { personalSpaceId: SPACE, itemKind: 'entity', itemId: 'item-2' };
  // The first cleanup fails, so the delete stays open for a retry and for recovery.
  assert.equal((await port.confirm({ ...input, previewId: PREVIEW_ID, confirmation: '删除' })).outcome, 'local_pending');
  failNext = true;
  assert.equal((await port.reconcile())[0].outcome, 'local_pending');
  assert.equal((await port.status(input)).outcome, 'complete');
  assert.equal((await port.status(input)).outcome, 'complete');
  assert.deepEqual(cutoffs, Array(4).fill('2026-10-22T01:02:03Z'));
});

test('a data directory without suggestion records is not given one by a permanent delete', async (t) => {
  const dataDir = dataDirectory(t);
  const done = await knowledgeHardDelete(dataDir, { send: syntheticGraph({ itemIds: ['item-2'] }).send })
    .confirm({ personalSpaceId: SPACE, itemKind: 'entity', itemId: 'item-2', previewId: PREVIEW_ID, confirmation: '删除' });
  assert.deepEqual(done.local_stores.find((store) => store.store === 'role-suggestions.sqlite'),
    { store: 'role-suggestions.sqlite', status: 'forgotten', changed: 0 });
  assert.equal(existsSync(join(dataDir, 'role-suggestions.sqlite')), false);
});

test('a receipt read in several batches counts each permanent delete once', async () => {
  const reads = [];
  const app = new FederatedGraphApplication({ version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'synthetic-token', principalId: 'synthetic-owner', spaceId: SPACE } }, { fetchImpl: async (_url, options) => {
    reads.push(JSON.parse(options.body).episode_ids);
    return new Response(JSON.stringify({ entries: [], unchanged_count: 0, deleted_count: 1, deletion_ids: ['deletion-1'] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; }, end(text) { sent.body = JSON.parse(text); } };
  await handleGraphApiRequest({ request: Object.assign(body(), { method: 'GET', headers: {} }), response, app,
    url: new URL(`http://127.0.0.1/api/knowledge/turn-receipt?personalSpaceId=${SPACE}&episodes=e1,e2,e3,e4,e5`) });
  assert.equal(reads.length, 2);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.deleted_count, 1);
});

for (const itemKind of ['episode', 'session']) test(`${itemKind} routes preserve selection and source identity through deletion and ledger adoption`, async t => {
  const dataDir = dataDirectory(t);
  const itemId = `synthetic-${itemKind}`;
  const source = { source_application: 'codex', fuli_session_id: 'native-session' };
  const selection = { include: ['entity:included'], exclude: ['entity:retained'] };
  const input = { personalSpaceId: SPACE, ...selection,
    ...(itemKind === 'session' ? { sourceApplication: 'codex', sessionId: 'native-session' } : {}) };
  const plan = { preview_id: PREVIEW_ID, item_kind: itemKind, item_id: itemId, ...source,
    default_items: [{ selected: false, versions: [{ item_id: 'retained' }] }],
    affected_items: [{ selected: true, versions: [{ item_id: 'included' }, { item_id: 'old-version' }] }],
    removed_episodes: [{ episode_id: 'source-episode' }] };
  const deletion = { deletion_id: 'source-deletion', item_kind: itemKind, item_id: itemId, ...source,
    deleted_at: '2026-10-22T01:02:03Z', deleted_item_ids: [itemId, 'included', 'old-version', 'source-episode'], counts: {} };
  const calls = []; let reconciliations = 0;
  const send = async (path, request, options) => {
    calls.push({ path, request, options });
    return { ok: true, status: 200, payload: path.endsWith('/preview') ? plan
      : path.endsWith('/status') ? { state: 'deleted', deletion }
        : path === '/v1/knowledge/hard-deletions' ? [deletion] : deletion };
  };
  const localStores = [{ name: 'fixture', forget: (_space, references) => {
    for (const id of deletion.deleted_item_ids) assert.equal(references.names(id), true);
    assert.equal(references.names('retained'), false);
    return 1;
  } }];
  const port = knowledgeHardDelete(dataDir, { send, localStores, personalSpaceId: () => SPACE,
    reconcileSubmissions: async () => { reconciliations++; } });
  const base = `/api/knowledge/${itemKind}/${itemId}/hard-delete`;
  assert.equal((await route(`${base}/preview`, input, { hardDelete: port })).status, 200);
  const result = await route(base, { ...input, previewId: PREVIEW_ID, confirmation: '删除' }, { hardDelete: port });
  assert.equal(result.body.outcome, 'complete');
  assert.equal(reconciliations, 2);
  const confirm = calls.find(call => call.path.endsWith('/hard-delete'));
  assert.deepEqual([confirm.request.include, confirm.request.exclude], [selection.include, selection.exclude]);
  assert.equal(confirm.request.item_kind, itemKind);
  assert.equal(confirm.options.review, true);
  const [operation] = hardDeleteLedger(dataDir).all();
  assert.deepEqual([operation.sourceApplication, operation.sessionId], ['codex', 'native-session']);
  assert.deepEqual(new Set(operation.itemIds), new Set(deletion.deleted_item_ids));
  assert.equal((await route(`${base}/status`, { personalSpaceId: SPACE }, { hardDelete: port })).body.outcome, 'complete');
  assert.deepEqual(calls.findLast(call => call.path.endsWith('/status')).request, { personal_space_id: SPACE, item_kind: itemKind });
  assert.equal((await route(base, { ...input, previewId: PREVIEW_ID, confirmation: '删除', operationId: 'forged' }, { hardDelete: port })).status, 400);
  assert.equal((await route(`${base}/preview`, input, { hardDelete: port, remoteAddress: '192.0.2.1' })).status, 403);

  const restored = dataDirectory(t);
  await knowledgeHardDelete(restored, { send, localStores, personalSpaceId: () => SPACE }).reconcile();
  const [adopted] = hardDeleteLedger(restored).all();
  assert.deepEqual([adopted.sourceApplication, adopted.sessionId, adopted.state], ['codex', 'native-session', 'complete']);
  assert.equal(readHardDeleteProof(restored).watermarks[SPACE].count, 1);
});

test('a failed deletion-list read cannot create a recovery watermark', async t => {
  const dataDir = dataDirectory(t);
  const port = knowledgeHardDelete(dataDir, { personalSpaceId: () => SPACE, send: async () => { throw new Error('synthetic offline'); } });
  await assert.rejects(port.reconcile(), /synthetic offline/);
  assert.equal(readHardDeleteProof(dataDir), null);
});

test('a source deleted by another console settles its 410 through the recorded status and cleans local copies', async t => {
  const dataDir = dataDirectory(t);
  let cleaned = 0, statuses = 0;
  const deletion = { deletion_id: 'foreign-delete', item_kind: 'episode', item_id: 'source',
    deleted_at: '2026-10-23T00:00:00Z', deleted_item_ids: ['source'], counts: {} };
  const port = knowledgeHardDelete(dataDir, { localStores: [{ name: 'fixture', forget: () => ++cleaned }],
    send: async path => {
      if (path.endsWith('/preview')) return { ok: true, status: 200, payload: {
        preview_id: PREVIEW_ID, item_kind: 'episode', item_id: 'source', default_items: [], affected_items: [], removed_episodes: [] } };
      if (path.includes('/hard-delete-operations/')) return { ok: true, status: 200,
        payload: { state: 'refused', code: 'source_hard_deleted' } };
      if (path.endsWith('/status')) { statuses++; return { ok: true, status: 200, payload: { state: 'deleted', deletion } }; }
      return { ok: false, status: 410, payload: { detail: { code: 'source_hard_deleted' } } };
    } });
  const result = await port.confirm({ personalSpaceId: SPACE, itemKind: 'episode', itemId: 'source',
    previewId: PREVIEW_ID, confirmation: '删除' });
  assert.equal(result.outcome, 'complete');
  assert.equal(statuses, 1);
  assert.equal(cleaned, 1);
  assert.equal(hardDeleteLedger(dataDir).all()[0].state, 'complete');
});
