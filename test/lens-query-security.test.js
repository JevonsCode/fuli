import assert from 'node:assert/strict';
import test from 'node:test';

import { LensQuery } from '../src/lens/lens-query.js';
import { FactScope, FactStatus, Sensitivity, SpaceKind } from '../src/models.js';
import { FileStore } from '../src/store.js';
import { STORE_METHODS } from '../src/storage/store-port.js';

test('default Lens excludes malformed rejected, deprecated, restricted, and detected-secret facts', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const episode = store.addEpisode(personal.id, 'legacy', 'legacy facts');
  const safe = addFact(store, personal.id, episode.id, 'safe', FactStatus.CONFIRMED);
  addFact(store, personal.id, episode.id, 'rejected', FactStatus.REJECTED);
  addFact(store, personal.id, episode.id, 'deprecated', FactStatus.DEPRECATED);
  addFact(store, personal.id, episode.id, 'private boundary', FactStatus.CONFIRMED, Sensitivity.RESTRICTED);
  addFact(store, personal.id, episode.id, 'sk-live-12345678901234567890', FactStatus.CONFIRMED);
  const query = new LensQuery(store);

  const compact = query.getUserLens({
    personalSpaceId: personal.id,
    task: '',
    budget: 1000,
    includeSuggested: true
  });
  const search = query.searchUserContext({ personalSpaceId: personal.id, query: '' });
  const explicitSearch = query.searchUserContext({
    personalSpaceId: personal.id,
    query: '',
    includeRestricted: true
  });
  const explicit = query.getUserLens({
    personalSpaceId: personal.id,
    task: '',
    budget: 1000,
    includeRestricted: true
  });

  assert.deepEqual(compact.facts.map((fact) => fact.object), [safe.object]);
  assert.deepEqual(search.facts.map((item) => item.fact.object), [safe.object]);
  assert.deepEqual(
    explicitSearch.facts.map((item) => item.fact.object).sort(),
    ['private boundary', safe.object, 'sk-live-12345678901234567890'].sort()
  );
  assert.deepEqual(
    explicit.facts.map((fact) => fact.object).sort(),
    ['private boundary', safe.object, 'sk-live-12345678901234567890'].sort()
  );
  store.close();
});

test('searchUserContext blocks cross-space nested records without listing all episodes', () => {
  const baseStore = new FileStore(':memory:');
  const personal = baseStore.createSpace('我', SpaceKind.PERSONAL);
  const other = baseStore.createSpace('另一人', SpaceKind.PERSONAL);
  const personalEpisode = baseStore.addEpisode(personal.id, 'legacy', 'personal source');
  const otherEpisode = baseStore.addEpisode(other.id, 'legacy', 'other source');
  const otherFact = baseStore.addFact({
    id: 'other-fact',
    spaceId: other.id,
    subject: 'other',
    predicate: 'knows',
    object: 'other secret',
    sourceEpisodeId: otherEpisode.id,
    scope: FactScope.PERSONAL
  });
  const leaking = baseStore.addFact({
    id: 'personal-leaking',
    spaceId: personal.id,
    subject: 'user',
    predicate: 'knows',
    object: 'needle',
    sourceEpisodeId: otherEpisode.id,
    replacedByFactId: otherFact.id,
    scope: FactScope.PERSONAL
  });
  const publicReplacement = baseStore.addFact({
    id: 'personal-public',
    spaceId: personal.id,
    subject: 'user',
    predicate: 'knows',
    object: 'public replacement',
    sourceEpisodeId: personalEpisode.id,
    scope: FactScope.PUBLIC
  });
  baseStore.addFact({
    id: 'personal-scope-leaking',
    spaceId: personal.id,
    subject: 'user',
    predicate: 'knows',
    object: 'needle two',
    sourceEpisodeId: personalEpisode.id,
    replacedByFactId: publicReplacement.id,
    scope: FactScope.PERSONAL
  });
  const validCorrection = baseStore.addEpisode(personal.id, 'correction', 'valid correction', null, {
    kind: 'lens_correction', factId: leaking.id, action: 'reject'
  });
  baseStore.addEpisode(other.id, 'correction', 'cross-space correction', null, {
    kind: 'lens_correction', factId: leaking.id, action: 'reject'
  });
  baseStore.addEpisode(personal.id, 'correction', 'wrong fact correction', null, {
    kind: 'lens_correction', factId: otherFact.id, action: 'reject'
  });
  let episodeLists = 0;
  const store = overrideStore(baseStore, {
    listEpisodes() {
      episodeLists += 1;
      return baseStore.listEpisodes();
    }
  });

  const result = new LensQuery(store).searchUserContext({
    personalSpaceId: personal.id,
    query: 'needle',
    includeHistorical: true,
    includeRestricted: true
  });

  assert.equal(result.facts.length, 2);
  const crossSpace = result.facts.find((item) => item.fact.id === leaking.id);
  const crossScope = result.facts.find((item) => item.fact.id === 'personal-scope-leaking');
  assert.equal(crossSpace.sourceEpisode, null);
  assert.equal(crossSpace.replacementFact, null);
  assert.equal(crossSpace.fact.sourceEpisodeId, null);
  assert.equal(crossSpace.fact.replacedByFactId, null);
  assert.deepEqual(crossSpace.correctionEpisodes.map((episode) => episode.id), [validCorrection.id]);
  assert.equal(crossScope.replacementFact, null);
  assert.equal(crossScope.fact.sourceEpisodeId, crossScope.sourceEpisode.id);
  assert.equal(crossScope.fact.replacedByFactId, null);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(otherEpisode.id), false);
  assert.equal(serialized.includes(otherFact.id), false);
  assert.equal(serialized.includes(publicReplacement.id), false);
  assert.equal(episodeLists, 0);
  baseStore.close();
});

test('only boolean true opts into sensitive nested source retrieval', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const episode = store.addEpisode(
    personal.id,
    'legacy',
    'token=12345678901234567890'
  );
  addFact(store, personal.id, episode.id, 'safe projection', FactStatus.CONFIRMED);
  const query = new LensQuery(store);

  const stringFlag = query.searchUserContext({
    personalSpaceId: personal.id,
    query: 'safe projection',
    includeRestricted: 'true'
  });
  const explicit = query.searchUserContext({
    personalSpaceId: personal.id,
    query: 'safe projection',
    includeRestricted: true
  });

  assert.equal(stringFlag.facts[0].sourceEpisode, null);
  assert.equal(stringFlag.facts[0].fact.sourceEpisodeId, null);
  assert.equal(JSON.stringify(stringFlag).includes(episode.id), false);
  assert.equal(explicit.facts[0].sourceEpisode.id, episode.id);
  assert.equal(explicit.facts[0].fact.sourceEpisodeId, explicit.facts[0].sourceEpisode.id);
  store.close();
});

test('search DTO redacts sensitive replacement ids unless explicitly visible', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const episode = store.addEpisode(personal.id, 'legacy', 'safe relation source');
  const restrictedReplacement = store.addFact({
    id: 'restricted-replacement',
    spaceId: personal.id,
    subject: 'user',
    predicate: 'legacy_state',
    object: 'private replacement',
    sourceEpisodeId: episode.id,
    sensitivity: Sensitivity.RESTRICTED,
    scope: FactScope.PERSONAL
  });
  store.addFact({
    id: 'relation-source',
    spaceId: personal.id,
    subject: 'user',
    predicate: 'legacy_state',
    object: 'relation probe',
    sourceEpisodeId: episode.id,
    replacedByFactId: restrictedReplacement.id,
    scope: FactScope.PERSONAL
  });
  const query = new LensQuery(store);

  const conservative = query.searchUserContext({
    personalSpaceId: personal.id,
    query: 'relation probe'
  });
  const explicit = query.searchUserContext({
    personalSpaceId: personal.id,
    query: 'relation probe',
    includeRestricted: true
  });

  assert.equal(conservative.facts[0].replacementFact, null);
  assert.equal(conservative.facts[0].fact.replacedByFactId, null);
  assert.equal(JSON.stringify(conservative).includes(restrictedReplacement.id), false);
  assert.equal(explicit.facts[0].replacementFact.id, restrictedReplacement.id);
  assert.equal(
    explicit.facts[0].fact.replacedByFactId,
    explicit.facts[0].replacementFact.id
  );
  store.close();
});

test('sensitive episode sourceKind requires explicit retrieval without weakening space isolation', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const other = store.createSpace('另一人', SpaceKind.PERSONAL);
  const source = store.addEpisode(
    personal.id,
    'token=12345678901234567890',
    'safe source body'
  );
  const fact = addFact(store, personal.id, source.id, 'source kind projection', FactStatus.CONFIRMED);
  const correction = store.addEpisode(
    personal.id,
    'token=12345678901234567890',
    'safe correction body',
    null,
    { kind: 'lens_correction', factId: fact.id, action: 'reject' }
  );
  store.addEpisode(
    other.id,
    'token=12345678901234567890',
    'cross-space correction body',
    null,
    { kind: 'lens_correction', factId: fact.id, action: 'reject' }
  );
  const query = new LensQuery(store);

  const conservative = query.searchUserContext({
    personalSpaceId: personal.id,
    query: 'source kind projection'
  });
  const explicit = query.searchUserContext({
    personalSpaceId: personal.id,
    query: 'source kind projection',
    includeRestricted: true
  });

  assert.equal(conservative.facts[0].sourceEpisode, null);
  assert.deepEqual(conservative.facts[0].correctionEpisodes, []);
  assert.equal(explicit.facts[0].sourceEpisode.id, source.id);
  assert.deepEqual(
    explicit.facts[0].correctionEpisodes.map((episode) => episode.id),
    [correction.id]
  );
  store.close();
});

function addFact(store, spaceId, sourceEpisodeId, object, status, sensitivity = Sensitivity.NORMAL) {
  return store.addFact({
    spaceId,
    subject: 'user',
    predicate: 'legacy_state',
    object,
    sourceEpisodeId,
    status,
    sensitivity,
    scope: FactScope.PERSONAL
  });
}

function overrideStore(store, overrides) {
  return Object.fromEntries(STORE_METHODS.map((method) => [
    method,
    overrides[method] ?? ((...args) => store[method](...args))
  ]));
}
