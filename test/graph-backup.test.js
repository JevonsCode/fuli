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

test('failed graph import restores the target from an automatic rollback dump', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-graph-rollback-'));
  const bundle = join(root, 'bundle');
  await mkdir(bundle);
  const sourceAdapter = {
    async stop() { return { resume: false }; },
    async dump(instance, destination) { await writeFile(destination, `new:${instance}`); },
    async start() {}
  };
  await exportGraphData({
    outputDir: join(root, 'source'),
    sourceMode: 'container',
    instances: ['personal', 'workspace'],
    adapter: sourceAdapter
  });
  const inputDir = join(root, 'source');
  const loaded = [];
  const adapter = {
    async stop() { return { resume: true }; },
    async dump(instance, destination) { await writeFile(destination, `old:${instance}`); },
    async load(instance, source, options = {}) {
      loaded.push({ instance, body: await readFile(source, 'utf8'), rollback: options.rollback });
      if (instance === 'workspace' && !options.rollback) throw new Error('load failed');
    },
    async start() { loaded.push({ started: true }); }
  };

  await assert.rejects(importGraphData({
    inputDir,
    targetMode: 'native',
    rollbackDir: join(root, 'rollback'),
    adapter
  }), /load failed/);

  assert.deepEqual(loaded, [
    { instance: 'personal', body: 'new:personal', rollback: false },
    { instance: 'workspace', body: 'new:workspace', rollback: false },
    { instance: 'personal', body: 'old:personal', rollback: true },
    { instance: 'workspace', body: 'old:workspace', rollback: true },
    { started: true }
  ]);
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
  const result = await importGraphData({
    inputDir,
    targetMode: 'native',
    rollbackDir: join(root, 'rollbacks'),
    adapter: {
      async stop() { return { resume: false }; },
      async dump() { throw new Error('fresh target must not be dumped'); },
      async load(_instance, source) { loaded.push(await readFile(source, 'utf8')); },
      async hasData() { return false; },
      async start() {}
    }
  });

  assert.deepEqual(loaded, ['new graph']);
  assert.equal(result.rollbackDir, null);
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
      async load(_instance, source, options = {}) {
        loaded.push({ body: await readFile(source, 'utf8'), rollback: options.rollback });
      },
      async reconcile() { throw new Error('credential rotation failed'); },
      async start() {}
    }
  }), /credential rotation failed/);

  assert.deepEqual(loaded, [
    { body: 'new graph', rollback: false },
    { body: 'old graph', rollback: true }
  ]);
});
