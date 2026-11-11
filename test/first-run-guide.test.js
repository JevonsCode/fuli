// The console's first-run guide opens once, with a new installation's capture
// question, and closes for good when finished or skipped. Synthetic only:
// temporary data directories and a recording Provider double.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createFirstRunGuide, firstRunGuidePathForRuntime } from '../src/graphiti/first-run-guide.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { beginFirstRunCapture } from '../src/setup/first-run-capture.js';
import { fixture } from './fixtures/capture-project-fixture.js';

function setupPaths(f) {
  const dataDir = dirname(f.runtimeConfigPath);
  return { dataDir, graphRuntimeConfigPath: f.runtimeConfigPath,
    containerGraphConfigProfilePath: join(dataDir, 'runtime-configs', 'container.json'),
    nativeGraphConfigProfilePath: join(dataDir, 'runtime-configs', 'native.json'),
    nativePersonalDir: join(dataDir, 'native-runtime', 'personal') };
}

async function post(app, body, path = '/api/first-run-guide') {
  let sent;
  const request = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  const response = { writeHead: status => { sent = { status }; }, setHeader: () => {}, end: text => { sent.body = JSON.parse(text); } };
  await handleGraphApiRequest({ request, response, url: new URL(`http://127.0.0.1${path}`), app });
  return sent;
}

async function tempGuide(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fuli-first-run-guide-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'first-run-guide.json');
}

test('a new installation opens the guide with its capture question; the console sees it in its state', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));
  const guide = createFirstRunGuide(firstRunGuidePathForRuntime(f.runtimeConfigPath));
  assert.deepEqual(guide.state(), { open: true, tourSeen: null });
  const record = JSON.parse(await readFile(firstRunGuidePathForRuntime(f.runtimeConfigPath), 'utf8'));
  assert.deepEqual([record.version, record.status], [1, 'open']);
});

test('skipping closes the guide for good; a later start does not open it again', async (t) => {
  const path = await tempGuide(t);
  const guide = createFirstRunGuide(path, { now: () => '2026-11-02T08:00:00.000Z' });
  guide.begin();
  assert.deepEqual(guide.close({ outcome: 'skipped' }), { open: false, tourSeen: null });
  guide.begin();
  assert.deepEqual(guide.state(), { open: false, tourSeen: null });
  const record = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual([record.status, record.closedAt], ['skipped', '2026-11-02T08:00:00.000Z']);
});

test('an installation from before has no record and is never shown the guide; an unreadable record never opens it', async (t) => {
  const path = await tempGuide(t);
  assert.deepEqual(createFirstRunGuide(path).state(), { open: false, tourSeen: null });
  await writeFile(path, '{"version": 9, "status": "open"}');
  assert.deepEqual(createFirstRunGuide(path).state(), { open: false, tourSeen: null });
});

test('POST /api/first-run-guide finishes the guide and refuses an unknown outcome', async () => {
  const guide = createFirstRunGuide(null);
  guide.begin();
  const app = { firstRunGuide: guide };
  await assert.rejects(post(app, { outcome: 'later' }), /outcome must be one of finished, skipped/);
  assert.deepEqual(guide.state(), { open: true, tourSeen: null });
  assert.deepEqual(await post(app, { outcome: 'finished' }), { status: 200, body: { open: false, tourSeen: null } });
  assert.deepEqual(guide.state(), { open: false, tourSeen: null });
});

test('the beginner tour is remembered for an installation from before, and never opens the first-run guide', async (t) => {
  const path = await tempGuide(t);
  const guide = createFirstRunGuide(path, { now: () => '2026-11-12T08:00:00.000Z' });
  assert.deepEqual(guide.markTourSeen({ version: 1 }), { open: false, tourSeen: 1 });
  guide.begin();
  assert.deepEqual(createFirstRunGuide(path).state(), { open: false, tourSeen: 1 });
  const record = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual([record.version, record.status, record.tourSeen, record.tourSeenAt], [1, undefined, 1, '2026-11-12T08:00:00.000Z']);
});

test('a new installation keeps its open guide when the tour is seen, and keeps the tour when the guide closes', async (t) => {
  const path = await tempGuide(t);
  const guide = createFirstRunGuide(path);
  guide.begin();
  assert.deepEqual(guide.markTourSeen({ version: 2 }), { open: true, tourSeen: 2 });
  assert.deepEqual(guide.markTourSeen({ version: 1 }), { open: true, tourSeen: 2 });
  assert.deepEqual(guide.close({ outcome: 'finished' }), { open: false, tourSeen: 2 });
});

test('POST /api/first-run-guide/tour records a shown tour version and refuses one that is not a positive integer', async () => {
  const guide = createFirstRunGuide(null);
  const app = { firstRunGuide: guide };
  for (const version of [0, -1, 1.5, '1', null, 1001]) {
    await assert.rejects(post(app, { version }, '/api/first-run-guide/tour'), /version must be a positive integer/);
  }
  assert.deepEqual(await post(app, { version: 1 }, '/api/first-run-guide/tour'), { status: 200, body: { open: false, tourSeen: 1 } });
});
