import assert from 'node:assert/strict';
import test from 'node:test';

import { StateService } from '../src/app/state-service.js';
import { SpaceKind } from '../src/models.js';
import { FileStore } from '../src/store.js';

test('StateService separates current and historical facts', () => {
  const { store, space, current, historical } = createStateFixture();

  const state = new StateService(store).build();

  assert.deepEqual(state.currentFacts.map((fact) => fact.id), [current.id]);
  assert.deepEqual(state.historicalFacts.map((fact) => fact.id), [historical.id]);
  assert.equal(state.currentFacts[0].spaceName, space.name);
  assert.equal(state.historicalFacts[0].episode.id, historical.sourceEpisodeId);
});

test('StateService returns state detached from persisted records', () => {
  const { store, current } = createStateFixture();
  const service = new StateService(store);
  const state = service.build();

  state.spaces[0].name = 'Changed';
  state.episodes[0].body = 'Changed';
  state.currentFacts[0].object = 'Changed';
  state.currentFacts[0].episode.body = 'Changed';
  state.spaces.push({ id: 'external' });

  const rebuilt = service.build();
  assert.equal(rebuilt.spaces.length, 1);
  assert.equal(rebuilt.spaces[0].name, 'Project A');
  assert.notEqual(rebuilt.episodes[0].body, 'Changed');
  assert.equal(rebuilt.currentFacts[0].object, current.object);
  assert.notEqual(rebuilt.currentFacts[0].episode.body, 'Changed');
});

function createStateFixture() {
  const store = new FileStore(':memory:');
  const space = store.createSpace('Project A', SpaceKind.PUBLIC);
  const oldEpisode = store.addEpisode(space.id, 'prd', 'runtime: node-22');
  const newEpisode = store.addEpisode(space.id, 'prd', 'runtime: node-24');
  const historical = store.addFact({
    spaceId: space.id,
    subject: space.name,
    predicate: 'has_runtime',
    object: 'node-22',
    sourceEpisodeId: oldEpisode.id
  });
  const current = store.addFact({
    spaceId: space.id,
    subject: space.name,
    predicate: 'has_runtime',
    object: 'node-24',
    sourceEpisodeId: newEpisode.id
  });
  store.invalidateFact(historical.id, current.id);
  return { store, space, current, historical };
}
