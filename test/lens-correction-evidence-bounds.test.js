import assert from 'node:assert/strict';
import test from 'node:test';

import { LensQuery } from '../src/lens/lens-query.js';
import { FactScope, SpaceKind } from '../src/models.js';
import { FileStore, SqliteStore } from '../src/store.js';

const PER_FACT_LIMIT = 5;

for (const [name, createStore] of [
  ['FileStore', () => new FileStore(':memory:')],
  ['SQLite', () => new SqliteStore(':memory:')]
]) {
  test(`${name} returns the latest bounded correction evidence per fact`, () => {
    const store = createStore();
    try {
      const personal = store.createSpace(`${name}-me`, SpaceKind.PERSONAL);
      const source = store.addEpisode(personal.id, 'conversation', 'source');
      const first = addFact(store, personal.id, source.id, 'first-fact');
      const second = addFact(store, personal.id, source.id, 'second-fact');
      const small = addFact(store, personal.id, source.id, 'small-fact');
      addCorrections(store, personal.id, first.id, 'first', 12);
      addCorrections(store, personal.id, second.id, 'second', 11);
      addCorrections(store, personal.id, small.id, 'small', 2);

      const groups = store.correctionEpisodeEvidencePreviews(
        personal.id,
        [first.id, second.id, small.id],
        { maxCorrectionsPerFact: PER_FACT_LIMIT }
      );

      assert.deepEqual(groups.map(({ factId }) => factId), [first.id, second.id, small.id], name);
      assert.deepEqual(group(groups, first.id).episodes.map(action), [
        'first-11', 'first-10', 'first-09', 'first-08', 'first-07'
      ], name);
      assert.deepEqual(group(groups, second.id).episodes.map(action), [
        'second-10', 'second-09', 'second-08', 'second-07', 'second-06'
      ], name);
      assert.deepEqual(group(groups, small.id).episodes.map(action), ['small-01', 'small-00'], name);
      assert.equal(group(groups, first.id).truncated, true, name);
      assert.equal(group(groups, second.id).truncated, true, name);
      assert.equal(group(groups, small.id).truncated, false, name);
      assert.throws(() => store.correctionEpisodeEvidencePreviews(
        personal.id,
        [first.id],
        { maxCorrectionsPerFact: 21 }
      ), /correction.*limit.*20/i, name);
    } finally {
      store.close();
    }
  });

  test(`${name} Lens search exposes per-fact correction truncation`, () => {
    const store = createStore();
    try {
      const personal = store.createSpace(`${name}-lens`, SpaceKind.PERSONAL);
      const source = store.addEpisode(personal.id, 'conversation', 'source');
      const bounded = addFact(store, personal.id, source.id, 'bounded-fact');
      const complete = addFact(store, personal.id, source.id, 'complete-fact');
      addCorrections(store, personal.id, bounded.id, 'bounded', 12);
      addCorrections(store, personal.id, complete.id, 'complete', 2);

      const result = new LensQuery(store).searchUserContext({
        personalSpaceId: personal.id,
        query: '-fact',
        includeHistorical: true,
        limit: 2
      });
      const boundedItem = item(result, bounded.id);
      const completeItem = item(result, complete.id);

      assert.deepEqual(boundedItem.correctionEpisodes.map(action), [
        'bounded-11', 'bounded-10', 'bounded-09', 'bounded-08', 'bounded-07'
      ], name);
      assert.equal(boundedItem.correctionEpisodesTruncated, true, name);
      assert.deepEqual(completeItem.correctionEpisodes.map(action), ['complete-01', 'complete-00'], name);
      assert.equal(completeItem.correctionEpisodesTruncated, false, name);
    } finally {
      store.close();
    }
  });
}

function addFact(store, spaceId, sourceEpisodeId, id) {
  return store.addFact({
    id,
    spaceId,
    sourceEpisodeId,
    subject: 'user',
    predicate: 'correction_probe',
    object: id,
    scope: FactScope.PERSONAL
  });
}

function addCorrections(store, spaceId, factId, prefix, count) {
  for (let index = 0; index < count; index += 1) {
    store.addEpisode(spaceId, 'correction', `${prefix} evidence ${index}`, null, {
      kind: 'lens_correction',
      factId,
      action: `${prefix}-${String(index).padStart(2, '0')}`
    });
  }
}

function group(groups, factId) {
  return groups.find((candidate) => candidate.factId === factId);
}

function item(result, factId) {
  return result.facts.find(({ fact }) => fact.id === factId);
}

function action(episode) {
  return episode.metadata.action;
}
