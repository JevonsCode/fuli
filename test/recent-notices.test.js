import assert from 'node:assert/strict';
import test from 'node:test';

import { recentNotices } from '../src/notices/recent-notices.js';
import { handleNoticesRequest } from '../src/http/notices-api-router.js';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const SPACE = 'synthetic-space';
const ago = days => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

function syntheticApp(overrides = {}) {
  return {
    config: { personal: { spaceId: SPACE } },
    listPersonalProjects: async () => [
      { project_id: 'garden', created_at: ago(1), profile: { name: 'Garden', purpose: 'Astro 自动升级：话题「Garden」累计 3 个会话、跨 2 天' } },
      { project_id: 'undone', created_at: ago(1), profile: { name: 'Undone', purpose: 'Astro 自动升级：x', lifecycle: 'archived' } },
      { project_id: 'old', created_at: ago(30), profile: { name: 'Old', purpose: 'Astro 自动升级：y' } },
      { project_id: 'mine', created_at: ago(1), profile: { name: 'Mine', purpose: 'Made by hand' } }
    ],
    roleSuggestions: true,
    readRoleSuggestions: async () => [
      { id: 'run-1', operation: 'dreaming', at: ago(0.5), personalProjectId: 'garden', status: 'dreamed', sessions: 4,
        proposed: [{ status: 'queued' }, { status: 'queued' }, { status: 'dropped' }] },
      { id: 'run-2', operation: 'dreaming', at: ago(0.4), personalProjectId: 'mine', status: 'dreamed', sessions: 2, proposed: [] },
      { id: 'run-3', operation: 'dreaming', at: ago(0.3), personalProjectId: 'mine', status: 'nothing_to_read' },
      { id: 'run-4', operation: 'dreaming', at: ago(0.2), personalProjectId: 'mine', status: 'budget_exhausted' }
    ],
    judgment: {
      scope: async () => {},
      store: () => ({ delegatedReviews: () => [
        { id: 'j1', createdAt: ago(0.1), target: 'entity:a', summary: 's', feedback: { vote: null, revision: 0 }, execution: { status: 'applied' } },
        { id: 'j2', createdAt: ago(0.2), target: 'entity:b', summary: 's', feedback: { vote: null, revision: 0 }, execution: { status: 'applied' } }
      ] })
    },
    listProjectAgents: async ({ status }) => (status === 'archived'
      ? [{ agentId: 'gone', personalProjectId: 'garden', archivedAt: ago(2), profile: { name: 'Synthetic Gone' } }]
      : [{ agentId: 'new', personalProjectId: null, assignments: [{ personalProjectId: 'garden' }], recruitedAt: ago(3), profile: { name: 'garden 负责人', displayName: 'Synthetic New' } },
        { agentId: 'veteran', personalProjectId: 'garden', recruitedAt: ago(40), profile: { name: 'Synthetic Veteran' } }]),
    modelBackends: {
      roles: () => ({ connections: { c: {} }, roles: [
        { role: 'tonborg', state: 'enabled', connection: { id: 'c' } },
        { role: 'assistant', state: 'enabled', connection: { id: 'c' } }
      ] }),
      health: role => (role === 'tonborg' ? { status: 'failing', at: ago(0.05) } : { status: 'ok', at: ago(0.05) })
    },
    ...overrides
  };
}

const delegation = { read: () => ({ operations: [
  { id: 7, at: ago(0.6), status: 'applied', reason: 'Approve all projects for Dreaming' },
  { id: 8, at: ago(0.7), status: 'refused', reason: 'Refused one' }
] }) };
const system = { cachedVersionStatus: () => ({ updateAvailable: true, latestVersion: '9.9.9', checkedAt: ago(0.01) }) };

test('recent notices gather what changed in the last two weeks, newest first, each with its place to act', async () => {
  const { windowDays, items } = await recentNotices({ app: syntheticApp(), delegation, system, now: NOW });
  assert.equal(windowDays, 14);
  assert.deepEqual(items.map(item => item.kind), ['update_available', 'model_failing', 'tonborg_confirmed', 'dreaming_stopped',
    'dreaming_found', 'delegated_change', 'topic_promoted', 'fla_left', 'fla_joined']);
  const byKind = Object.fromEntries(items.map(item => [item.kind, item]));
  assert.deepEqual(byKind.topic_promoted.params, { project: 'Garden' });
  assert.equal(byKind.topic_promoted.href, '/employees/assistant?promoted=garden&topic=Garden');
  assert.deepEqual(byKind.dreaming_found.params, { project: 'Garden', sessions: 4, proposed: 2 });
  assert.deepEqual(byKind.dreaming_stopped.params, { project: 'Mine', status: 'budget_exhausted' });
  assert.deepEqual(byKind.tonborg_confirmed.params, { count: 2 });
  assert.deepEqual(byKind.fla_joined.params, { name: 'Synthetic New', project: 'Garden' });
  assert.equal(byKind.fla_left.href, '/agents/synthetic-space/gone');
  assert.deepEqual(byKind.model_failing.params, { role: 'tonborg' });
  assert.deepEqual(byKind.delegated_change.params, { reason: 'Approve all projects for Dreaming' });
  assert.equal(byKind.update_available.href, '/settings?tab=version');
});

test('a source that cannot be read is left out without emptying the list', async () => {
  const app = syntheticApp({
    readRoleSuggestions: async () => { throw new Error('recovery gate open'); },
    listProjectAgents: async () => { throw new Error('provider down'); },
    judgment: null
  });
  const { items } = await recentNotices({ app, now: NOW });
  assert.deepEqual(items.map(item => item.kind), ['model_failing', 'topic_promoted']);
});

test('fuli#346: a finished task\'s retrospective with lessons to confirm leads to the review queue', async () => {
  const retrospective = (id, extra) => ({ id, operation: 'retrospective', at: ago(0.5), personalProjectId: 'garden', status: 'written',
    subject: { personalProjectId: 'garden', taskId: `task-${id}` }, taskTitle: `Synthetic task ${id}`, ...extra });
  const app = syntheticApp({ readRoleSuggestions: async () => [
    retrospective('a', { lessons: [{ title: 'L1', status: 'queued' }, { title: 'L2', status: 'queued' }, { title: 'L3', status: 'failed' }] }),
    retrospective('b', { lessons: [] }),
    retrospective('c', { status: 'model_failed' }),
    retrospective('d', { hard_deleted: true, taskTitle: undefined, lessons: [{ status: 'queued' }] })
  ] });
  const { items } = await recentNotices({ app, now: NOW });
  const found = items.filter(item => item.kind === 'retrospective_ready');
  assert.deepEqual(found, [{ id: 'retrospective_ready:task-a', kind: 'retrospective_ready', at: ago(0.5),
    params: { task: 'Synthetic task a', project: 'Garden', lessons: 2 }, href: '/inbox', projectId: 'garden' }]);
});

test('the full list reads a longer window a page at a time, newest or oldest first, without skips or repeats', async () => {
  const app = syntheticApp();
  const all = await recentNotices({ app, delegation, system, now: NOW, query: { days: 90 } });
  // The 90-day window adds the 30-day-old promotion and the 40-day-old recruit.
  assert.equal(all.windowDays, 90);
  assert.equal(all.total, 11);
  assert.deepEqual(all.items.slice(-2).map(item => item.id), ['topic_promoted:old', 'fla_joined:veteran']);
  const seen = [];
  let cursor;
  do {
    const page = await recentNotices({ app, delegation, system, now: NOW, query: { days: 90, limit: 4, cursor } });
    assert.equal(page.total, 11);
    seen.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, all.items.map(item => item.id));
  const oldest = await recentNotices({ app, delegation, system, now: NOW, query: { days: 90, sort: 'oldest' } });
  assert.deepEqual(oldest.items.map(item => item.id), [...seen].reverse());
});

test('notices filter by kind, project, FLA and the words they name', async () => {
  const app = syntheticApp();
  const read = async query => (await recentNotices({ app, delegation, system, now: NOW, query })).items.map(item => item.id);
  assert.deepEqual(await read({ kinds: ['fla_joined', 'fla_left'] }), ['fla_left:gone', 'fla_joined:new']);
  assert.deepEqual(await read({ projectIds: ['garden'] }), ['dreaming_found:run-1', 'topic_promoted:garden', 'fla_left:gone', 'fla_joined:new']);
  assert.deepEqual(await read({ agentIds: ['new'] }), ['fla_joined:new']);
  assert.deepEqual(await read({ text: ' synthetic NEW' }), ['fla_joined:new']);
  assert.deepEqual(await read({ kinds: ['update_available'], projectIds: ['garden'] }), []);
});

test('the notices route keeps the workbench answer and refuses a query it cannot use', async () => {
  const call = async (search) => {
    let status; let body;
    const response = { setHeader() {}, writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
    const request = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1' } };
    await handleNoticesRequest({ request, response, url: new URL(`http://127.0.0.1/api/notices${search}`), app: syntheticApp(), delegation, system });
    return { status, body };
  };
  const plain = await call('');
  assert.equal(plain.status, 200);
  assert.equal(plain.body.windowDays, 14);
  assert.equal(plain.body.nextCursor, null);
  const paged = await call('?days=90&limit=2&kind=fla_joined&kind=topic_promoted&sort=oldest');
  assert.deepEqual(paged.body.items.map(item => item.id), ['fla_joined:veteran', 'topic_promoted:old']);
  assert.equal(paged.body.nextCursor, '2');
  for (const bad of ['?days=91', '?limit=0', '?sort=sideways', '?cursor=-1']) {
    await assert.rejects(call(bad), TypeError, bad);
  }
});
