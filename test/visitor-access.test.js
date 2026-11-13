import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createVisitorAccess } from '../src/visitor-access/port.js';

// Synthetic data only: a stubbed provider search, invented ids and texts.
const SPACE = 'space-synthetic';
const PROJECT = 'project-shared';
const PEER = `peer:${'a'.repeat(64)}`;
const GUEST = 'guest:link-0001';
const VISITOR = { key: PEER, label: 'Synthetic laptop', agentName: 'Synthetic helper' };
const START = new Date('2026-11-01T00:00:00.000Z');

function clock(start = START) {
  let current = start.getTime();
  return { now: () => new Date(current), advance: (ms) => { current += ms; } };
}

function application(answer = () => ({ facts: [], entities: [] })) {
  const requests = [];
  return { requests, config: { personal: { spaceId: SPACE } },
    personal: { search: async (request) => { requests.push(request); return answer(request); } } };
}

// Every port a test opened is closed before its directory is removed (Windows keeps an open file).
function access(t, { app = application(), time = clock(), path = temporaryPath(t) } = {}) {
  const port = createVisitorAccess({ path, application: app, now: time.now });
  opened(t).push(port);
  return port;
}

function opened(t) {
  if (!t.visitorPorts) {
    t.visitorPorts = [];
    t.visitorDirectories = [];
    t.after(() => {
      t.visitorPorts.forEach(port => port.close());
      t.visitorDirectories.forEach(directory => rmSync(directory, { recursive: true, force: true }));
    });
  }
  return t.visitorPorts;
}

function temporaryPath(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-visitor-access-'));
  opened(t);
  t.visitorDirectories.push(directory);
  return join(directory, 'visitor-access.sqlite');
}

const fact = (fields) => ({ id: 'f', relationship: 'USES', fact: 'Synthetic fact', score: 1,
  defined_project_id: PROJECT, inherited: false, ...fields });
const entity = (fields) => ({ id: 'e', name: 'Synthetic entity', type: 'Decision', summary: 'Synthetic summary', score: 1,
  defined_project_id: PROJECT, inherited: false, ...fields });

test('the visitor search sends exactly the narrowed request, one per query', async (t) => {
  const app = application();
  const port = access(t, { app });
  const result = await port.searchSharedProject({ projectId: PROJECT, requester: VISITOR,
    queries: ['deploy steps', '  release checklist  '] });
  assert.equal(result.ok, true);
  assert.deepEqual(app.requests, ['deploy steps', 'release checklist'].map(query => ({
    space_ids: [SPACE],
    query,
    limit: 8,
    include_historical: false,
    include_pending: false,
    personal_project_ids: [PROJECT],
    active_personal_project_id: PROJECT,
    project_agent_id: null,
    inherit_project_knowledge: false,
    include_personal_global: false,
    max_sensitivity: 'normal'
  })));
});

test('a caller cannot widen the search through extra fields', async (t) => {
  const app = application();
  const port = access(t, { app });
  await port.searchSharedProject({ projectId: PROJECT, requester: VISITOR, queries: ['deploy'],
    include_personal_global: true, inherit_project_knowledge: true, include_pending: true, limit: 100 });
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].include_personal_global, false);
  assert.equal(app.requests[0].inherit_project_knowledge, false);
  assert.equal(app.requests[0].include_pending, false);
  assert.equal(app.requests[0].limit, 8);
});

test('query and requester input is refused with plain codes and never searched', async (t) => {
  const app = application();
  const port = access(t, { app });
  const search = (fields) => port.searchSharedProject({ projectId: PROJECT, requester: VISITOR, queries: ['q'], ...fields });
  assert.deepEqual(await search({ queries: [] }), { ok: false, code: 'queries_missing' });
  assert.deepEqual(await search({ queries: ['a', 'b', 'c', 'd', 'e'] }), { ok: false, code: 'too_many_queries' });
  assert.deepEqual(await search({ queries: ['ok', '   '] }), { ok: false, code: 'query_invalid' });
  assert.deepEqual(await search({ queries: [{ query: 'x' }] }), { ok: false, code: 'query_invalid' });
  assert.deepEqual(await search({ projectId: '' }), { ok: false, code: 'project_invalid' });
  assert.deepEqual(await search({ projectId: ['a'] }), { ok: false, code: 'project_invalid' });
  assert.deepEqual(await search({ requester: { key: 'peer:short', label: 'x' } }), { ok: false, code: 'requester_invalid' });
  assert.deepEqual(await search({ requester: { key: PEER, label: '' } }), { ok: false, code: 'requester_invalid' });
  assert.equal(app.requests.length, 0);
  assert.deepEqual(port.recentReads({ limit: 10 }), []);
});

test('a failing provider is a plain refusal and records no read', async (t) => {
  const port = access(t, { app: application(() => { throw new Error('C:\\Users\\someone\\secret'); }) });
  assert.deepEqual(await port.searchSharedProject({ projectId: PROJECT, requester: VISITOR, queries: ['q'] }),
    { ok: false, code: 'search_unavailable' });
  assert.deepEqual(port.recentReads({ limit: 10 }), []);
});

test('the answer keeps only the project\'s own items, at most 8 per query, without local paths', async (t) => {
  const facts = [
    fact({ id: 'own', fact: 'Build output lives in C:\\Users\\someone\\repo\\dist and /home/someone/repo', score: 9 }),
    fact({ id: 'global', defined_project_id: null }),
    fact({ id: 'other', defined_project_id: 'project-other' }),
    fact({ id: 'parent', inherited: true }),
    fact({ id: 'fla', project_agent_id: 'agent-1' }),
    fact({ id: 'preference', profile_aspect: 'communication' }),
    ...Array.from({ length: 10 }, (_, index) => fact({ id: `more-${index}`, fact: `More ${index}`, score: 1 }))
  ];
  const entities = [
    entity({ id: 'source', type: 'ProjectSource', summary: 'repository at /Users/someone/code' }),
    entity({ id: 'project', type: 'PersonalProject' }),
    entity({ id: 'own-entity', name: 'Release decision', score: 8, source_uris: ['file:///home/someone/notes.md'] })
  ];
  const port = access(t, { app: application(() => ({ facts, entities })) });
  const result = await port.searchSharedProject({ projectId: PROJECT, requester: VISITOR, queries: ['build'] });
  const items = result.results[0].items;
  assert.equal(items.length, 8);
  assert.deepEqual(items.slice(0, 2), [
    { kind: 'fact', title: 'USES', text: 'Build output lives in [path] and [path]' },
    { kind: 'Decision', title: 'Release decision', text: 'Synthetic summary' }
  ]);
  assert.ok(items.slice(2).every(item => item.kind === 'fact' && item.text.startsWith('More ')));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /[A-Za-z]:\\|\/home\/|\/Users\/|file:/);
  assert.equal(result.truncated, false);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'results', 'truncated']);
});

test('the whole answer stays within 16 KB and says when it was cut', async (t) => {
  const long = '知识'.repeat(3000);
  const facts = Array.from({ length: 8 }, (_, index) => fact({ id: `f${index}`, fact: `${index}${long}` }));
  const port = access(t, { app: application(() => ({ facts, entities: [] })) });
  const result = await port.searchSharedProject({ projectId: PROJECT, requester: VISITOR,
    queries: ['one', 'two', 'three', 'four'] });
  const answer = { results: result.results, truncated: result.truncated };
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= 16 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) > 15 * 1024);
  assert.ok(result.results[0].items.at(-1).text.endsWith('…'));
  assert.deepEqual(result.results.slice(1).map(entry => entry.items.length), [0, 0, 0]);
  const [read] = port.recentReads({ limit: 1 });
  assert.equal(read.bytes, Buffer.byteLength(JSON.stringify(answer)));
  assert.equal(read.resultsCount, result.results[0].items.length);
});

test('each search is recorded with its queries as searched, newest first', async (t) => {
  const time = clock();
  const port = access(t, { time, app: application(() => ({ facts: [fact({})], entities: [] })) });
  const longQuery = `  ${'q'.repeat(250)}  `;
  await port.searchSharedProject({ projectId: PROJECT, requester: VISITOR, queries: [longQuery, 'short'] });
  time.advance(1000);
  await port.searchSharedProject({ projectId: 'project-second', requester: { key: GUEST, label: 'Guest link' },
    queries: ['guest query'] });
  const reads = port.recentReads({ limit: 10 });
  assert.deepEqual(reads.map(read => [read.requesterKey, read.projectId]), [[GUEST, 'project-second'], [PEER, PROJECT]]);
  assert.deepEqual(reads[1].queries, ['q'.repeat(200), 'short']);
  assert.equal(reads[1].requesterLabel, 'Synthetic laptop');
  assert.equal(reads[1].agentName, 'Synthetic helper');
  assert.equal(reads[1].action, 'search');
  assert.equal(reads[1].resultsCount, 2);
  assert.equal(reads[1].at, START.toISOString());
  assert.equal(reads[0].agentName, null);
  assert.equal(reads[0].resultsCount, 0);
  assert.deepEqual(port.recentReads({ requesterKey: PEER, limit: 10 }).map(read => read.projectId), [PROJECT]);
  assert.deepEqual(port.recentReads({ projectId: 'project-second', limit: 10 }).map(read => read.requesterKey), [GUEST]);
  assert.equal(port.recentReads({ limit: 1 }).length, 1);
});

test('reads older than 90 days are deleted when the next read is recorded', async (t) => {
  const time = clock();
  const port = access(t, { time });
  await port.searchSharedProject({ projectId: PROJECT, requester: VISITOR, queries: ['old'] });
  time.advance(89 * 24 * 60 * 60 * 1000);
  await port.searchSharedProject({ projectId: PROJECT, requester: VISITOR, queries: ['kept'] });
  assert.equal(port.recentReads({ limit: 10 }).length, 2);
  time.advance(2 * 24 * 60 * 60 * 1000);
  await port.searchSharedProject({ projectId: PROJECT, requester: VISITOR, queries: ['new'] });
  assert.deepEqual(port.recentReads({ limit: 10 }).map(read => read.queries[0]), ['new', 'kept']);
});

test('the store round-trips across reopening the file', async (t) => {
  const path = temporaryPath(t);
  const first = createVisitorAccess({ path, application: application(), now: () => START });
  assert.equal(first.setRequesterMode({ key: PEER, kind: 'peer', label: 'Own desktop', mode: 'trusted', ownDevice: true }).ok, true);
  await first.searchSharedProject({ projectId: PROJECT, requester: VISITOR, queries: ['persisted'] });
  first.close();
  const second = access(t, { path });
  assert.equal(second.requesterMode(PEER), 'trusted');
  assert.deepEqual(second.recentReads({ limit: 10 }).map(read => read.queries), [['persisted']]);
});

test('a requester\'s mode defaults to plan, and only the person\'s own peer device can be trusted', (t) => {
  const port = access(t);
  assert.equal(port.requesterMode(PEER), 'plan');
  assert.equal(port.requesterMode(GUEST), 'plan');
  assert.deepEqual(port.setRequesterMode({ key: GUEST, kind: 'guest', label: 'Guest', mode: 'trusted', ownDevice: true }),
    { ok: false, code: 'mode_not_allowed' });
  assert.deepEqual(port.setRequesterMode({ key: PEER, kind: 'peer', label: 'Colleague', mode: 'trusted', ownDevice: false }),
    { ok: false, code: 'mode_not_allowed' });
  assert.deepEqual(port.setRequesterMode({ key: PEER, kind: 'peer', label: 'Colleague', mode: 'trusted', ownDevice: 'yes' }),
    { ok: false, code: 'mode_not_allowed' });
  assert.deepEqual(port.setRequesterMode({ key: PEER, kind: 'peer', label: 'Colleague', mode: 'admin', ownDevice: true }),
    { ok: false, code: 'mode_unknown' });
  assert.deepEqual(port.setRequesterMode({ key: PEER, kind: 'guest', label: 'Mismatch', mode: 'plan', ownDevice: false }),
    { ok: false, code: 'requester_invalid' });
  assert.equal(port.requesterMode(PEER), 'plan');

  const guest = port.setRequesterMode({ key: GUEST, kind: 'guest', label: 'Guest', mode: 'auto', ownDevice: true });
  assert.deepEqual(guest, { ok: true, requester: { key: GUEST, kind: 'guest', label: 'Guest', mode: 'auto', ownDevice: false,
    modeUpdatedAt: START.toISOString() } });
  assert.equal(port.setRequesterMode({ key: PEER, kind: 'peer', label: 'Own laptop', mode: 'trusted', ownDevice: true }).ok, true);
  assert.equal(port.requesterMode(PEER), 'trusted');
  assert.equal(port.setRequesterMode({ key: PEER, kind: 'peer', label: 'Own laptop', mode: 'ask_only', ownDevice: true }).ok, true);
  assert.equal(port.requesterMode(PEER), 'ask_only');
});

test('a requester may search 30 times in 10 minutes and 300 times a day', async (t) => {
  const time = clock();
  const app = application();
  const port = access(t, { time, app });
  const search = (requester = VISITOR) => port.searchSharedProject({ projectId: PROJECT, requester, queries: ['q'] });
  for (let index = 0; index < 30; index += 1) assert.equal((await search()).ok, true);
  assert.deepEqual(await search(), { ok: false, code: 'rate_limited_short' });
  // Another requester has its own count.
  assert.equal((await search({ key: GUEST, label: 'Guest' })).ok, true);
  time.advance(10 * 60 * 1000);
  assert.equal((await search()).ok, true);

  // 300 within one day, spread so the short window never fills.
  for (let index = 31; index < 300; index += 1) {
    if (index % 25 === 0) time.advance(10 * 60 * 1000);
    assert.equal((await search()).ok, true, `search ${index}`);
  }
  time.advance(10 * 60 * 1000);
  assert.deepEqual(await search(), { ok: false, code: 'rate_limited_day' });
  time.advance(24 * 60 * 60 * 1000);
  assert.equal((await search()).ok, true);
  assert.equal(app.requests.length, 302);
});
