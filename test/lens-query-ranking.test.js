import assert from 'node:assert/strict';
import test from 'node:test';

import { LensQuery } from '../src/lens/lens-query.js';
import { SpaceKind } from '../src/models.js';
import { FileStore } from '../src/store.js';

test('task ranking matches cart tokens exactly rather than matching cartography substrings', () => {
  const { store, personal, episode } = setup();
  addFact(store, personal.id, episode.id, 'fact-a', 'topic', 'cartography');
  addFact(store, personal.id, episode.id, 'fact-z', 'topic', 'cart');

  const result = new LensQuery(store).getUserLens({
    personalSpaceId: personal.id,
    task: 'cart',
    budget: 1000
  });

  assert.deepEqual(result.facts.map((fact) => fact.id), ['fact-z', 'fact-a']);
  store.close();
});

test('task ranking splits predicate underscores and hyphens into exact tokens', () => {
  const { store, personal, episode } = setup();
  addFact(store, personal.id, episode.id, 'fact-a', 'topic', 'smallish moduleship');
  addFact(store, personal.id, episode.id, 'fact-z', 'prefers_small_modules', 'yes');
  addFact(store, personal.id, episode.id, 'fact-b', 'topic', 'riskier tolerances');
  addFact(store, personal.id, episode.id, 'fact-y', 'has-risk-tolerance', 'low');
  const query = new LensQuery(store);

  const underscored = query.getUserLens({
    personalSpaceId: personal.id,
    task: 'small modules',
    budget: 1000
  });
  const hyphenated = query.getUserLens({
    personalSpaceId: personal.id,
    task: 'risk tolerance',
    budget: 1000
  });

  assert.equal(underscored.facts[0].id, 'fact-z');
  assert.equal(hyphenated.facts[0].id, 'fact-y');
  store.close();
});

function setup() {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const episode = store.addEpisode(personal.id, 'legacy', 'ranking');
  return { store, personal, episode };
}

function addFact(store, spaceId, sourceEpisodeId, id, predicate, object) {
  return store.addFact({
    id,
    spaceId,
    subject: 'user',
    predicate,
    object,
    sourceEpisodeId,
    validAt: '2026-07-10T00:00:00.000Z'
  });
}
