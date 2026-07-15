import assert from 'node:assert/strict';
import test from 'node:test';

import { LensQuery } from '../src/lens/lens-query.js';
import { FactScope, FactStatus, Sensitivity, SpaceKind } from '../src/models.js';
import { FileStore } from '../src/store.js';

test('getUserLens returns detached facts with only authorized personal relation ids', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('me', SpaceKind.PERSONAL);
  const other = store.createSpace('other', SpaceKind.PERSONAL);
  const personalSource = store.addEpisode(personal.id, 'chat', 'safe personal source');
  const otherSource = store.addEpisode(other.id, 'chat', 'cross-space source');

  const safeReplacement = addReplacement(store, personal.id, personalSource.id, {
    id: 'safe-replacement',
    object: 'safe replacement'
  });
  const restrictedReplacement = addReplacement(store, personal.id, personalSource.id, {
    id: 'restricted-replacement',
    object: 'restricted replacement',
    sensitivity: Sensitivity.RESTRICTED
  });
  const hiddenReplacement = addReplacement(store, personal.id, personalSource.id, {
    id: 'hidden-replacement',
    object: 'token=12345678901234567890'
  });
  const crossReplacement = addReplacement(store, other.id, otherSource.id, {
    id: 'other-space-target',
    object: 'cross replacement'
  });

  const safe = addRelation(store, personal.id, personalSource.id, {
    id: 'safe-relation',
    replacedByFactId: safeReplacement.id
  });
  addRelation(store, personal.id, otherSource.id, {
    id: 'cross-source-relation',
    replacedByFactId: safeReplacement.id
  });
  addRelation(store, personal.id, personalSource.id, {
    id: 'restricted-relation',
    replacedByFactId: restrictedReplacement.id
  });
  addRelation(store, personal.id, personalSource.id, {
    id: 'hidden-relation',
    replacedByFactId: hiddenReplacement.id
  });
  addRelation(store, personal.id, personalSource.id, {
    id: 'boundary-target-relation',
    replacedByFactId: crossReplacement.id
  });

  const query = new LensQuery(store);
  const conservative = query.getUserLens({
    personalSpaceId: personal.id,
    task: 'relation',
    budget: 4096
  });
  const explicit = query.getUserLens({
    personalSpaceId: personal.id,
    task: 'relation',
    budget: 4096,
    includeRestricted: true
  });

  assert.deepEqual(relations(conservative), {
    'boundary-target-relation': [personalSource.id, null],
    'cross-source-relation': [null, safeReplacement.id],
    'hidden-relation': [personalSource.id, null],
    'restricted-relation': [personalSource.id, null],
    'safe-relation': [personalSource.id, safeReplacement.id]
  });
  assert.deepEqual(relations(explicit), {
    'boundary-target-relation': [personalSource.id, null],
    'cross-source-relation': [null, safeReplacement.id],
    'hidden-relation': [personalSource.id, hiddenReplacement.id],
    'restricted-relation': [personalSource.id, restrictedReplacement.id],
    'safe-relation': [personalSource.id, safeReplacement.id]
  });

  const projectedSafe = conservative.facts.find((fact) => fact.id === safe.id);
  assert.notStrictEqual(projectedSafe, store.getFact(safe.id));
  projectedSafe.object = 'mutated projection';
  assert.equal(store.getFact(safe.id).object, 'relation probe safe-relation');
  assert.equal(JSON.stringify(conservative).includes(otherSource.id), false);
  assert.equal(JSON.stringify(conservative).includes(restrictedReplacement.id), false);
  assert.equal(JSON.stringify(conservative).includes(hiddenReplacement.id), false);
  assert.equal(JSON.stringify(explicit).includes(crossReplacement.id), false);
  store.close();
});

function addReplacement(store, spaceId, sourceEpisodeId, overrides) {
  return store.addFact({
    id: overrides.id,
    spaceId,
    subject: 'user',
    predicate: 'previous_value',
    object: overrides.object,
    sourceEpisodeId,
    status: FactStatus.DEPRECATED,
    sensitivity: overrides.sensitivity,
    scope: FactScope.PERSONAL
  });
}

function addRelation(store, spaceId, sourceEpisodeId, overrides) {
  return store.addFact({
    id: overrides.id,
    spaceId,
    subject: 'user',
    predicate: 'relation',
    object: `relation probe ${overrides.id}`,
    sourceEpisodeId,
    replacedByFactId: overrides.replacedByFactId,
    scope: FactScope.PERSONAL
  });
}

function relations(result) {
  return Object.fromEntries(result.facts.map((fact) => [
    fact.id,
    [fact.sourceEpisodeId, fact.replacedByFactId]
  ]));
}
