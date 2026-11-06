// rec#88: the meaning index is filled with the person's connected model, only
// for approved projects, and a search carries its query's vector. Synthetic only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { fillSemanticIndex, queryVector, semanticModel } from '../src/semantic/semantic-index.js';
import { semanticIndexStatus, startSemanticIndexer } from '../src/semantic/scheduler.js';

const SPACE = 'space-synthetic';
const item = (id, project, text = `text of ${id}`) => ({ item_kind: 'entity', item_id: id, personal_project_id: project, text, hash: 'a'.repeat(64) });

function app({ model = 'synthetic-embed', approved = ['alpha'], pages = [], embedFails = false } = {}) {
  const calls = { embedded: [], written: [], pending: [] };
  const application = {
    config: { personal: { spaceId: SPACE } },
    modelBackends: {
      operationSettings: (role, operation) => (model && role === 'semantic' && operation === 'knowledge_embedding'
        ? { connection: { model } } : null),
      allowsEgress: request => approved.includes(request.scope.personalProjectId),
      embed: async (request) => {
        calls.embedded.push(request);
        if (embedFails) return { vectors: null, modelReceipt: { reason: 'network' } };
        return { vectors: request.texts.map((_, index) => [index + 1, 0.5]), modelReceipt: { status: 'completed' } };
      }
    },
    personal: {
      semanticPending: async (input) => { calls.pending.push(input); return pages.shift() ?? { items: [], next: null }; },
      writeSemanticVectors: async (input) => { calls.written.push(input); return { written: input.items.length, skipped: [] }; },
      semanticStatus: async () => ({ total: 10, done: 4 })
    }
  };
  return { application, calls };
}

test('without a connected model nothing is read or sent', async () => {
  const { application, calls } = app({ model: null });
  assert.equal(semanticModel(application), null);
  assert.deepEqual(await fillSemanticIndex(application), { status: 'off', embedded: 0, skipped: 0, refused: 0 });
  assert.deepEqual(calls.pending, []);
  assert.equal(await queryVector(application, { personalProjectId: 'alpha', query: 'deploy' }), null);
});

test('only approved projects are embedded, page by page, and their vectors written back with their hash', async () => {
  const { application, calls } = app({ pages: [
    { items: [item('a1', 'alpha'), item('b1', 'beta'), item('n1', null)], next: 'cursor-1' },
    { items: [item('a2', 'alpha')], next: null }] });
  const result = await fillSemanticIndex(application);
  assert.deepEqual(result, { status: 'done', embedded: 2, skipped: 0, refused: 2 });
  assert.deepEqual(calls.embedded.map(request => request.texts), [['text of a1'], ['text of a2']]);
  assert.ok(calls.embedded.every(request => request.scope.personalProjectId === 'alpha'));
  assert.equal(calls.pending[1].after, 'cursor-1');
  assert.deepEqual(calls.written[0].items[0], { item_kind: 'entity', item_id: 'a1', hash: 'a'.repeat(64), vector: [1, 0.5] });
  assert.equal(calls.written[0].model, 'synthetic-embed');
});

test('a model call that fails stops the pass and writes nothing for it', async () => {
  const { application, calls } = app({ embedFails: true, pages: [{ items: [item('a1', 'alpha')], next: null }] });
  const result = await fillSemanticIndex(application);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'network');
  assert.deepEqual(calls.written, []);
});

test('a query is embedded once for its project, kept a while, and not at all for a project not approved', async () => {
  const { application, calls } = app();
  const first = await queryVector(application, { personalProjectId: 'alpha', query: 'how do we ship', timeoutMs: 1500 });
  assert.deepEqual(first, { model: 'synthetic-embed', vector: [1, 0.5] });
  assert.equal(calls.embedded[0].budget.timeoutMs, 1500);
  await queryVector(application, { personalProjectId: 'alpha', query: 'how do we ship', timeoutMs: 1500 });
  assert.equal(calls.embedded.length, 1, 'the second ask is served from the cache');
  assert.equal(await queryVector(application, { personalProjectId: 'beta', query: 'secret plan' }), null);
  assert.equal(calls.embedded.length, 1);
});

test('the status names the model, the share done and whether a pass runs now', async () => {
  const { application } = app();
  const indexer = startSemanticIndexer({ app: application, intervalMs: 60_000 });
  try {
    assert.deepEqual(await semanticIndexStatus(application, indexer), { model: 'synthetic-embed', total: 10, done: 4, running: false, lastRun: null });
    await indexer.runNow();
    assert.equal(indexer.state.lastRun.status, 'done');
  } finally {
    await indexer.stop();
  }
  const off = app({ model: null });
  assert.deepEqual(await semanticIndexStatus(off.application, null), { model: null, total: 0, done: 0, running: false });
});
