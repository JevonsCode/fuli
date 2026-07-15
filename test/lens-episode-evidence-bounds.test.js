import assert from 'node:assert/strict';
import test from 'node:test';

import { LensQuery } from '../src/lens/lens-query.js';
import { LensResourceService } from '../src/lens/lens-resource-service.js';
import { FactScope, FactStatus, SpaceKind } from '../src/models.js';
import { FileStore, SqliteStore } from '../src/store.js';
import { STORE_METHODS } from '../src/storage/store-port.js';

const PREVIEW_BYTES = 16 * 1024;
const HUGE = 'x'.repeat(3 * 1024 * 1024);

test('history is truncated when its only fact is removed by the object-size bound', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('me', SpaceKind.PERSONAL);
  const source = store.addEpisode(personal.id, 'conversation', 'small source');
  store.addFact({
    id: 'oversized-only',
    spaceId: personal.id,
    subject: 'user',
    predicate: 'history_probe',
    object: HUGE,
    sourceEpisodeId: source.id,
    scope: FactScope.PERSONAL,
    status: FactStatus.DEPRECATED,
    invalidAt: '2026-01-02T00:00:00.000Z'
  });
  const service = new LensResourceService({
    store,
    lens: new LensQuery(store),
    activePersonalSpace: () => personal
  });

  const history = service.history();

  assert.deepEqual(history.items, []);
  assert.equal(history.truncated, true);
});

for (const [name, createStore] of [
  ['FileStore', () => new FileStore(':memory:')],
  ['SQLite', () => new SqliteStore(':memory:')]
]) {
  test(`${name} evidence previews bound bodies and metadata without losing correction fields`, () => {
    const store = createStore();
    try {
      const personal = store.createSpace(`${name}-me`, SpaceKind.PERSONAL);
      const source = store.addEpisode(
        personal.id,
        'conversation',
        `source-${HUGE}`,
        'chat://source',
        { note: HUGE }
      );
      const fact = addFact(store, personal.id, source.id, `${name}-fact`);
      const correction = store.addEpisode(
        personal.id,
        'correction',
        `correction-${HUGE}`,
        null,
        { kind: 'lens_correction', factId: fact.id, action: 'replace', padding: HUGE }
      );

      const sourcePreview = store.episodeEvidencePreview(personal.id, source.id, {
        maxBodyBytes: PREVIEW_BYTES,
        includeRestricted: false
      });
      const corrections = store.correctionEpisodeEvidencePreviews(personal.id, [fact.id], {
        maxBodyBytes: PREVIEW_BYTES,
        includeRestricted: false
      });
      const correctionGroup = corrections.find(({ factId }) => factId === fact.id);

      assert.ok(Buffer.byteLength(sourcePreview.body, 'utf8') <= PREVIEW_BYTES, name);
      assert.deepEqual(sourcePreview.truncatedFields.sort(), ['body', 'metadata'], name);
      assert.deepEqual(sourcePreview.metadata, {}, name);
      assert.equal(correctionGroup.episodes.length, 1, name);
      assert.equal(correctionGroup.episodes[0].id, correction.id, name);
      assert.ok(Buffer.byteLength(correctionGroup.episodes[0].body, 'utf8') <= PREVIEW_BYTES, name);
      assert.deepEqual(correctionGroup.episodes[0].metadata, {
        kind: 'lens_correction', factId: fact.id, action: 'replace'
      }, name);
      assert.deepEqual(
        correctionGroup.episodes[0].truncatedFields.sort(),
        ['body', 'metadata'],
        name
      );
      assert.equal(correctionGroup.truncated, false, name);
      assert.ok(Buffer.byteLength(JSON.stringify({ sourcePreview, corrections })) < 50_000, name);
    } finally {
      store.close();
    }
  });
}

test('SQLite privacy filtering sees credentials beyond the bounded source preview', () => {
  const store = new SqliteStore(':memory:');
  try {
    const personal = store.createSpace('private-me', SpaceKind.PERSONAL);
    const source = store.addEpisode(
      personal.id,
      'conversation',
      `${HUGE} ghp_123456789012345678901234567890`
    );

    const normal = store.episodeEvidencePreview(personal.id, source.id, {
      maxBodyBytes: PREVIEW_BYTES,
      includeRestricted: false
    });
    const explicit = store.episodeEvidencePreview(personal.id, source.id, {
      maxBodyBytes: PREVIEW_BYTES,
      includeRestricted: true
    });

    assert.equal(normal, null);
    assert.ok(Buffer.byteLength(explicit.body, 'utf8') <= PREVIEW_BYTES);
    assert.deepEqual(explicit.truncatedFields, ['body']);
  } finally {
    store.close();
  }
});

test('Lens search and view use bounded evidence ports while preserving small source bodies', () => {
  const backing = new FileStore(':memory:');
  const personal = backing.createSpace('me', SpaceKind.PERSONAL);
  const source = backing.addEpisode(
    personal.id,
    'conversation',
    'small source body',
    'chat://small',
    { channel: 'direct' }
  );
  const fact = addFact(backing, personal.id, source.id, 'selected-fact');
  backing.addEpisode(personal.id, 'correction', `large-${HUGE}`, null, {
    kind: 'lens_correction', factId: fact.id, action: 'reject', padding: HUGE
  });
  const calls = { source: 0, corrections: 0 };
  const store = instrumentEvidenceStore(backing, calls);
  const query = new LensQuery(store);

  const search = query.searchUserContext({
    personalSpaceId: personal.id,
    query: 'selected-fact',
    includeHistorical: true
  });
  const view = query.getUserLensView({
    personalSpaceId: personal.id,
    task: '',
    budget: 1024,
    includeRestricted: false
  });

  assert.equal(search.facts[0].sourceEpisode.body, 'small source body');
  assert.deepEqual(search.facts[0].sourceEpisode.metadata, { channel: 'direct' });
  assert.ok(Buffer.byteLength(search.facts[0].correctionEpisodes[0].body) <= PREVIEW_BYTES);
  assert.equal(view.entries[0].source.uri, 'chat://small');
  assert.ok(calls.source >= 2);
  assert.equal(calls.corrections, 1);
});

function addFact(store, spaceId, sourceEpisodeId, id) {
  return store.addFact({
    id,
    spaceId,
    subject: 'user',
    predicate: 'evidence_probe',
    object: id,
    sourceEpisodeId,
    scope: FactScope.PERSONAL
  });
}

function instrumentEvidenceStore(backing, calls) {
  return Object.fromEntries(STORE_METHODS.map((name) => [name, (...args) => {
    if (name === 'getEpisode') {
      throw new Error(`unbounded episode path: ${name}`);
    }
    if (name === 'episodeEvidencePreview') calls.source += 1;
    if (name === 'correctionEpisodeEvidencePreviews') calls.corrections += 1;
    return backing[name](...args);
  }]));
}
