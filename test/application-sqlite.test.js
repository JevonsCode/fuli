import assert from 'node:assert/strict';
import test from 'node:test';

import { createApplication } from '../src/app/create-application.js';
import { SqliteStore } from '../src/store.js';
import { STORE_METHODS } from '../src/storage/store-port.js';

test('SQLite-backed application rolls back a failed command and remains usable', (t) => {
  const store = new SqliteStore(':memory:');
  let failFactWrite = true;
  const wrappedStore = overrideStore(store, {
    addFact(fact) {
      if (failFactWrite) throw new Error('sqlite fact write failed');
      return store.addFact(fact);
    }
  });
  const app = createApplication({ store: wrappedStore });
  t.after(() => app.close());
  const { personal, space } = app.bootstrap();
  const before = store.exportSnapshot();

  assert.throws(
    () => app.remember({
      personalSpaceId: personal.id,
      targetSpaceId: space.id,
      sourceKind: 'prd',
      body: 'runtime: node-24'
    }),
    /sqlite fact write failed/
  );
  assert.deepEqual(store.exportSnapshot(), before);

  failFactWrite = false;
  app.remember({
    personalSpaceId: personal.id,
    targetSpaceId: space.id,
    sourceKind: 'prd',
    body: 'runtime: node-24'
  });
  assert.equal(app.state().currentFacts.length, 1);
  assert.equal(app.search({ personalSpaceId: personal.id, query: 'node-24' }).facts.length, 1);
});

function overrideStore(store, overrides) {
  return Object.fromEntries(
    STORE_METHODS.map((method) => [
      method,
      overrides[method] ?? ((...args) => store[method](...args))
    ])
  );
}
