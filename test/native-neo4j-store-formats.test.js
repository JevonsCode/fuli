import assert from 'node:assert/strict';
import test from 'node:test';
import { readNeo4jStoreFormats } from '../src/native-runtime/neo4j-store-formats.js';
const paths = { nativePersonalDir: '/synthetic/personal', nativeWorkspaceDir: '/synthetic/workspace' };
test('offline store inspection keeps format identities and refuses a live or recovering store', async () => {
  const descriptor = { neo4jHome: '/synthetic/assets', javaHome: '/synthetic/jdk' };
  const row = { databaseName: 'neo4j', inUse: 'false', storeFormat: 'record-aligned-1.1', recoveryRequired: 'false' };
  const deps = { instances: ['personal'], exists: () => true, run: async () => ({ stdout: JSON.stringify(row) }) };
  assert.deepEqual(await readNeo4jStoreFormats(paths, descriptor, deps), { 'personal:neo4j': 'record-aligned-1.1' });
  for (const change of [{ inUse: 'true' }, { recoveryRequired: 'true' }, { storeFormat: null }]) {
    await assert.rejects(readNeo4jStoreFormats(paths, descriptor, { ...deps, run: async () => ({ stdout: JSON.stringify({ ...row, ...change }) }) }), /store|format|recovery/i);
  }
});
