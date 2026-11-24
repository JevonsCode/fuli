import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withNativeAssetOperation } from '../src/native-runtime/neo4j-asset-state.js';
import { acquireNeo4jLifecycleLock } from '../src/native-runtime/neo4j-lifecycle-lock.js';
import { createNativeGraphServices } from '../src/native-runtime/runtime.js';
test('service start and ordinary work cannot pass an active lifecycle lease', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-asset-lease-')); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { nativeRuntimeDir: root, nativeRuntimeManifestPath: join(root, 'manifest.json') };
  const lock = await acquireNeo4jLifecycleLock(root);
  try {
    await assert.rejects(withNativeAssetOperation(paths, {}, async () => assert.fail('must not enter')), /in progress/);
    await assert.rejects(createNativeGraphServices({ paths, platform: 'darwin', env: {}, readText: () => assert.fail('must not prepare') }).start(), /in progress/);
    await withNativeAssetOperation(paths, { FULI_NATIVE_ASSET_OPERATION: lock.token }, async () => {});
  } finally { await lock.release(); }
  let release, entered; const inside = new Promise(resolve => { entered = resolve; });
  const ordinary = withNativeAssetOperation(paths, {}, async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await inside;
  try { await assert.rejects(acquireNeo4jLifecycleLock(root), /lock/i); }
  finally { release(); await ordinary; }
});

test('a recovery journal created while acquiring the lease blocks the critical section', async t => {
  const fs = await import('node:fs/promises'); const { syncBuiltinESMExports } = await import('node:module');
  const root = await mkdtemp(join(tmpdir(), 'fuli-lease-journal-race-')); t.after(() => rm(root, { recursive: true, force: true }));
  // The lock appears by a rename of its prepared directory (neo4j-lifecycle-lock.js).
  const paths = { nativeRuntimeDir: root }, rename = fs.default.rename;
  t.mock.method(fs.default, 'rename', async (...args) => {
    const result = await rename(...args);
    if (args[1] === join(root, '.neo4j-lifecycle.lock')) await fs.writeFile(join(root, 'neo4j-transaction.json'), '{}');
    return result;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(withNativeAssetOperation(paths, {}, async () => {}), /recovery|transaction/i); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('a lease records what a later recovery needs beside its holder, and the holder\'s own facts win', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-lease-details-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { readFile } = await import('node:fs/promises');
  const restorePoint = { path: '/x/backups/graph/before-import-1', instances: ['personal'], loading: ['personal'] };
  let holder;
  await withNativeAssetOperation({ nativeRuntimeDir: root }, {}, async () => {
    holder = JSON.parse(await readFile(join(root, '.neo4j-lifecycle.lock', 'holder.json'), 'utf8'));
  }, { operation: 'load', holder: { restorePoint, pid: 1, operation: 'start' } });
  assert.deepEqual(holder.restorePoint, restorePoint);
  assert.equal(holder.operation, 'load');
  assert.equal(holder.pid, process.pid);
});
