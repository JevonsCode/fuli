import assert from 'node:assert/strict';
import test from 'node:test';

import { createApplication } from '../src/app/create-application.js';
import { STORE_METHODS } from '../src/storage/store-port.js';
import { FileStore } from '../src/store.js';

test('application services work through Store Port without a data property', () => {
  const store = hideAdapterInternals(new FileStore(':memory:'));
  assert.equal('data' in store, false);
  assert.deepEqual(Object.keys(store).sort(), [...STORE_METHODS].sort());
  const app = createApplication({ store });
  assert.equal(Object.isFrozen(app.agent), true);
  assert.deepEqual(Object.keys(app.agent).sort(), [
    'contextPack',
    'currentFacts',
    'decideCandidate',
    'factHistory',
    'listCandidates',
    'observe',
    'projectRules',
    'remember',
    'search',
    'timeline'
  ]);
  assert.equal('store' in app, false);
  assert.equal('data' in app, false);
  assert.equal(Object.isFrozen(app.publication), true);
  assert.deepEqual(
    Object.keys(app.publication).sort(),
    ['markFailed', 'markSent', 'pending', 'prepare', 'verify']
  );
  const { personal, space } = app.bootstrap();

  app.remember({
    personalSpaceId: personal.id,
    targetSpaceId: space.id,
    sourceKind: 'prd',
    body: 'api_base: https://api.example.com'
  });

  assert.equal(app.state().currentFacts.length, 1);
  assert.equal(app.search({ personalSpaceId: personal.id, query: 'api_base' }).facts.length, 1);
});

test('application exposes narrow agent queries without adapter internals', () => {
  const store = new FileStore(':memory:');
  const app = createApplication({ store });
  const { personal, space } = app.bootstrap();
  app.remember({
    personalSpaceId: personal.id,
    targetSpaceId: space.id,
    sourceKind: 'prd',
    sourceUri: 'prd://application-agent',
    body: 'api_base: https://api.example.com'
  });

  assert.equal(app.agent.currentFacts(space.id)[0].object, 'https://api.example.com');
  assert.equal(app.agent.timeline(space.id, '工作').length, 1);
  assert.equal(app.agent.projectRules(space.id).parameters[0].source.uri, 'prd://application-agent');
  assert.equal(app.agent.factHistory({ spaceId: space.id, predicate: 'api_base' }).facts.length, 1);
  assert.deepEqual(app.agent.listCandidates(personal.id), []);
  assert.equal('store' in app, false);
  assert.equal('databasePath' in app, false);
  assert.equal('snapshot' in app, false);
});

function hideAdapterInternals(store) {
  return Object.fromEntries(
    STORE_METHODS.map((method) => [method, (...args) => store[method](...args)])
  );
}
