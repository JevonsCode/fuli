import assert from 'node:assert/strict';
import test from 'node:test';

import { LensQuery } from '../src/lens/lens-query.js';
import { LensResourceService, HISTORY_BUDGET_BYTES } from '../src/lens/lens-resource-service.js';
import { FactScope, FactStatus, SpaceKind } from '../src/models.js';
import { FileStore, SqliteStore } from '../src/store.js';

for (const [name, createStore] of [
  ['FileStore', () => new FileStore(':memory:')],
  ['SQLite', () => new SqliteStore(':memory:')]
]) {
  test(`${name} history truncates only when the object bound omits a matching fact`, () => {
    const store = createStore();
    try {
      const personal = store.createSpace(`${name}-me`, SpaceKind.PERSONAL);
      const source = store.addEpisode(personal.id, 'conversation', 'source');
      const history = new LensResourceService({
        store,
        lens: new LensQuery(store),
        activePersonalSpace: () => personal
      });

      assert.equal(history.history().truncated, false, `${name} empty`);

      addHistoryFact(store, personal.id, source.id, 'small', 'small value');
      const smallPage = store.searchFactsPage([personal.id], '', {
        includeHistorical: true,
        scope: FactScope.PERSONAL,
        maxObjectBytes: HISTORY_BUDGET_BYTES,
        limit: 101
      });
      assert.equal(smallPage.objectLimitTruncated, false, `${name} small page`);
      assert.equal(history.history().truncated, false, `${name} small history`);

      addHistoryFact(
        store,
        personal.id,
        source.id,
        'oversized',
        'x'.repeat(HISTORY_BUDGET_BYTES + 1)
      );
      const oversizedPage = store.searchFactsPage([personal.id], '', {
        includeHistorical: true,
        scope: FactScope.PERSONAL,
        maxObjectBytes: HISTORY_BUDGET_BYTES,
        limit: 101
      });
      assert.deepEqual(oversizedPage.facts.map(({ id }) => id), ['small'], name);
      assert.equal(oversizedPage.objectLimitTruncated, true, `${name} oversized page`);
      assert.equal(history.history().truncated, true, `${name} oversized history`);
    } finally {
      store.close();
    }
  });
}

function addHistoryFact(store, spaceId, sourceEpisodeId, id, object) {
  store.addFact({
    id,
    spaceId,
    sourceEpisodeId,
    subject: 'user',
    predicate: 'history_probe',
    object,
    scope: FactScope.PERSONAL,
    status: FactStatus.DEPRECATED,
    invalidAt: '2026-01-02T00:00:00.000Z'
  });
}
