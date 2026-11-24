import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  exportGraphData,
  importGraphData,
  readGraphBackupManifest
} from '../src/backup/graph-backup.js';
import { graphImportCommand } from '../src/backup/unfinished-import.js';

test('graph export creates one checksummed portable bundle for either runtime mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-graph-export-'));
  const outputDir = join(root, 'portable-backup');
  const lifecycle = [];
  const adapter = {
    async stop() { lifecycle.push('stop'); return { resume: true }; },
    async selection() { return { personalSpaceId: 'personal-space-1' }; },
    async dump(instance, destination) {
      await writeFile(destination, `graph:${instance}`);
    },
    async start() { lifecycle.push('start'); }
  };

  const result = await exportGraphData({
    outputDir,
    sourceMode: 'container',
    instances: ['personal', 'workspace'],
    adapter,
    now: () => new Date('2026-08-18T12:00:00.000Z')
  });
  const manifest = await readGraphBackupManifest(outputDir);

  assert.equal(result.status, 'exported');
  assert.equal(manifest.format, 'fuli-neo4j-backup');
  assert.equal(manifest.sourceMode, 'container');
  assert.deepEqual(manifest.selection, { personalSpaceId: 'personal-space-1' });
  assert.deepEqual(manifest.instances.map(({ id, file }) => ({ id, file })), [
    { id: 'personal', file: 'personal.dump' },
    { id: 'workspace', file: 'workspace.dump' }
  ]);
  assert.equal(manifest.instances.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)), true);
  assert.deepEqual(lifecycle, ['stop', 'start']);
});

test('graph import verifies every checksum before stopping the target runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-graph-import-'));
  const bundle = join(root, 'bundle');
  await exportGraphData({
    outputDir: bundle,
    sourceMode: 'native',
    instances: ['personal'],
    adapter: {
      async stop() { return { resume: false }; },
      async dump(_instance, destination) { await writeFile(destination, 'valid-data'); },
      async start() {}
    }
  });
  await writeFile(join(bundle, 'personal.dump'), 'tampered-data');
  let stopped = false;

  await assert.rejects(importGraphData({
    inputDir: bundle,
    targetMode: 'container',
    rollbackDir: join(root, 'rollback'),
    adapter: {
      async stop() { stopped = true; return { resume: false }; },
      async dump() {},
      async load() {},
      async start() {}
    }
  }), /checksum/i);
  assert.equal(stopped, false);
});

// A bundle of new graph data, and a target adapter whose loads, lease and
// starts are recorded in [events] in order. [fails] decides which loads fail
// (rollback: a load of the copy taken before the import).
async function importScene(prefix, { instances = ['personal', 'workspace'], fails = () => false, before = instances,
  record = async () => {}, setAside, locked = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await exportGraphData({ outputDir: join(root, 'source'), sourceMode: 'container', instances,
    adapter: { async stop() { return { resume: false }; }, async dump(instance, destination) { await writeFile(destination, `new:${instance}`); }, async start() {} } });
  const events = [];
  const lease = { locked, async record(patch) { await record(patch); events.push({ record: patch }); },
    async release() { events.push('release'); }, async restoreFailed(from, error) { events.push({ restoreFailed: error.message, from }); } };
  const adapter = {
    async stop() { return { resume: true }; },
    async hasData(instance) { return before.includes(instance); },
    async dump(instance, destination) { await writeFile(destination, `old:${instance}`); },
    async holdImport(details) { events.push({ hold: details }); return lease; },
    async load(instance, source) {
      const body = await readFile(source, 'utf8');
      events.push(`load ${body}`);
      if (fails(instance, body.startsWith('old:'))) throw new Error(`load of ${body} failed`);
    },
    ...(setAside ? { async setAside(instance) { events.push(`set aside ${instance}`); await setAside(instance); } } : {}),
    async start() { events.push('start'); }
  };
  return { root, adapter, events, run: () => importGraphData({ inputDir: join(root, 'source'), targetMode: 'native', rollbackDir: join(root, 'rollback'), adapter,
    freeSpace: async () => 3 * 1024 ** 2 }) };
}

const states = events => events.filter(event => event.record?.graphStates).map(event => event.record.graphStates);

test('failed graph import rolls back under the one lease it took first, then releases it and starts', async () => {
  const scene = await importScene('fuli-graph-rollback-', { fails: (instance, rollback) => instance === 'workspace' && !rollback });
  await assert.rejects(scene.run(), /load of new:workspace failed.+每个图谱都已退回导入前的数据.+Every graph is back/s);
  const [hold] = scene.events;
  // The lease is taken once, before the first write: it names the copy this import took first and every graph untouched.
  assert.match(hold.hold.restorePoint.path, /[\\/]rollback[\\/]before-import-/);
  assert.deepEqual([hold.hold.restorePoint.instances, hold.hold.restorePoint.loading], [['personal', 'workspace'], ['personal', 'workspace']]);
  assert.deepEqual(hold.hold.graphStates, { personal: 'untouched', workspace: 'untouched' });
  assert.deepEqual((await readGraphBackupManifest(hold.hold.restorePoint.path)).instances.map(({ id }) => id), ['personal', 'workspace']);
  assert.equal(scene.events.filter(event => event.hold).length, 1, 'one lease for the whole import and its rollback');
  // Each graph's state is recorded before it is written, and once it is written, failed or back.
  assert.deepEqual(scene.events.slice(1).map(event => typeof event === 'string' ? event : event.record.graphStates ?? event.record), [
    { personal: 'writing', workspace: 'untouched' }, 'load new:personal',
    { personal: 'imported', workspace: 'untouched' },
    { personal: 'imported', workspace: 'writing' }, 'load new:workspace',
    { personal: 'imported', workspace: 'importFailed' },
    { personal: 'restoring', workspace: 'importFailed' }, 'load old:personal',
    { personal: 'restored', workspace: 'importFailed' },
    { personal: 'restored', workspace: 'restoring' }, 'load old:workspace',
    { personal: 'restored', workspace: 'restored' },
    { restored: true },
    'release', 'start'
  ]);
});

test('a graph the import never wrote stays as it is when the import rolls back', async () => {
  const scene = await importScene('fuli-graph-rollback-first-', { fails: (instance, rollback) => instance === 'personal' && !rollback });
  await assert.rejects(scene.run(), /load of new:personal failed/);
  assert.deepEqual(scene.events.filter(event => typeof event === 'string'), ['load new:personal', 'load old:personal', 'release', 'start']);
  assert.deepEqual(states(scene.events).at(-1), { personal: 'restored', workspace: 'untouched' });
});

test('a rollback that fails keeps the lease and starts nothing, records why, and says how to recover', async () => {
  const scene = await importScene('fuli-graph-rollback-failed-', { fails: (instance, rollback) => (instance === 'workspace') !== rollback });
  await assert.rejects(scene.run(), (error) => {
    assert.equal(error.code, 'graph_import_incomplete');
    assert.equal(error.lockKept, true);
    assert.match(error.message, /自动退回没有做完（load of old:personal failed）。维护锁留着，FULI 不会在写了一半的图谱上启动。运行 fuli graph runtime recover/);
    assert.match(error.message, /its automatic rollback did not finish \(load of old:personal failed\)\. The maintenance lock is kept.+Run `fuli graph runtime recover`/s);
    return true;
  });
  // The other graph is still brought back; the failed one is recorded as such.
  assert.deepEqual(states(scene.events).at(-1), { personal: 'restoreFailed', workspace: 'restored' });
  assert.deepEqual(scene.events.find(event => event.restoreFailed), { restoreFailed: 'load of old:personal failed', from: scene.events[0].hold.restorePoint.path });
  assert.equal(scene.events.includes('release'), false, 'the lease stays, so a start is refused');
  assert.equal(scene.events.includes('start'), false, 'nothing starts on a half-written graph');
  assert.equal(scene.events.some(event => event.record?.restored), false);
});

test('an import whose automatic rollback did not finish, on a runtime without a lock, names the copy it kept and starts nothing', async () => {
  const scene = await importScene('fuli-graph-rollback-incomplete-', { instances: ['personal'], locked: false, fails: () => true });
  await assert.rejects(scene.run(), (error) => {
    const copy = /kept at (\S+);/.exec(error.message)?.[1];
    assert.match(copy ?? '', /[\\/]rollback[\\/]before-import-/);
    assert.ok(error.message.includes(graphImportCommand(copy, 'native')));
    assert.match(error.message, /图服务没有重新启动.+The graph services were not started again/s);
    assert.doesNotMatch(error.message, /runtime recover/);
    return true;
  });
  assert.equal(scene.events.includes('start'), false);
});

test('a graph that was empty before the import is emptied again when the import fails on it, and the lease goes', async () => {
  const scene = await importScene('fuli-graph-rollback-empty-', { before: ['personal'], setAside: async () => {},
    fails: (instance, rollback) => instance === 'workspace' && !rollback });
  await assert.rejects(scene.run(), /load of new:workspace failed.+每个图谱都已退回导入前的数据/s);
  assert.deepEqual(scene.events[0].hold.restorePoint.instances, ['personal']);
  assert.deepEqual(scene.events.filter(event => typeof event === 'string'),
    ['load new:personal', 'load new:workspace', 'load old:personal', 'set aside workspace', 'release', 'start']);
  assert.deepEqual(states(scene.events).at(-1), { personal: 'restored', workspace: 'restored' });
  // Without a way to empty it, that graph is not whole: the lease stays.
  const stuck = await importScene('fuli-graph-rollback-empty-stuck-', { before: ['personal'], fails: (instance, rollback) => instance === 'workspace' && !rollback });
  await assert.rejects(stuck.run(), /cannot empty it again/);
  assert.deepEqual([stuck.events.includes('release'), stuck.events.includes('start')], [false, false]);
});

test('a state that cannot be recorded in the lock stops the import there: nothing more is written, the lease stays', async () => {
  // The disk fills while the second graph's state is recorded.
  let writes = 0;
  const full = async () => { writes += 1; if (writes === 3) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
  const scene = await importScene('fuli-graph-unrecorded-', { record: full });
  await assert.rejects(scene.run(), (error) => {
    assert.equal(error.code, 'graph_import_incomplete');
    assert.match(error.message, /没能把各图谱的进度记进数据库维护锁，所以没有接着写，也没有退回.+could not be recorded in the maintenance lock, so nothing more was written or rolled back/s);
    // A recovery writes too, and bringing the copy back takes twice its size: room comes first.
    assert.match(error.message, /维护锁留着，FULI 不会在写了一半的图谱上启动。磁盘满了：先腾出磁盘空间，至少要有导入前副本大小的两倍（副本 [\d.]+ KB，至少要 [\d.]+ KB，现在剩 3\.0 MB），再做下一步。运行 fuli graph runtime recover/);
    assert.match(error.message, /The disk is full: first free disk space, at least twice the size of the copy from before the import \(the copy is [\d.]+ KB, so at least [\d.]+ KB; 3\.0 MB is free now\), then take the next step\. Run `fuli graph runtime recover`/);
    return true;
  });
  assert.deepEqual(scene.events.filter(event => typeof event === 'string'), ['load new:personal'], 'workspace was never written, and nothing rolled back unrecorded');
  assert.deepEqual(states(scene.events).at(-1), { personal: 'imported', workspace: 'untouched' }, 'what the lock says is what happened');
  // During the rollback too: personal is back, but that cannot be recorded, so
  // the lock keeps the safe word for it (restoring) and workspace is not written.
  writes = 0;
  const later = await importScene('fuli-graph-unrecorded-rollback-', { record: async () => { writes += 1; if (writes === 6) throw new Error('ENOSPC'); },
    fails: (instance, rollback) => instance === 'workspace' && !rollback });
  await assert.rejects(later.run(), /graph_import_incomplete|could not be recorded/);
  assert.deepEqual(later.events.filter(event => typeof event === 'string'), ['load new:personal', 'load new:workspace', 'load old:personal']);
  assert.deepEqual(states(later.events).at(-1), { personal: 'restoring', workspace: 'importFailed' });
  assert.deepEqual([later.events.includes('release'), later.events.includes('start')], [false, false]);
});

test('graph import does not claim an empty rollback bundle for a fresh target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-graph-fresh-target-'));
  const inputDir = join(root, 'source');
  await exportGraphData({
    outputDir: inputDir,
    sourceMode: 'container',
    instances: ['personal'],
    adapter: {
      async stop() { return { resume: false }; },
      async dump(_instance, destination) { await writeFile(destination, 'new graph'); },
      async start() {}
    }
  });
  const loaded = [];
  const restorePoints = [];
  const result = await importGraphData({
    inputDir,
    targetMode: 'native',
    rollbackDir: join(root, 'rollbacks'),
    adapter: {
      async stop() { return { resume: false }; },
      async dump() { throw new Error('fresh target must not be dumped'); },
      async load(_instance, source) { loaded.push(await readFile(source, 'utf8')); },
      async holdImport({ restorePoint }) { restorePoints.push(restorePoint); return { locked: true, async record() {}, async release() {} }; },
      async hasData() { return false; },
      async start() {}
    }
  });

  assert.deepEqual(loaded, ['new graph']);
  assert.equal(result.rollbackDir, null);
  // A recovery of a load killed part way knows there is no copy: the target was empty.
  assert.deepEqual(restorePoints, [{ path: null, instances: [], loading: ['personal'] }]);
});

test('credential reconciliation failure rolls imported graph data back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-graph-identity-rollback-'));
  const inputDir = join(root, 'source');
  await exportGraphData({
    outputDir: inputDir,
    sourceMode: 'container',
    instances: ['personal'],
    adapter: {
      async stop() { return { resume: false }; },
      async dump(_instance, destination) { await writeFile(destination, 'new graph'); },
      async start() {}
    }
  });
  const loaded = [];
  await assert.rejects(importGraphData({
    inputDir,
    targetMode: 'native',
    rollbackDir: join(root, 'rollbacks'),
    adapter: {
      async stop() { return { resume: false }; },
      async dump(_instance, destination) { await writeFile(destination, 'old graph'); },
      async load(_instance, source) {
        loaded.push(await readFile(source, 'utf8'));
      },
      async reconcile() { throw new Error('credential rotation failed'); },
      async start() {}
    }
  }), /credential rotation failed/);

  assert.deepEqual(loaded, ['new graph', 'old graph']);
});

test('an import that fails before it takes over an earlier unfinished import starts nothing while that one\'s marker is there', async () => {
  for (const marked of [true, false]) {
    const scene = await importScene('fuli-graph-marker-stays-');
    // The copy step fails, before the import holds anything; the earlier marker (or none) is what decides the start.
    scene.adapter.dump = async () => { throw new Error('dump failed'); };
    scene.adapter.unfinishedImport = async () => marked ? { readable: true, partial: [], graphStates: {} } : null;
    await assert.rejects(scene.run(), /dump failed/);
    assert.equal(scene.events.includes('start'), !marked, marked ? 'a marker keeps the start off' : 'without one, what ran before starts again');
  }
});
