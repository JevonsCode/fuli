import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';

// rec#5 C9 through the local console: only a person on this computer can
// preview and permanently delete, the provider call takes the human-review
// channel, and the local stores that keep words about knowledge forget it.
// Synthetic Provider and synthetic records only.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPACE = 'personal-space';
const PASTED = 'SYNTHETIC-PASTED-KEY-0000-not-a-real-secret';
const PREVIEW_ID = 'a'.repeat(64);
const APP = { config: { personal: { spaceId: SPACE } } };
const DELETED = { deletion_id: 'deletion-1', item_kind: 'entity', item_id: 'item-2', deleted_at: '2026-10-22T01:02:03Z',
  deleted_by: 'user', counts: { items: 3 }, deleted_item_ids: ['item-2', 'item-1', 'fact-1'] };

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

function recordingPort(answer = () => ({ ok: true, status: 200, payload: DELETED })) {
  const calls = [];
  const port = knowledgeHardDelete('unused', { localStores: [], send: async (path, payload, options) => {
    calls.push({ path, payload, options });
    return answer(path, payload);
  } });
  return { port, calls };
}

// Every module a module imports, by static or dynamic import, within this repository.
function reachable(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
      visit(join(dirname(file), specifier));
    }
    for (const [, specifier] of source.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      visit(join(dirname(file), specifier));
    }
  };
  visit(entry);
  return seen;
}

test('no MCP or Agent tool module reaches a hard delete, and no tool is named for one', () => {
  const deleting = ['src/knowledge-hard-delete/console-port.js', 'src/http/knowledge-hard-delete-api-router.js',
    'src/graphiti/human-review-channel.js'].map((path) => join(ROOT, path));
  for (const entry of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    const modules = reachable(join(ROOT, entry));
    assert.deepEqual(deleting.filter((path) => modules.has(path)), [], entry);
  }
  assert.deepEqual(listAgentTools().map((tool) => tool.name).filter((name) => /hard|purge|erase|permanent/.test(name)), []);
  // The interface catalog tells an Agent these are the person's, not missing tools.
  const entries = agentInterfaceCatalog().uiMutationParity.filter((item) => item.route.includes('/hard-delete'));
  assert.deepEqual(entries.map((item) => [item.route, item.access]), [
    ['POST /api/knowledge/:itemKind/:itemId/hard-delete/preview', 'local_user_only'],
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

test('preview and delete are accepted only on this computer and in the active personal space', async () => {
  const { port, calls } = recordingPort();
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

test('the console sends the preview it showed and the person\'s words through the human-review channel', async () => {
  const { port, calls } = recordingPort((path) => ({ ok: true, status: 200,
    payload: path.endsWith('/preview') ? { preview_id: PREVIEW_ID, items: [] } : DELETED }));
  const preview = await route('/api/knowledge/relationship/fact%2F1/hard-delete/preview', { personalSpaceId: SPACE },
    { hardDelete: port });
  assert.equal(preview.status, 200);
  const done = await route('/api/knowledge/entity/item-2/hard-delete', { personalSpaceId: SPACE, previewId: PREVIEW_ID,
    confirmation: ' 删除 ' }, { hardDelete: port });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.local_stores, []);
  assert.deepEqual(calls.map(({ path, payload, options }) => [path, payload, options.review]), [
    ['/v1/knowledge/items/fact%2F1/hard-delete/preview', { personal_space_id: SPACE, item_kind: 'relationship' }, true],
    ['/v1/knowledge/items/item-2/hard-delete', { personal_space_id: SPACE, item_kind: 'entity',
      preview_id: PREVIEW_ID, confirmation: '删除' }, true]]);
});

test('a stale preview is a 409 the page can read again, and a deleted item a 410 with its time', async () => {
  const stale = recordingPort(() => ({ ok: false, status: 409, payload: { detail: {
    code: 'hard_delete_preview_stale', message: 'what this delete removes changed since the preview' } } }));
  const conflict = await route('/api/knowledge/entity/item-2/hard-delete', { personalSpaceId: SPACE,
    previewId: PREVIEW_ID, confirmation: '删除' }, { hardDelete: stale.port });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'hard_delete_preview_stale');
  const gone = recordingPort(() => ({ ok: false, status: 410, payload: { detail: {
    code: 'hard_deleted', message: 'deleted', deleted_at: '2026-10-22T01:02:03Z' } } }));
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
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-hard-delete-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const judgment = new JudgmentStore(join(dataDir, 'judgment.sqlite'));
  const review = judgment.record(SPACE, { kind: 'review', target: 'entity:item-1', title: `Deploy with ${PASTED}`,
    summary: `Approve ${PASTED}`, evidence: [`said ${PASTED}`], outcome: 'escalate', confidence: 0.4 }, 'review:item-1');
  judgment.execute(SPACE, review.id, 'applying', { reviewId: 'run-1', candidateKey: 'entity:item-1' });
  judgment.feedback(SPACE, review.id, 'down', `Do not keep ${PASTED}`, 0);
  const kept = judgment.record(SPACE, { kind: 'review', target: 'entity:other', title: 'Synthetic staging target',
    summary: 'Keep it', evidence: [], outcome: 'approve', confidence: 0.9 }, 'review:other');
  judgment.close();
  const work = new RoleWorkStore(join(dataDir, 'role-work.sqlite'));
  const at = new Date('2026-10-22T00:00:00Z');
  const pkg = work.create({ request: { role: 'tonborg', operation: 'review', requestId: 'review-run-1',
    scope: { personalSpaceId: SPACE, personalProjectId: null, sessionRef: null }, versions: { evidence: 'e', policy: 'p' },
    instructions: 'Review these candidates.', evidence: [{ key: 'candidates', value: [
      { candidate_key: 'entity:item-1', item_id: 'item-1', title: `Deploy with ${PASTED}` },
      { candidate_key: 'entity:other', item_id: 'other', title: 'Synthetic staging target' }] }] },
  reason: 'no_model', at, ttlMs: 60_000 });
  work.close();

  const port = knowledgeHardDelete(dataDir, { send: async () => ({ ok: true, status: 200,
    payload: { ...DELETED, deleted_item_ids: ['item-1', 'item-2'] } }) });
  const done = await port.confirm({ personalSpaceId: SPACE, itemKind: 'entity', itemId: 'item-2', previewId: PREVIEW_ID,
    confirmation: '删除' });
  assert.deepEqual(done.local_stores.map(({ store, status }) => [store, status]),
    [['judgment.sqlite', 'forgotten'], ['role-work.sqlite', 'forgotten']]);
  assert.ok(done.local_stores.every((store) => store.changed > 0));

  const reopened = new JudgmentStore(join(dataDir, 'judgment.sqlite'));
  const forgotten = reopened.get(SPACE, review.id);
  assert.deepEqual([forgotten.title, forgotten.summary, forgotten.evidence, forgotten.hard_deleted, forgotten.outcome],
    [null, null, [], true, 'escalate']);
  assert.equal(forgotten.feedback.reason, '');
  assert.equal(reopened.get(SPACE, kept.id).title, 'Synthetic staging target');
  reopened.close();
  const reread = new RoleWorkStore(join(dataDir, 'role-work.sqlite'));
  const [gone, stays] = reread.get(pkg.packageId).request.evidence[0].value;
  assert.deepEqual([gone.title, gone.hard_deleted, stays.title], [null, true, 'Synthetic staging target']);
  reread.close();
  for (const file of ['judgment.sqlite', 'role-work.sqlite']) {
    assert.equal(readFileSync(join(dataDir, file)).includes(Buffer.from(PASTED)), false, file);
  }
  // A store this FULI cannot open is reported, not hidden; the graph delete stands.
  const failing = knowledgeHardDelete(dataDir, { send: async () => ({ ok: true, status: 200, payload: DELETED }),
    localStores: [{ name: 'judgment.sqlite', forget: () => { throw new Error('synthetic newer format'); } }] });
  const reported = await failing.confirm({ personalSpaceId: SPACE, itemKind: 'entity', itemId: 'item-2',
    previewId: PREVIEW_ID, confirmation: '删除' });
  assert.deepEqual(reported.local_stores, [{ store: 'judgment.sqlite', status: 'failed', reason: 'synthetic newer format' }]);
});
