// The console's advanced areas stay out of sight until this installation has
// a trace of them, and once shown never hide again. Synthetic only: temporary
// data directories, stores seeded through their own entry points, and a
// Provider double that refuses every request.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNodeStore } from '../packages/roundtable/src/peer/node-store.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { advancedAreasPathForRuntime, createAdvancedAreas } from '../src/advanced-areas/advanced-areas.js';
import { openFederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { createProjectOrganizing } from '../src/project-organizing/port.js';
import { VisitorAccessStore } from '../src/visitor-access/store.js';

const SPACE = 'synthetic-space';
const ADVANCED_AREAS = ['roundtable', 'tonborg', 'tidy', 'lan'];
const config = { version: 1, workspaces: [],
  personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-token', principalId: 'synthetic-person', spaceId: SPACE } };

// The test's applications close before its directory goes (Windows keeps open files).
const openApps = new WeakMap();
function dataDirectory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-advanced-areas-'));
  openApps.set(t, []);
  t.after(async () => {
    await Promise.all(openApps.get(t).map(app => app.close()));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return dir;
}

function opened(t, dataDir) {
  const app = openFederatedGraphApplication({ runtimeConfigPath: join(dataDir, 'graph-runtime.json'), config, env: {},
    fetchImpl: async () => { throw new Error('No Provider in this test'); } });
  openApps.get(t).push(app);
  return app;
}

const shown = app => app.advancedAreas.observe(app).shown;

function withRoundtable(dataDir, work) {
  const store = createRoundtableStore(join(dataDir, 'agent-roundtable.sqlite'));
  try { work(store); } finally { store.close(); }
}

const SEEDS = {
  'a roundtable thread': ['roundtable', dataDir => withRoundtable(dataDir,
    store => store.createThread({ id: 'thread-1', spaceId: SPACE, subject: 'Synthetic ask' }))],
  'a group discussion': ['roundtable', dataDir => withRoundtable(dataDir, store => store.discussions.confirm({
    scope: SPACE, requestId: 'room-1', owner: 'agent-a', projectId: 'project-a', question: 'Synthetic question',
    members: ['agent-b'], lifetime: 'short', roundLimit: 0 }))],
  '交给 Tonborg 确认 switched on': ['tonborg', dataDir => {
    const store = new JudgmentStore(join(dataDir, 'judgment.sqlite'), { recoveryGate: { state: () => ({ state: 'open' }) } });
    try { store.setDelegation(SPACE, true, 0); } finally { store.close(); }
  }],
  'a project 整理 run': ['tidy', dataDir => createProjectOrganizing({ path: join(dataDir, 'project-organizing.json') })
    .update(SPACE, 'project-a', { areas: { purpose: { status: 'known' } } })],
  'a paired computer': ['lan', dataDir => {
    const store = createNodeStore(join(dataDir, 'peer', 'node.sqlite'));
    try { store.setSetting('membership', { role: 'member', coordinator: { name: 'Synthetic', url: 'https://192.0.2.1:1', fingerprint: 'f' } }); }
    finally { store.close(); }
  }],
  'a guest link': ['lan', dataDir => {
    const store = new VisitorAccessStore(join(dataDir, 'visitor-access.sqlite'));
    try {
      store.insertGuestLink({ id: 'link-1', projectId: 'project-a', tokenHash: 'synthetic-hash', label: 'guest-link-1',
        createdAt: '2026-11-15T00:00:00.000Z', expiresAt: '2026-11-22T00:00:00.000Z' });
    } finally { store.close(); }
  }],
  'a visit': ['lan', dataDir => {
    const store = new VisitorAccessStore(join(dataDir, 'visitor-access.sqlite'));
    try {
      store.recordRefusal({ requesterKey: 'peer:synthetic', requesterLabel: 'Synthetic', agentName: null, projectId: 'project-a',
        action: 'search', code: 'project_not_shared', at: new Date() });
    } finally { store.close(); }
  }]
};

test('a fresh installation shows no advanced area', async (t) => {
  const app = opened(t, dataDirectory(t));
  assert.deepEqual(shown(app), []);
});

for (const [trace, [area, seed]] of Object.entries(SEEDS)) {
  test(`an installation with ${trace} shows exactly ${area}`, async (t) => {
    const dataDir = dataDirectory(t);
    seed(dataDir);
    const app = opened(t, dataDir);
    assert.deepEqual(shown(app), [area]);
  });
}

test('an existing installation keeps what it used after the upgrade, and deleting the data afterwards hides nothing', async (t) => {
  const dataDir = dataDirectory(t);
  SEEDS['a roundtable thread'][1](dataDir);
  SEEDS['a guest link'][1](dataDir);
  const first = opened(t, dataDir);
  assert.deepEqual(shown(first), ['roundtable', 'lan']);
  await first.close();
  openApps.get(t).splice(0);
  rmSync(join(dataDir, 'agent-roundtable.sqlite'), { force: true });
  rmSync(join(dataDir, 'visitor-access.sqlite'), { force: true });
  const again = opened(t, dataDir);
  assert.deepEqual(shown(again), ['roundtable', 'lan']);
});

test('a reveal persists across a new instance on the same path and is refused for an unknown area', (t) => {
  const path = advancedAreasPathForRuntime(join(dataDirectory(t), 'graph-runtime.json'));
  const areas = createAdvancedAreas(path, { now: () => '2026-11-15T08:00:00.000Z' });
  assert.deepEqual(areas.reveal({ id: 'tidy', why: 'link' }), { shown: ['tidy'] });
  assert.deepEqual(areas.reveal({ id: 'lan' }), { shown: ['tidy', 'lan'] });
  assert.deepEqual(createAdvancedAreas(path).observe({}).shown, ['tidy', 'lan']);
  assert.throws(() => areas.reveal({ id: 'everything' }), { code: 'invalid_input' });
  assert.throws(() => areas.reveal({ id: 'lan', why: 'agent' }), { code: 'invalid_input' });
});

test('a check that throws adds nothing, and the next good read adds its area', () => {
  const areas = createAdvancedAreas(null);
  let failing = true;
  const app = { config, roundtable: { used: () => { if (failing) throw new Error('store busy'); return true; } } };
  assert.deepEqual(areas.observe(app).shown, []);
  failing = false;
  assert.deepEqual(areas.observe(app).shown, ['roundtable']);
});

test('an unreadable record shows every area and is not overwritten', (t) => {
  const path = join(dataDirectory(t), 'advanced-areas.json');
  writeFileSync(path, '{ not json');
  const areas = createAdvancedAreas(path);
  assert.deepEqual(areas.observe({ config }).shown, ADVANCED_AREAS);
  assert.deepEqual(areas.reveal({ id: 'tidy' }).shown, ADVANCED_AREAS);
  writeFileSync(path, JSON.stringify({ version: 99, shown: {} }));
  assert.deepEqual(areas.observe({ config }).shown, ADVANCED_AREAS);
});

test('/api/state carries the shown areas and POST /api/advanced-areas/reveal adds one', async (t) => {
  const app = opened(t, dataDirectory(t));
  app.listKnowledgeSpaces = async () => ({ spaces: [] });
  app.getGraphitiStatus = async () => ({ workspaces: [] });
  const call = async (method, path, body) => {
    let sent;
    const request = { method, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    const response = { writeHead: status => { sent = { status }; }, setHeader: () => {}, end: text => { sent.body = JSON.parse(text); } };
    await handleGraphApiRequest({ request, response, url: new URL(`http://127.0.0.1${path}`), app });
    return sent;
  };
  assert.deepEqual((await call('GET', '/api/state')).body.advancedAreas, { shown: [] });
  assert.deepEqual(await call('POST', '/api/advanced-areas/reveal', { id: 'roundtable', why: 'link' }),
    { status: 200, body: { shown: ['roundtable'] } });
  assert.deepEqual((await call('GET', '/api/state')).body.advancedAreas, { shown: ['roundtable'] });
});
