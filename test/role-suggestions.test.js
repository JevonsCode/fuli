import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareRoleSuggestionNote } from '../src/graphiti/role-suggestion-note.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { hardDeleteLedger } from '../src/knowledge-hard-delete/delete-ledger.js';
import { knowledgeReferences } from '../src/knowledge-hard-delete/forget-references.js';
import { handleModelBackendApiRequest } from '../src/model-backends/http.js';
import { RETENTION, RoleSuggestionLog } from '../src/model-backends/suggestion-log.js';
import { listenFetchableServer } from '../src/server/listen.js';

// Synthetic suggestions only, shaped as the three roles write them: no model,
// no data directory but a temporary one.
const SPACE = 'space-a';
const receipt = (role, operation, n = 1) => ({ requestId: `${operation}:r${n}`, evidenceVersion: String(n).repeat(64),
  promptVersion: `${operation}:p1`, gate: { status: 'suggestion_only', role, operation },
  modelReceipt: { backend: 'model_api', status: 'completed', reason: null, failureClass: null, fallbackReason: null,
    requestedModel: 'qwen-test', actualModel: 'qwen-test-actual', attempts: 1,
    usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60, unknownAttempts: 0 } } });
const jefaSuggested = (n = 1) => ({ status: 'suggested', hint: '可能是看板上的「Seed inventory」任务', confirmWith: 'call_employee_tool',
  suggestion: { taskId: 'task-seeds', title: 'Seed inventory', updatedAt: null, reason: 'Same page.', uncertainty: null },
  suggestedBy: { mode: 'model_api', independent: true, model: 'qwen-test-actual' }, ...receipt('jefa', 'board_match', n) });
const jefa = (result, conversationId = 'conversation-1', extra = {}) => ({ role: 'jefa', operation: 'board_match', personalSpaceId: SPACE,
  personalProjectId: 'garden', subject: { conversationId }, result, ...extra });
const bole = (agentId, n = 1) => ({ role: 'bole', operation: 'performance_review', personalSpaceId: SPACE, personalProjectId: 'garden',
  subject: { agentId }, result: { status: 'suggested', suggestion: { action: 'coach', reason: 'Completion is low.', evidenceIds: ['completion'],
    uncertainty: null }, suggestedBy: { mode: 'model_api', independent: true, model: 'qwen-test-actual' },
  ...receipt('bole', 'performance_review', n) } });

function storeIn(t, clock) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-role-suggestions-'));
  const path = join(directory, 'role-suggestions.sqlite');
  const log = new RoleSuggestionLog(path, { now: () => new Date(clock.now) });
  t.after(() => { log.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, log };
}

test('a row is the result the session got, without its guidance; reading creates no file and deletes nothing', (t) => {
  const clock = { now: Date.parse('2026-10-23T08:00:00.000Z') };
  const { path, log } = storeIn(t, clock);
  assert.deepEqual(log.list(), []);
  assert.equal(existsSync(path), false, 'reading creates no file');

  log.record(jefa(jefaSuggested()));
  clock.now += 60_000;
  log.record(jefa({ status: 'inline', reason: 'server_error', guidance: 'Match the board yourself.', ...receipt('jefa', 'board_match', 2) }));
  const [fallback, suggested] = log.list();
  assert.deepEqual(suggested, { ...jefaSuggested(), id: 1, at: '2026-10-23T08:00:00.000Z', role: 'jefa', operation: 'board_match',
    personalSpaceId: SPACE, personalProjectId: 'garden', subject: { conversationId: 'conversation-1' } });
  assert.deepEqual([fallback.status, fallback.reason, 'guidance' in fallback], ['inline', 'server_error', false]);

  // A read 91 days later shows nothing and deletes nothing; the next write does.
  clock.now += 91 * 86_400_000;
  assert.deepEqual(log.list(), []);
  assert.equal(log.db.prepare('SELECT COUNT(*) AS n FROM role_suggestions').get().n, 2, 'reads never delete');
  log.record(jefa(jefaSuggested(3), 'conversation-2'));
  assert.deepEqual(log.db.prepare('SELECT id FROM role_suggestions').all().map(row => row.id), [3]);
});

test('the 301st row removes the oldest, in the same write; a limit is clamped to 300', (t) => {
  const clock = { now: Date.parse('2026-10-23T00:00:00.000Z') };
  const { log } = storeIn(t, clock);
  for (let n = 1; n <= RETENTION.rows + 1; n++) {
    clock.now += 1000;
    log.record(jefa(jefaSuggested(n % 9 + 1), `conversation-${n}`));
  }
  const all = log.list({ limit: 10_000 });
  assert.equal(all.length, RETENTION.rows);
  assert.equal(all.at(-1).id, 2, 'the oldest row is gone');
  assert.equal(log.list().length, 50);
  assert.equal(log.list({ limit: 0 }).length, 1);
});

test('only a newer suggestion for the same subject in the same space and project marks an older one', (t) => {
  const clock = { now: Date.parse('2026-10-23T00:00:00.000Z') };
  const { log } = storeIn(t, clock);
  const write = entry => { clock.now += 1000; log.record(entry); };
  write(bole('engineer-x', 1));
  write(bole('engineer-y', 2));
  write({ ...bole('engineer-x', 3), personalSpaceId: 'space-b' });
  write({ ...bole('engineer-x', 4), personalProjectId: 'ledger' });
  write(jefa(jefaSuggested(5), 'conversation-1'));
  write(jefa(jefaSuggested(6), null));
  write(jefa(jefaSuggested(7), null));
  // A superseded or stopped result for the same subject is no newer suggestion.
  write(jefa({ status: 'superseded', reason: 'task_changed', ...receipt('jefa', 'board_match', 8) }, 'conversation-1'));
  write(bole('engineer-x', 9));
  write(jefa({ status: 'paused', reason: 'window_tokens', ...receipt('jefa', 'board_match', 9) }, 'conversation-1'));
  const stale = Object.fromEntries(log.list().map(entry => [entry.id, entry.stale ?? null]));
  assert.deepEqual(stale, { 1: 'newer', 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null, 9: null, 10: null });
  assert.equal(log.list().find(entry => entry.id === 1).status, 'suggested', 'the recorded status stays');
  write(jefa(jefaSuggested(11), 'conversation-1'));
  assert.equal(log.list().find(entry => entry.id === 5).stale, 'newer');
});

test('a permanent delete in a space clears the words of every record of that space written up to it, and only those', (t) => {
  const clock = { now: Date.parse('2026-10-23T00:00:00.000Z') };
  const { directory, path, log } = storeIn(t, clock);
  log.record(jefa(jefaSuggested()));
  log.record(bole('engineer-x', 2));
  log.record({ role: 'assistant', operation: 'project_candidate', personalSpaceId: SPACE, subject: { conversationId: 'conversation-1' },
    result: { status: 'suggested', hint: '可能属于「Garden」，需你确认', suggestion: { personalProjectId: 'garden', name: 'Garden',
      reason: 'Watering reminders.', uncertainty: 'low' }, confirmWith: 'checkpoint_task_knowledge.triage',
      suggestedBy: { mode: 'model_api', independent: true, model: 'qwen-test-actual' }, ...receipt('assistant', 'project_candidate', 3) } });
  log.record({ ...jefa(jefaSuggested(4), 'conversation-9'), personalSpaceId: 'space-b' });
  const otherSpace = () => JSON.stringify(log.list().filter(entry => entry.personalSpaceId === 'space-b'));
  const before = otherSpace();
  // The rows name no knowledge item, so the delete cannot tell which one quoted it: all of the space lose their words.
  const references = knowledgeReferences({ itemIds: ['item-1'] });
  const deletedAt = new Date(clock.now).toISOString();
  assert.equal(log.forgetKnowledgeItems(SPACE, references, { deletedAt }), 3);
  const cleared = Object.fromEntries(log.list().filter(entry => entry.personalSpaceId === SPACE).map(entry => [entry.role, entry]));
  assert.deepEqual(cleared.jefa.suggestion, { taskId: 'task-seeds', updatedAt: null });
  assert.deepEqual(cleared.bole.suggestion, { action: 'coach', evidenceIds: ['completion'] });
  assert.deepEqual(cleared.assistant.suggestion, { personalProjectId: 'garden' });
  for (const entry of Object.values(cleared)) {
    assert.deepEqual([entry.status, entry.hint, entry.hard_deleted, entry.gate.status], ['suggested', undefined, true, 'suggestion_only']);
    assert.equal(JSON.stringify(entry).includes('Watering') || JSON.stringify(entry).includes('Seed inventory')
      || JSON.stringify(entry).includes('Completion is low'), false);
  }
  assert.deepEqual(cleared.jefa.subject, { conversationId: 'conversation-1' });
  assert.equal(otherSpace(), before, 'another space is untouched, byte for byte');
  assert.equal(log.forgetKnowledgeItems(SPACE, references, { deletedAt }), 0, 'counted once');

  // A record written later is not one the delete could have reached.
  clock.now += 60_000;
  log.record(jefa(jefaSuggested(5), 'conversation-5'));
  assert.equal(log.list()[0].suggestion.reason, 'Same page.');

  // While a delete in the space is open, a new record is stored without words; one in another space is not.
  hardDeleteLedger(directory).begin({ spaceId: SPACE, itemKind: 'entity', itemId: 'item-2', previewId: 'preview-1', itemIds: [] });
  clock.now += 60_000;
  const during = new RoleSuggestionLog(path, { now: () => new Date(clock.now) });
  try {
    during.record(jefa(jefaSuggested(6), 'conversation-6'));
    during.record({ ...jefa(jefaSuggested(7), 'conversation-7'), personalSpaceId: 'space-b' });
    const [other, fenced] = during.list();
    assert.deepEqual([fenced.hint, fenced.suggestion, fenced.hard_deleted], [undefined, { taskId: 'task-seeds', updatedAt: null }, true]);
    assert.deepEqual([other.personalSpaceId, other.suggestion.reason, other.hard_deleted], ['space-b', 'Same page.', undefined]);
  } finally { during.close(); }
});

test('a delete that completes while the model runs keeps the late answer\'s words out; a later write keeps its words', (t) => {
  const clock = { now: Date.parse('2026-10-23T00:00:00.000Z') };
  const { directory, log } = storeIn(t, clock);
  const ledger = hardDeleteLedger(directory, { now: () => new Date(clock.now) });
  // The role reads the generation, then its evidence, then waits for the model.
  const generation = log.deletionGeneration(SPACE);
  assert.deepEqual(generation, []);
  // Meanwhile a delete in the space begins, commits and completes; its cleanup finds no row yet.
  const operation = ledger.begin({ spaceId: SPACE, itemKind: 'entity', itemId: 'item-1', previewId: 'preview-1', itemIds: ['item-1'] });
  ledger.update(operation.id, { state: 'complete', deletedAt: new Date(clock.now).toISOString() });
  assert.equal(log.forgetKnowledgeItems(SPACE, knowledgeReferences({ itemIds: ['item-1'] }), { deletedAt: operation.createdAt }), 0);
  // The model answers afterwards: the row is kept, without words.
  clock.now += 60_000;
  log.record({ ...jefa(jefaSuggested()), deletionGeneration: generation });
  const [late] = log.list();
  assert.deepEqual([late.status, late.hint, late.suggestion, late.hard_deleted], ['suggested', undefined, { taskId: 'task-seeds', updatedAt: null }, true]);
  // A role that read its generation after the delete keeps its words; so does another space.
  log.record({ ...jefa(jefaSuggested(2), 'conversation-2'), deletionGeneration: log.deletionGeneration(SPACE) });
  log.record({ ...jefa(jefaSuggested(3), 'conversation-3'), personalSpaceId: 'space-b', deletionGeneration: [] });
  assert.deepEqual(log.list().slice(0, 2).map(entry => entry.suggestion.reason), ['Same page.', 'Same page.']);
  // A record that cannot be read keeps no words.
  log.record({ ...jefa(jefaSuggested(4), 'conversation-4'), deletionGeneration: null });
  assert.equal(log.list()[0].hard_deleted, true);
});

test('a delete already open when the role reads its evidence keeps the answer\'s words out, even once it completed', (t) => {
  const clock = { now: Date.parse('2026-10-23T00:00:00.000Z') };
  const { directory, log } = storeIn(t, clock);
  const ledger = hardDeleteLedger(directory, { now: () => new Date(clock.now) });
  // The delete begins; the graph has not committed it yet.
  const operation = ledger.begin({ spaceId: SPACE, itemKind: 'entity', itemId: 'item-1', previewId: 'preview-1', itemIds: ['item-1'] });
  // The role reads the generation and its (old) evidence now, in this space and in another one.
  const generation = log.deletionGeneration(SPACE);
  const otherGeneration = log.deletionGeneration('space-b');
  assert.deepEqual([generation, otherGeneration], [null, []]);
  // The delete commits and completes while the model is awaited.
  ledger.update(operation.id, { state: 'complete', deletedAt: new Date(clock.now).toISOString() });
  clock.now += 60_000;
  log.record({ ...jefa(jefaSuggested()), deletionGeneration: generation });
  log.record({ ...jefa(jefaSuggested(2), 'conversation-2'), personalSpaceId: 'space-b', deletionGeneration: otherGeneration });
  const [other, late] = log.list();
  assert.deepEqual([late.personalSpaceId, late.hint, late.suggestion, late.hard_deleted],
    [SPACE, undefined, { taskId: 'task-seeds', updatedAt: null }, true]);
  assert.deepEqual([other.personalSpaceId, other.suggestion.reason, other.hard_deleted], ['space-b', 'Same page.', undefined]);
  // A request that starts after the delete completed keeps its words.
  const after = log.deletionGeneration(SPACE);
  assert.deepEqual(after, [operation.id]);
  clock.now += 60_000;
  log.record({ ...jefa(jefaSuggested(3), 'conversation-3'), deletionGeneration: after });
  assert.equal(log.list()[0].suggestion.reason, 'Same page.');
});

test('a delete\'s cleanup is bound to its own time: a retry or a later status check never reaches a newer record', (t) => {
  const clock = { now: Date.parse('2026-10-23T00:00:00.000Z') };
  const { log } = storeIn(t, clock);
  log.record(jefa(jefaSuggested()));
  // T1: the delete commits and its cleanup runs.
  clock.now += 60_000;
  const deletedAt = new Date(clock.now).toISOString();
  const references = knowledgeReferences({ itemIds: ['item-1'] });
  assert.equal(log.forgetKnowledgeItems(SPACE, references, { deletedAt }), 1);
  // T2: a legitimate new suggestion.
  clock.now += 60_000;
  log.record(jefa(jefaSuggested(2), 'conversation-2'));
  // T3: the same delete's cleanup runs again (a retry, a recovery, an old link's status).
  clock.now += 60_000;
  assert.equal(log.forgetKnowledgeItems(SPACE, references, { deletedAt }), 0);
  assert.equal(log.list()[0].suggestion.reason, 'Same page.', 'the newer record keeps its words');
});

test('the console copy is kept only while recording is on, decided before the result; anything unreadable keeps nothing', async () => {
  const kept = [];
  const app = (policy, extra = {}) => ({ roleSuggestions: { record: entry => kept.push(entry) },
    getCapturePolicy: () => policy, ...extra });
  const entry = jefa(jefaSuggested());
  const scope = () => ({ sourceApplication: 'codex', personalProjectId: null });
  (await prepareRoleSuggestionNote(app({ enabled: true, disabledSources: [] }), scope))(entry);
  assert.equal(kept.length, 1);
  for (const [name, application, readScope] of [
    ['global off', app({ enabled: false, disabledSources: [] }), scope],
    ['client off', app({ enabled: true, disabledSources: ['codex'] }), scope],
    ['settings unreadable', app(null, { getCapturePolicy: () => { throw new Error('unreadable'); } }), scope],
    ['scope unreadable', app({ enabled: true, disabledSources: [] }), async () => { throw new Error('Provider down'); }]]) {
    (await prepareRoleSuggestionNote(application, readScope))(entry);
    assert.equal(kept.length, 1, name);
  }
  const failing = { roleSuggestions: { record: () => { throw new Error('disk full'); } }, getCapturePolicy: () => ({ enabled: true }) };
  const keepFailing = await prepareRoleSuggestionNote(failing, scope);
  assert.doesNotThrow(() => keepFailing(entry));
  const keepWithout = await prepareRoleSuggestionNote({}, scope);
  assert.doesNotThrow(() => keepWithout(entry));
});

test('the console reads suggestions over a GET-only route that never writes', async (t) => {
  const log = new RoleSuggestionLog(':memory:', { now: () => new Date('2026-10-23T08:00:00.000Z') });
  t.after(() => log.close());
  log.record(jefa(jefaSuggested()));
  const recorded = log.record.bind(log);
  const writes = [];
  log.record = (entry) => { writes.push(entry); return recorded(entry); };
  const serve = (roleSuggestions) => async (request, response) => {
    try {
      if (!await handleModelBackendApiRequest({ request, response, url: new URL(request.url, 'http://local'),
        modelBackends: { roles: () => ({}) }, roleSuggestions })) response.writeHead(404).end();
    } catch (error) {
      const mapped = mapHttpError(error);
      response.writeHead(mapped.status, { 'content-type': 'application/json' }).end(JSON.stringify(mapped.body));
    }
  };
  const server = createServer(serve(log));
  const bare = createServer(serve(null));
  await listenFetchableServer(server, 0);
  await listenFetchableServer(bare, 0);
  const url = (target) => `http://127.0.0.1:${target.address().port}/api/model-backends/suggestions`;
  try {
    const ok = await fetch(url(server));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const body = await ok.json();
    assert.deepEqual(body.retention, { days: 90, rows: 300 });
    assert.deepEqual(body.suggestions.map(entry => [entry.role, entry.status, entry.suggestion.taskId, entry.gate.status]),
      [['jefa', 'suggested', 'task-seeds', 'suggestion_only']]);
    assert.equal((await fetch(`${url(server)}?limit=1000`)).status, 200);
    assert.equal((await fetch(`${url(server)}?limit=0`)).status, 400);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await fetch(url(server), { method, body: method === 'DELETE' ? undefined : '{}' })).status, 405, method);
    }
    assert.deepEqual(writes, []);
    assert.equal((await fetch(url(bare))).status, 503);
  } finally {
    server.close();
    bare.close();
  }
});
