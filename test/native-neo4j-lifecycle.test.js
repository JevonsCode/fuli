import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { requiresSymlinks, requiresUnixNativeAssets } from '../test-support/platform-capabilities.js';
import { manageNativeNeo4j, planNativeNeo4j } from '../src/native-runtime/neo4j-lifecycle.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { NATIVE_NEO4J_VERSION } from '../src/native-runtime/runtime.js';
async function fixture(t, fault = '') {
  const root = await mkdtemp(join(tmpdir(), 'fuli-asset-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveSetupPaths({ dataDir: root });
  await mkdir(join(paths.nativeNeo4jHome, 'bin'), { recursive: true });
  await writeFile(join(paths.nativeNeo4jHome, 'bin', 'neo4j'), 'synthetic-old');
  await mkdir(join(paths.nativePersonalDir, 'data'), { recursive: true });
  await writeFile(join(paths.nativePersonalDir, 'data', 'sentinel'), 'keep-data');
  const current = { version: 1, status: 'ready', mode: 'native', neo4jVersion: NATIVE_NEO4J_VERSION,
    neo4jHome: paths.nativeNeo4jHome, javaHome: '/synthetic/jdk', providerPython: '/synthetic/python' };
  await writeFile(paths.nativeRuntimeManifestPath, JSON.stringify(current));
  const events = [];
  const deps = {
    platform: 'darwin',
    install: async ({ home }) => { events.push('stage'); await mkdir(join(home, 'bin'), { recursive: true }); await writeFile(join(home, 'bin', 'neo4j'), 'synthetic-new'); },
    runtime: { consoleRunning: async () => false, stop: async () => { events.push('stop-runtime'); return { status: fault === 'stop-old' ? 'partial' : 'stopped' }; }, start: async () => { events.push('start-console'); } },
    assertStopped: async () => {},
    checkRuntime: async () => {},
    storeFormats: async () => ({ 'personal:neo4j': 'record-aligned-1.1' }),
    services: descriptor => ({
      start: async () => { const next = descriptor.neo4jHome !== paths.nativeNeo4jHome; events.push(next ? 'start-new' : 'start-old'); if (next && ['health', 'stop-new'].includes(fault)) throw new Error('injected new health failure'); },
      checkDatabaseHealth: async () => { events.push('health'); },
      stopDatabases: async () => { events.push(descriptor.neo4jHome !== paths.nativeNeo4jHome ? 'stop-new' : 'stop-old'); if (fault === 'stop-new') throw new Error('injected new stop failure'); }
    })
  };
  const manifest = async () => JSON.parse(await readFile(paths.nativeRuntimeManifestPath, 'utf8'));
  return { paths, current, deps, events, manifest };
}
test('preview is read-only and does not stage or stop', async t => {
  const f = await fixture(t); const before = await readFile(f.paths.nativeRuntimeManifestPath);
  const preview = await planNativeNeo4j({ paths: f.paths, action: 'update' });
  assert.equal(preview.neo4jVersion, NATIVE_NEO4J_VERSION);
  assert.deepEqual(await readFile(f.paths.nativeRuntimeManifestPath), before); assert.deepEqual(f.events, []);
});
test('update stages new assets before stopping and rollback restores the retained exact copy', async t => {
  const f = await fixture(t);
  await manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps);
  const next = await f.manifest();
  assert.notEqual(next.neo4jHome, f.current.neo4jHome);
  assert.ok(f.events.indexOf('stage') < f.events.indexOf('stop-runtime'));
  assert.equal(next.previousNeo4jAsset.home, f.current.neo4jHome);
  await manageNativeNeo4j({ paths: f.paths, action: 'rollback' }, f.deps);
  assert.equal((await f.manifest()).neo4jHome, f.current.neo4jHome);
  assert.equal(await readFile(join(f.paths.nativePersonalDir, 'data', 'sentinel'), 'utf8'), 'keep-data');
});
test('failed candidate health stops it before restoring the old descriptor and process', async t => {
  const f = await fixture(t, 'health');
  await assert.rejects(manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps), /restored/i);
  assert.equal((await f.manifest()).neo4jHome, f.current.neo4jHome);
  assert.ok(f.events.indexOf('stop-new') < f.events.indexOf('start-old'));
});
test('unconfirmed candidate stop blocks restoration and preserves recovery evidence', async t => {
  const f = await fixture(t, 'stop-new');
  await assert.rejects(manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps), /attention|stop/i);
  assert.notEqual((await f.manifest()).neo4jHome, f.current.neo4jHome);
  assert.ok(!f.events.includes('start-old'));
  await assert.rejects(manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps), /recovery|transaction/i);
});
test('failed old stop leaves the descriptor unchanged', async t => {
  const f = await fixture(t, 'stop-old');
  await assert.rejects(manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps), /stop/i);
  assert.deepEqual(await f.manifest(), f.current); assert.ok(!f.events.includes('start-new'));
});
test('uninstall removes managed Neo4j assets and retains external instance data', requiresUnixNativeAssets, async t => {
  const f = await fixture(t);
  await manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps);
  await manageNativeNeo4j({ paths: f.paths, action: 'uninstall' }, f.deps);
  await assert.rejects(readFile(join(f.current.neo4jHome, 'bin', 'neo4j')), /ENOENT/);
  assert.equal(await readFile(join(f.paths.nativePersonalDir, 'data', 'sentinel'), 'utf8'), 'keep-data');
  assert.equal((await f.manifest()).status, 'uninstalled');
});
test('changed rollback asset is refused before stopping anything', async t => {
  const f = await fixture(t); await manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps);
  await writeFile(join(f.current.neo4jHome, 'bin', 'neo4j'), 'modified'); f.events.length = 0;
  await assert.rejects(manageNativeNeo4j({ paths: f.paths, action: 'rollback' }, f.deps), /changed|integrity/i);
  assert.ok(!f.events.includes('stop-runtime'));
});
test('different Neo4j version is refused before staging or stopping', async t => {
  const f = await fixture(t); await writeFile(f.paths.nativeRuntimeManifestPath, JSON.stringify({ ...f.current, neo4jVersion: '5.26.0' }));
  await assert.rejects(manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps), /version|migration/i);
  assert.deepEqual(f.events, []);
});

test('changed store format blocks user rollback without replacing the manifest or data', async t => {
  const f = await fixture(t); await manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps);
  const selected = await readFile(f.paths.nativeRuntimeManifestPath);
  await assert.rejects(manageNativeNeo4j({ paths: f.paths, action: 'rollback' }, {
    ...f.deps, storeFormats: async () => ({ 'personal:neo4j': 'unknown-new-format' })
  }), /storage format changed/i);
  assert.deepEqual(await readFile(f.paths.nativeRuntimeManifestPath), selected);
});
test('concurrent descriptor changes are preserved and never cause an old process restart', async t => {
  const f = await fixture(t); const services = f.deps.services;
  f.deps.services = descriptor => ({ ...services(descriptor), checkDatabaseHealth: async () => {
    const value = await f.manifest(); await writeFile(f.paths.nativeRuntimeManifestPath, JSON.stringify({ ...value, foreign: true }));
  } });
  await assert.rejects(manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps), /concurrently/);
  assert.equal((await f.manifest()).foreign, true); assert.ok(!f.events.includes('start-old'));
});
test('uninstall removes every created asset generation while preserving data', requiresUnixNativeAssets, async t => {
  const f = await fixture(t); const homes = [f.current.neo4jHome];
  for (let i = 0; i < 3; i++) { await manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps); homes.push((await f.manifest()).neo4jHome); }
  await manageNativeNeo4j({ paths: f.paths, action: 'uninstall' }, f.deps);
  for (const home of homes) await assert.rejects(readFile(join(home, 'bin', 'neo4j')), /ENOENT/);
});

test('offline inspection failure resumes the previously running console without changing assets', async t => {
  const f = await fixture(t); f.deps.runtime.consoleRunning = async () => true;
  f.deps.storeFormats = async () => { throw new Error('injected inspection failure'); };
  await assert.rejects(manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps), /inspection failure/);
  assert.deepEqual(await f.manifest(), f.current);
  assert.ok(f.events.includes('start-console'));
});

test('a symbolic-link asset parent cannot redirect candidate installation outside the runtime', requiresSymlinks, async t => {
  const { symlink } = await import('node:fs/promises');
  const f = await fixture(t); const outside = await mkdtemp(join(tmpdir(), 'fuli-assets-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(f.paths.nativeRuntimeDir, 'neo4j-assets'));
  await assert.rejects(manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps), /symbolic|link/i);
  assert.deepEqual(f.events, []);
});

test('a console requiring separate setup is rejected before staging or stopping', async t => {
  const f = await fixture(t); f.deps.runtime.consoleRunning = async () => true;
  f.deps.checkRuntime = async () => { throw new Error('asset-only operation requires separate setup'); };
  await assert.rejects(manageNativeNeo4j({ paths: f.paths, action: 'update' }, f.deps), /separate setup/);
  assert.deepEqual(f.events, []);
});
