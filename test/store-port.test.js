import assert from 'node:assert/strict';
import test from 'node:test';

import { assertStorePort, STORE_METHODS } from '../src/storage/store-port.js';
import { FileStore } from '../src/store.js';
import { runStoreContract } from './store-contract.js';

test('FileStore implements the complete Store Port', () => {
  const store = new FileStore(':memory:');

  assert.equal(assertStorePort(store), store);
  assert.ok(STORE_METHODS.includes('listSpaces'));
  assert.ok(STORE_METHODS.includes('getEpisode'));
  assert.ok(STORE_METHODS.includes('listFacts'));
  assert.ok(STORE_METHODS.includes('enqueueOutbox'));
});

runStoreContract('FileStore', () => new FileStore(':memory:'));
