import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CapturePolicyStore,
  capturePolicyPathForRuntime
} from '../src/graphiti/capture-policy.js';

test('capture policy defaults to enabled and is shared across runtime processes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  const first = new CapturePolicyStore(path, { now: () => '2026-07-22T10:00:00.000Z' });
  const second = new CapturePolicyStore(path);

  assert.deepEqual(first.read(), { enabled: true, updatedAt: null });
  assert.deepEqual(first.update({ enabled: false }), {
    enabled: false,
    updatedAt: '2026-07-22T10:00:00.000Z'
  });
  assert.deepEqual(second.read(), {
    enabled: false,
    updatedAt: '2026-07-22T10:00:00.000Z'
  });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
});

test('capture policy accepts only an explicit boolean', () => {
  const store = new CapturePolicyStore();
  assert.throws(() => store.update({ enabled: 'false' }), /must be a boolean/);
  assert.throws(() => store.update({}), /must be a boolean/);
});

test('capture policy lives beside the shared graph runtime configuration', () => {
  assert.equal(
    capturePolicyPathForRuntime('/data/fuli/graph-runtime.json'),
    '/data/fuli/capture-policy.json'
  );
});
