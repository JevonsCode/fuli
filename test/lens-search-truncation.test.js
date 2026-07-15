import assert from 'node:assert/strict';
import test from 'node:test';

import { LensQuery } from '../src/lens/lens-query.js';
import { FactScope, SpaceKind } from '../src/models.js';
import { FileStore } from '../src/store.js';

test('bounded Lens search distinguishes exact limits from omitted rows', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('me', SpaceKind.PERSONAL);
  const source = store.addEpisode(personal.id, 'conversation', 'safe source');
  for (const [id, object, validAt] of [
    ['safe-1', 'exact match', '2026-01-02T00:00:00.000Z'],
    ['safe-2', 'exact match', '2026-01-01T00:00:00.000Z'],
    ['secret-id', 'filtered match', '2026-01-03T00:00:00.000Z']
  ]) store.addFact({
    id,
    spaceId: personal.id,
    subject: 'user',
    predicate: 'search_probe',
    object,
    sourceEpisodeId: source.id,
    scope: FactScope.PERSONAL,
    validAt
  });

  const query = new LensQuery(store);
  const exact = query.searchUserContext({
    personalSpaceId: personal.id,
    query: 'exact',
    limit: 2
  });
  const filtered = query.searchUserContext({
    personalSpaceId: personal.id,
    query: 'match',
    limit: 5,
    factFilter: (fact) => fact.id !== 'secret-id'
  });

  assert.equal(exact.truncated, false);
  assert.deepEqual(exact.facts.map(({ fact }) => fact.id), ['safe-1', 'safe-2']);
  assert.equal(filtered.truncated, true);
  assert.deepEqual(filtered.facts.map(({ fact }) => fact.id), ['safe-1', 'safe-2']);
  store.close();
});
