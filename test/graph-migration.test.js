import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleApiRequest } from '../src/http/api-router.js';
import { createDoctor } from '../src/system/doctor.js';
import { LEGACY_MIGRATION_GUIDE_URL, readGraphMigration, recordGraphMigration, startGraphMigration }
  from '../src/system/graph-migration.js';

// The one-click move of an older install's Docker graph, with a synthetic data
// directory and a fake spawn: no Docker, no real FULI data, no real process.

function paths(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-graph-migration-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir };
}

const NOW = () => new Date('2026-11-02T15:00:00.000Z');

test('the migration starts the CLI detached for this data directory and records it running', (t) => {
  const dirs = paths(t);
  const spawned = [];
  const spawnProcess = (command, args, options) => {
    spawned.push({ command, args, options });
    return { pid: 4242, unref() { spawned.at(-1).unref = true; } };
  };
  const state = startGraphMigration(dirs, { runtimeMode: () => 'container', spawnProcess, alive: () => true, now: NOW });
  assert.equal(state.status, 'running');
  const [{ command, args, options, unref }] = spawned;
  assert.equal(command, process.execPath);
  assert.deepEqual(args.slice(1), ['graph', 'migrate', '--to', 'native', '--yes', '--data-dir', dirs.dataDir]);
  assert.match(args[0], /src[\\/]cli\.js$/);
  assert.equal(options.detached, true);
  assert.equal(unref, true);
  assert.equal(readGraphMigration(dirs, { alive: () => true }).status, 'running');
  // One at a time, and never on a built-in graph.
  assert.throws(() => startGraphMigration(dirs, { runtimeMode: () => 'container', spawnProcess, alive: () => true }), /already running/);
  assert.throws(() => startGraphMigration(dirs, { runtimeMode: () => 'native', spawnProcess }), /nothing to move/);
  assert.equal(spawned.length, 1);
});

test('a run whose process is gone reads as failed; the command records how it ended', (t) => {
  const dirs = paths(t);
  startGraphMigration(dirs, { runtimeMode: () => 'container', spawnProcess: () => ({ pid: 7, unref() {} }), now: NOW });
  assert.equal(readGraphMigration(dirs, { alive: () => false }).status, 'failed');
  recordGraphMigration(dirs, { status: 'failed', error: 'Docker is not running.' }, { now: NOW });
  const recorded = JSON.parse(readFileSync(join(dirs.dataDir, 'graph-migration.json'), 'utf8'));
  assert.deepEqual([recorded.status, recorded.error, recorded.finishedAt, recorded.pid],
    ['failed', 'Docker is not running.', '2026-11-02T15:00:00.000Z', undefined]);
});

test('the doctor names a Docker graph once, with the last attempt and the AI guide', async () => {
  const check = (graphRuntime) => createDoctor({ observeClients: () => ({ clients: [] }), liveProcesses: () => [],
    latestVersion: () => null, lastUpdate: () => null, graphRuntime, now: NOW }).check();
  assert.deepEqual((await check(() => ({ mode: 'native', migration: null }))).items, []);
  assert.deepEqual((await check(() => null)).items, []);
  const report = await check(() => ({ mode: 'container',
    migration: { status: 'failed', error: 'Docker is not running.', finishedAt: '2026-11-02T15:00:00.000Z' } }));
  assert.deepEqual(report.items, [{ id: 'graph_container', kind: 'graph_container', severity: 'warning', fix: 'person',
    data: { migration: { status: 'failed', error: 'Docker is not running.', finishedAt: '2026-11-02T15:00:00.000Z' },
      guideUrl: LEGACY_MIGRATION_GUIDE_URL } }]);
  assert.equal(report.overall, 'needs_person');
});

test('the migration is read like any console read and started only from this computer, with no options', async () => {
  let started = 0;
  const system = { graphMigration: () => null, startGraphMigration: () => { started += 1; return { status: 'running' }; } };
  const call = async (method, { remoteAddress = '127.0.0.1', body = '' } = {}) => {
    const sent = [];
    const request = Object.assign([Buffer.from(body)], { method, url: '/api/system/graph-migration',
      headers: { host: '127.0.0.1:2828', 'content-type': 'application/json' }, socket: { remoteAddress } });
    const response = { setHeader() {}, writeHead(status) { sent.push(status); }, end(text) { sent.push(JSON.parse(text)); } };
    assert.equal(await handleApiRequest({ request, response, app: {}, system,
      url: new URL('http://127.0.0.1:2828/api/system/graph-migration') }), true);
    return sent;
  };
  assert.deepEqual(await call('GET', { remoteAddress: '192.168.1.20' }), [200, { migration: null }]);
  assert.equal((await call('POST', { remoteAddress: '192.168.1.20', body: '{}' }))[0], 403);
  await assert.rejects(call('POST', { body: '{"force":true}' }), /takes no options/);
  assert.equal(started, 0);
  assert.deepEqual(await call('POST', { body: '{}' }), [200, { migration: { status: 'running' } }]);
  assert.equal(started, 1);
});
