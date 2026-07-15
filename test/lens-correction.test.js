import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError, ApplicationErrorCode } from '../src/app/application-error.js';
import { LensService } from '../src/lens/lens-service.js';
import { FactScope, FactStatus, Sensitivity, SpaceKind } from '../src/models.js';
import { FileStore, SqliteStore } from '../src/store.js';
import { STORE_METHODS } from '../src/storage/store-port.js';

for (const [name, createStore] of [
  ['FileStore', () => new FileStore(':memory:')],
  ['SqliteStore', () => new SqliteStore(':memory:')]
]) {
  test(`${name} replaces a current fact with correction evidence`, () => {
    const store = createStore();
    const personal = store.createSpace('我', SpaceKind.PERSONAL);
    const lens = new LensService(store);
    const original = lens.rememberUserFact({
      personalSpaceId: personal.id,
      predicate: 'prefers_language',
      value: 'JavaScript',
      sourceText: '我熟悉 JavaScript',
      sensitivity: Sensitivity.PRIVATE,
      confidence: 0.8
    });

    const result = lens.correctUserFact({
      personalSpaceId: personal.id,
      factId: original.fact.id,
      action: 'replace',
      value: 'TypeScript',
      sourceText: '现在更偏好 TypeScript'
    });

    const oldFact = store.getFact(original.fact.id);
    assert.equal(oldFact.sourceEpisodeId, original.fact.sourceEpisodeId);
    assert.equal(oldFact.replacedByFactId, result.fact.id);
    assert.ok(oldFact.invalidAt);
    assert.equal(result.fact.status, FactStatus.CONFIRMED);
    assert.equal(result.fact.sensitivity, Sensitivity.PRIVATE);
    assert.equal(result.fact.confidence, 0.8);
    assert.equal(result.fact.sourceEpisodeId, result.episode.id);
    assert.deepEqual(result.episode.metadata, {
      kind: 'lens_correction',
      factId: original.fact.id,
      action: 'replace'
    });
    assert.deepEqual(store.currentFacts(personal.id), [result.fact]);
    assert.equal(store.listFacts({ includeHistorical: true }).length, 2);
    store.close();
  });

  test(`${name} rejects and deprecates without creating replacement facts`, () => {
    const store = createStore();
    const personal = store.createSpace('我', SpaceKind.PERSONAL);
    const lens = new LensService(store);
    const rejected = lens.rememberUserFact({
      personalSpaceId: personal.id,
      predicate: 'prefers_editor',
      value: 'vim',
      sourceText: '我使用 vim'
    }).fact;
    const deprecated = lens.rememberUserFact({
      personalSpaceId: personal.id,
      predicate: 'prefers_runtime',
      value: 'node',
      sourceText: '我使用 node'
    }).fact;

    const rejectedResult = lens.correctUserFact({
      personalSpaceId: personal.id,
      factId: rejected.id,
      action: 'reject',
      sourceText: '这条记忆不正确'
    });
    const deprecatedResult = lens.correctUserFact({
      personalSpaceId: personal.id,
      factId: deprecated.id,
      action: 'deprecate',
      sourceText: '这条记忆已经过时'
    });

    assert.equal(rejectedResult.fact.status, FactStatus.REJECTED);
    assert.ok(rejectedResult.fact.invalidAt);
    assert.equal(deprecatedResult.fact.status, FactStatus.DEPRECATED);
    assert.ok(deprecatedResult.fact.invalidAt);
    assert.equal(rejectedResult.fact.replacedByFactId, null);
    assert.equal(deprecatedResult.fact.replacedByFactId, null);
    assert.equal(store.currentFacts(personal.id).length, 0);
    assert.deepEqual(store.listEpisodes().map((episode) => episode.metadata), [
      {},
      {},
      { kind: 'lens_correction', factId: rejected.id, action: 'reject' },
      { kind: 'lens_correction', factId: deprecated.id, action: 'deprecate' }
    ]);
    store.close();
  });
}

test('correction validates before writing an Episode and rolls back multi-writes', () => {
  const baseStore = new FileStore(':memory:');
  const personal = baseStore.createSpace('我', SpaceKind.PERSONAL);
  const other = baseStore.createSpace('另一人', SpaceKind.PERSONAL);
  const lens = new LensService(baseStore);
  const original = lens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: '我熟悉 JavaScript'
  }).fact;
  const otherFact = lens.rememberUserFact({
    personalSpaceId: other.id,
    predicate: 'prefers_language',
    value: 'Python',
    sourceText: '另一人熟悉 Python'
  }).fact;
  const before = baseStore.exportSnapshot();
  const invalid = (input) => assert.throws(
    () => lens.correctUserFact(input),
    (error) => error instanceof ApplicationError && error.code === ApplicationErrorCode.VALIDATION
  );

  invalid({ personalSpaceId: personal.id, factId: original.id, action: 'unknown', sourceText: 'x' });
  invalid({ personalSpaceId: personal.id, factId: original.id, action: 'replace', value: '', sourceText: 'x' });
  invalid({ personalSpaceId: personal.id, factId: original.id, action: 'replace', value: 'sk-live-12345678901234567890', sourceText: 'x' });
  invalid({ personalSpaceId: personal.id, factId: original.id, action: 'replace', value: 'TypeScript', sourceText: '' });
  assert.throws(
    () => lens.correctUserFact({
      personalSpaceId: personal.id,
      factId: otherFact.id,
      action: 'reject',
      sourceText: 'x'
    }),
    (error) => error instanceof ApplicationError && error.code === ApplicationErrorCode.NOT_FOUND
  );
  assert.equal(baseStore.listEpisodes().length, 2);

  const store = overrideStore(baseStore, {
    addFact() {
      throw new Error('injected correction failure');
    }
  });
  assert.throws(
    () => new LensService(store).correctUserFact({
      personalSpaceId: personal.id,
      factId: original.id,
      action: 'replace',
      value: 'TypeScript',
      sourceText: '现在更偏好 TypeScript'
    }),
    /injected correction failure/
  );
  assert.deepEqual(baseStore.exportSnapshot(), before);
});

test('legacy facts containing detected secrets can be rejected, deprecated, or safely replaced', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const episode = store.addEpisode(personal.id, 'legacy', 'legacy import');
  const facts = ['reject', 'deprecate', 'replace'].map((action) => store.addFact({
    id: `legacy-${action}`,
    spaceId: personal.id,
    subject: 'user',
    predicate: `legacy_${action}`,
    object: 'sk-live-12345678901234567890',
    sourceEpisodeId: episode.id,
    scope: FactScope.PERSONAL
  }));
  const lens = new LensService(store);

  const rejected = lens.correctUserFact({
    personalSpaceId: personal.id,
    factId: facts[0].id,
    action: 'reject',
    sourceText: '这条旧记录不正确'
  });
  const deprecated = lens.correctUserFact({
    personalSpaceId: personal.id,
    factId: facts[1].id,
    action: 'deprecate',
    sourceText: '这条旧记录已过时'
  });
  const replaced = lens.correctUserFact({
    personalSpaceId: personal.id,
    factId: facts[2].id,
    action: 'replace',
    value: 'removed',
    sourceText: '用安全值替换旧记录'
  });

  assert.equal(rejected.fact.status, FactStatus.REJECTED);
  assert.equal(deprecated.fact.status, FactStatus.DEPRECATED);
  assert.equal(replaced.fact.object, 'removed');
  assert.equal(store.getFact(facts[2].id).replacedByFactId, replaced.fact.id);
  store.close();
});

function overrideStore(store, overrides) {
  return Object.fromEntries(STORE_METHODS.map((method) => [
    method,
    overrides[method] ?? ((...args) => store[method](...args))
  ]));
}
