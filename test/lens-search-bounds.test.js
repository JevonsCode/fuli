import assert from 'node:assert/strict';
import test from 'node:test';

import { LensQuery } from '../src/lens/lens-query.js';
import { FactScope, SpaceKind } from '../src/models.js';
import { FileStore, SqliteStore } from '../src/store.js';
import { STORE_METHODS } from '../src/storage/store-port.js';

const DOMAIN_LIMIT = 100;
const LARGE_FIXTURE_FACTS = 300;

test('searchUserContext bounds large searches and targets selected correction history', () => {
  const backing = new FileStore(':memory:');
  const personal = backing.createSpace('me', SpaceKind.PERSONAL);
  const padding = 'x'.repeat(6000);
  for (let index = 0; index < LARGE_FIXTURE_FACTS; index += 1) {
    const source = backing.addEpisode(personal.id, 'conversation', `${padding}-${index}`);
    backing.addFact({
      id: factId(index),
      spaceId: personal.id,
      subject: 'user',
      predicate: 'search_probe',
      object: `needle-${padding}-${index}`,
      sourceEpisodeId: source.id,
      scope: FactScope.PERSONAL,
      validAt: instant(index)
    });
  }
  const correction = backing.addEpisode(
    personal.id,
    'correction',
    'latest correction',
    null,
    { kind: 'lens_correction', factId: factId(LARGE_FIXTURE_FACTS - 1), action: 'replace' }
  );
  const fixtureBytes = Buffer.byteLength(JSON.stringify(
    backing.listFacts({ includeHistorical: true })
  ));
  const calls = { search: [], correction: [], listEpisodes: 0 };
  const store = instrumentStore(backing, calls);

  const result = new LensQuery(store).searchUserContext({
    personalSpaceId: personal.id,
    query: 'needle',
    includeHistorical: true,
    limit: 5
  });

  assert.ok(fixtureBytes > 1_500_000, `fixture was only ${fixtureBytes} bytes`);
  assert.deepEqual(calls.search, [{
    limit: 6,
    returned: 6,
    bytesUnder50k: true,
    objectLimitTruncated: false
  }]);
  assert.equal(calls.listEpisodes, 0);
  const expectedIds = Array.from({ length: 5 }, (_, index) =>
    factId(LARGE_FIXTURE_FACTS - index - 1));
  assert.deepEqual(calls.correction, [expectedIds]);
  assert.deepEqual(result.facts.map(({ fact }) => fact.id), expectedIds);
  assert.deepEqual(result.facts[0].correctionEpisodes.map(({ id }) => id), [correction.id]);
});

test('bounded fact search and correction lookup have FileStore and SQLite parity', () => {
  for (const [name, createStore] of [
    ['FileStore', () => new FileStore(':memory:')],
    ['SQLite', () => new SqliteStore(':memory:')]
  ]) {
    const store = createStore();
    try {
      const personal = store.createSpace(`${name}-me`, SpaceKind.PERSONAL);
      const other = store.createSpace(`${name}-other`, SpaceKind.PERSONAL);
      const source = store.addEpisode(personal.id, 'conversation', 'safe source');
      for (const fact of [
        searchFact('old', personal.id, source.id, '2026-01-01T00:00:00.000Z'),
        searchFact('new-b', personal.id, source.id, '2026-01-03T00:00:00.000Z'),
        searchFact('new-a', personal.id, source.id, '2026-01-03T00:00:00.000Z'),
        { ...searchFact('public', personal.id, source.id, '2026-01-04T00:00:00.000Z'), scope: FactScope.PUBLIC }
      ]) store.addFact(fact);
      const correction = store.addEpisode(personal.id, 'correction', 'safe correction', null, {
        kind: 'lens_correction', factId: 'new-a', action: 'replace'
      });
      store.addEpisode(other.id, 'correction', 'cross-space correction', null, {
        kind: 'lens_correction', factId: 'new-a', action: 'replace'
      });

      const facts = store.searchFacts([personal.id], 'needle', {
        includeHistorical: true,
        scope: FactScope.PERSONAL,
        limit: 2
      });
      const corrections = store.correctionEpisodeEvidencePreviews(
        personal.id,
        facts.map(({ id }) => id)
      );
      const correctionEpisodes = corrections.flatMap(({ episodes }) => episodes);
      const emptyGroup = corrections.find(({ factId }) => factId === 'new-b');

      assert.deepEqual(facts.map(({ id }) => id), ['new-a', 'new-b'], name);
      assert.deepEqual(correctionEpisodes.map(({ id }) => id), [correction.id], name);
      assert.deepEqual(emptyGroup.episodes, [], name);
      assert.equal(emptyGroup.truncated, false, name);
    } finally {
      store.close();
    }
  }
});

test('legacy Lens domain still rejects unsafe direct limits', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('domain-me', SpaceKind.PERSONAL);
  const query = new LensQuery(store);
  assert.throws(() => query.searchUserContext({
    personalSpaceId: personal.id, query: '', limit: DOMAIN_LIMIT + 1
  }), /limit.*between/i);
  assert.throws(() => query.searchUserContext({
    personalSpaceId: personal.id, query: '', limit: 0
  }), /limit.*between/i);
});

function instrumentStore(backing, calls) {
  return {
    ...Object.fromEntries(STORE_METHODS.map((name) => [name, (...args) => backing[name](...args)])),
    searchFactsPage(spaceIds, query, options) {
      const page = backing.searchFactsPage(spaceIds, query, options);
      calls.search.push({
        limit: options.limit,
        returned: page.facts.length,
        bytesUnder50k: Buffer.byteLength(JSON.stringify(page.facts)) < 50_000,
        objectLimitTruncated: page.objectLimitTruncated
      });
      return page;
    },
    listEpisodes() {
      calls.listEpisodes += 1;
      return backing.listEpisodes();
    },
    correctionEpisodeEvidencePreviews(spaceId, factIds, options) {
      calls.correction.push([...factIds]);
      return backing.correctionEpisodeEvidencePreviews(spaceId, factIds, options);
    }
  };
}

function searchFact(id, spaceId, sourceEpisodeId, validAt) {
  return {
    id, spaceId, sourceEpisodeId, validAt,
    subject: 'user', predicate: 'search_probe', object: `needle-${id}`,
    scope: FactScope.PERSONAL
  };
}

function factId(index) {
  return `fact-${String(index).padStart(4, '0')}`;
}

function instant(index) {
  return new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
}
