import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { identityKey } from '../src/text/name-identity.js';

test('the Node identity key matches the Python rule on the shared vectors', () => {
  // graph-provider/tests/test_name_identity.py reads the same pairs.
  const { vectors } = JSON.parse(readFileSync('test/fixtures/name-identity-vectors.json', 'utf8'));
  for (const [value, key] of vectors) assert.equal(identityKey(value), key, JSON.stringify(value));
});
