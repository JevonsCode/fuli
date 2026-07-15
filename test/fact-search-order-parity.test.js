import assert from 'node:assert/strict';
import test from 'node:test';

import { FactScope, SpaceKind } from '../src/models.js';
import { FileStore, SqliteStore } from '../src/store.js';

const SUPPLEMENTARY_ID = 'fact-\u{10000}';
const BMP_PRIVATE_USE_ID = 'fact-\uE000';
const VALID_AT = '2026-07-11T00:00:00.000Z';

test('bounded fact search uses JavaScript UTF-16 ordering for non-ASCII ID ties', () => {
  const idsByStore = {};

  for (const [name, createStore] of [
    ['FileStore', () => new FileStore(':memory:')],
    ['SQLite', () => new SqliteStore(':memory:')]
  ]) {
    const store = createStore();
    try {
      const space = store.createSpace(`${name}-space`, SpaceKind.PERSONAL);
      const source = store.addEpisode(space.id, 'conversation', 'search source');
      for (const id of [BMP_PRIVATE_USE_ID, SUPPLEMENTARY_ID]) {
        store.addFact({
          id,
          spaceId: space.id,
          sourceEpisodeId: source.id,
          subject: 'user',
          predicate: 'search_probe',
          object: 'ordering needle',
          scope: FactScope.PERSONAL,
          validAt: VALID_AT
        });
      }

      idsByStore[name] = store.searchFacts([space.id], 'needle', {
        includeHistorical: true,
        limit: 1
      }).map(({ id }) => id);
    } finally {
      store.close();
    }
  }

  assert.deepEqual(idsByStore, {
    FileStore: [SUPPLEMENTARY_ID],
    SQLite: [SUPPLEMENTARY_ID]
  });
});
