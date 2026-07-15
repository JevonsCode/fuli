import assert from 'node:assert/strict';
import test from 'node:test';

import { FactService } from '../src/facts/fact-service.js';
import { SpaceKind } from '../src/models.js';
import { FileStore } from '../src/store.js';

test('explicit replacement only invalidates facts for the requested subject', () => {
  const store = new FileStore(':memory:');
  const space = store.createSpace('Shared', SpaceKind.PUBLIC);
  const originalEpisode = store.addEpisode(space.id, 'prd', 'shared old value');
  const alpha = store.addFact({
    spaceId: space.id,
    subject: 'Alpha',
    predicate: 'has_runtime',
    object: 'node-22',
    sourceEpisodeId: originalEpisode.id
  });
  const beta = store.addFact({
    spaceId: space.id,
    subject: 'Beta',
    predicate: 'has_runtime',
    object: 'node-22',
    sourceEpisodeId: originalEpisode.id
  });
  const replacementEpisode = store.addEpisode(space.id, 'prd', 'replace runtime');

  new FactService(store).writeSpecs({
    spaceId: space.id,
    subject: 'Alpha',
    episodeId: replacementEpisode.id,
    specs: [{ kind: 'replacement', oldValue: 'node-22', newValue: 'node-24' }]
  });

  assert.equal(store.getFact(alpha.id).invalidAt !== null, true);
  assert.equal(store.getFact(beta.id).invalidAt, null);
  assert.deepEqual(
    store.currentFacts(space.id).map(({ subject, object }) => ({ subject, object })),
    [{ subject: 'Beta', object: 'node-22' }, { subject: 'Alpha', object: 'node-24' }]
  );
});
