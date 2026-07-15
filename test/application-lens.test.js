import assert from 'node:assert/strict';
import test from 'node:test';

import { createApplication } from '../src/app/create-application.js';
import { FactScope } from '../src/models.js';
import { STORE_METHODS } from '../src/storage/store-port.js';
import { FileStore, SqliteStore } from '../src/store.js';

test('application facade exposes one frozen Lens facade for FileStore and SQLite', (t) => {
  for (const [label, store] of [
    ['file', new FileStore(':memory:')],
    ['sqlite', new SqliteStore(':memory:')]
  ]) {
    t.diagnostic(`checking ${label} application facade`);
    const app = createApplication({ store });
    const { personal } = app.bootstrap();
    const result = app.lens.rememberUserFact({
      personalSpaceId: personal.id,
      predicate: 'prefers_language',
      value: 'JavaScript',
      sourceText: '我更熟悉 JavaScript'
    });

    assert.equal(result.fact.scope, FactScope.PERSONAL);
    assert.equal(Object.isFrozen(app.lens), true);
    assert.deepEqual(Object.keys(app.lens).sort(), [
      'confirmObservation',
      'correctUserFact',
      'getUserLens',
      'getUserLensView',
      'rememberUserFact',
      'searchUserContext',
      'submitUserObservation'
    ]);
    assert.equal(typeof app.lens.submitUserObservation, 'function');
    assert.equal(typeof app.lens.confirmObservation, 'function');
    assert.equal(typeof app.lens.correctUserFact, 'function');
    assert.equal(typeof app.lens.getUserLens, 'function');
    assert.equal(typeof app.lens.getUserLensView, 'function');
    assert.equal(typeof app.lens.searchUserContext, 'function');
    assert.equal('rememberUserFact' in app, false);
    assert.equal('submitUserObservation' in app, false);
    assert.equal('confirmObservation' in app, false);
    assert.equal('correctUserFact' in app, false);
    assert.equal('store' in app, false);
    app.close();
  }
});

test('Lens view reads selected sources inside one transaction and filters unsafe sources', () => {
  const backing = new FileStore(':memory:');
  const personal = backing.createSpace('我', 'personal');
  const other = backing.createSpace('他人', 'personal');
  const safe = backing.addEpisode(personal.id, 'conversation', 'safe source');
  const cross = backing.addEpisode(other.id, 'conversation', 'cross source');
  const restricted = backing.addEpisode(
    personal.id,
    'conversation',
    'Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz123456'
  );
  for (const [id, sourceEpisodeId, predicate] of [
    ['sk-proj-caller-secret-id-abcdefghijklmnopqrstuvwxyz', safe.id, 'prefers_safe'],
    ['missing-fact', 'missing-episode', 'prefers_missing'],
    ['cross-fact', cross.id, 'prefers_cross'],
    ['restricted-fact', restricted.id, 'prefers_restricted']
  ]) backing.addFact({
    id, spaceId: personal.id, subject: 'user', predicate, object: 'value', sourceEpisodeId,
    validAt: '2026-07-11T00:00:00.000Z'
  });

  const calls = new Map();
  let inTransaction = false;
  let store;
  store = Object.fromEntries(STORE_METHODS.map((method) => [method, (...args) => {
    calls.set(method, (calls.get(method) ?? 0) + 1);
    if (['currentFacts', 'episodeEvidencePreview'].includes(method)) {
      assert.equal(inTransaction, true, `${method} outside transaction`);
    }
    if (method === 'transaction') {
      return backing.transaction(() => {
        inTransaction = true;
        try {
          return args[0](store);
        } finally {
          inTransaction = false;
        }
      }, args[1]);
    }
    return backing[method](...args);
  }]));
  const app = createApplication({ store });

  const view = app.lens.getUserLensView({
    personalSpaceId: personal.id,
    task: '',
    budget: 1200,
    includeObserved: true,
    includeSuggested: false,
    includeRestricted: false
  });

  assert.deepEqual(view.entries, [{
    subject: 'user',
    predicate: 'prefers_safe',
    object: 'value',
    status: 'confirmed',
    validAt: '2026-07-11T00:00:00.000Z',
    source: {
      kind: 'conversation',
      uri: null,
      createdAt: safe.createdAt
    }
  }]);
  const serialized = JSON.stringify(view);
  for (const forbidden of [
    'sk-proj-caller-secret-id-abcdefghijklmnopqrstuvwxyz', safe.id, personal.id,
    'safe source', 'spaceId', 'body', 'metadata', 'confidence', 'sensitivity',
    'scope', 'sourceEpisodeId', 'replacedByFactId'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(view.truncated, true);
  assert.equal(calls.get('transaction'), 1);
  assert.equal(calls.get('currentFacts'), 1);
  assert.equal(calls.get('episodeEvidencePreview'), 4);
  for (const method of ['getEpisode', 'searchFacts', 'listFacts', 'listEpisodes']) {
    assert.equal(calls.get(method) ?? 0, 0, method);
  }
  app.close();
});
