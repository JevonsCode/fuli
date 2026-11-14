import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createVisitorAccess } from '../src/visitor-access/port.js';
import { searchSharedProject } from '../src/visitor-access/shared-project-search.js';

// Synthetic data only: a stubbed provider search, invented ids and texts.
const SPACE = 'space-synthetic';
const PROJECT = 'project-shared';
const PEER = `peer:${'a'.repeat(64)}`;
const GUEST = 'guest:link-0001';
const VISITOR = { key: PEER, label: 'Synthetic laptop', agentName: 'Synthetic helper' };
const START = new Date('2026-11-01T00:00:00.000Z');
const MAX_ANSWER_BYTES = 16 * 1024;

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

const reads = (port, filter = {}) => port.recentReads({ limit: 200, ...filter }).reads;
const search = (port, fields = {}) => port.searchSharedProject({ projectId: PROJECT, requester: VISITOR, queries: ['q'], ...fields });
const fact = (fields) => ({ id: 'f', relationship: 'USES', fact: 'Synthetic fact', score: 1,
  defined_project_id: PROJECT, inherited: false, ...fields });
const entity = (fields) => ({ id: 'e', name: 'Synthetic entity', type: 'Decision', summary: 'Synthetic summary', score: 1,
  defined_project_id: PROJECT, inherited: false, ...fields });

test('the visitor search sends exactly the narrowed request, one per query', async (t) => {
  const app = application();
  const port = access(t, { app });
  const result = await search(port, { queries: ['deploy steps', '  release checklist  '] });
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
    include_project_references: false,
    excluded_entity_types: ['PersonalProject', 'ProjectSource', 'PersonalPreference'],
    max_sensitivity: 'normal'
  })));
});

test('a caller cannot widen the search through extra fields', async (t) => {
  const app = application();
  const port = access(t, { app });
  await search(port, { queries: ['deploy'], include_personal_global: true, inherit_project_knowledge: true,
    include_pending: true, include_project_references: true, limit: 100 });
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].include_personal_global, false);
  assert.equal(app.requests[0].inherit_project_knowledge, false);
  assert.equal(app.requests[0].include_pending, false);
  assert.equal(app.requests[0].include_project_references, false);
  assert.equal(app.requests[0].limit, 8);
});

test('input is refused with plain codes, recorded, and never searched', async (t) => {
  const app = application();
  const port = access(t, { app });
  assert.deepEqual(await search(port, { queries: [] }), { ok: false, code: 'queries_missing' });
  assert.deepEqual(await search(port, { queries: ['a', 'b', 'c', 'd', 'e'] }), { ok: false, code: 'too_many_queries' });
  assert.deepEqual(await search(port, { queries: ['ok', '   '] }), { ok: false, code: 'query_invalid' });
  assert.deepEqual(await search(port, { queries: ['\u202e\u200b'] }), { ok: false, code: 'query_invalid' });
  assert.deepEqual(await search(port, { queries: [{ query: 'x' }] }), { ok: false, code: 'query_invalid' });
  assert.deepEqual(await search(port, { projectId: '' }), { ok: false, code: 'project_invalid' });
  assert.deepEqual(await search(port, { projectId: ['a'] }), { ok: false, code: 'project_invalid' });
  assert.equal(app.requests.length, 0);
  const recorded = reads(port);
  assert.equal(recorded.length, 7);
  assert.ok(recorded.every(read => read.outcome === 'refused' && read.queries.length === 0));
  assert.deepEqual(recorded.map(read => read.code).sort(), ['project_invalid', 'project_invalid', 'queries_missing',
    'query_invalid', 'query_invalid', 'query_invalid', 'too_many_queries']);
  // Without a usable key there is nobody to record it against. A label never
  // decides it (visiting assistant review H1): see the display-name test.
  assert.deepEqual(await search(port, { requester: { key: 'peer:short', label: 'x' } }), { ok: false, code: 'requester_invalid' });
  assert.deepEqual(await search(port, { requester: { key: { toString: () => PEER }, label: 'x' } }),
    { ok: false, code: 'requester_invalid' });
  assert.equal(reads(port).length, 7);
});

test('an over-long query is refused before it is read, and queries are cut to 200 code points', async (t) => {
  const app = application();
  const port = access(t, { app });
  assert.deepEqual(await search(port, { queries: ['q'.repeat(2001)] }), { ok: false, code: 'query_invalid' });
  assert.equal(app.requests.length, 0);
  assert.equal((await search(port, { queries: [`${'知'.repeat(150)} ${'识'.repeat(150)}`] })).ok, true);
  assert.equal([...app.requests[0].query].length, 200);
});

test('control and bidirectional characters never reach the search or the record', async (t) => {
  const app = application();
  const port = access(t, { app });
  const hidden = '\u202e\u2066\u200b\u0007\u0000';
  await search(port, { requester: { key: PEER, label: `Lap${hidden}top`, agentName: `Hel\u202eper` },
    queries: [`deploy${hidden}steps`] });
  assert.equal(app.requests[0].query, 'deploy steps');
  const [read] = reads(port);
  assert.deepEqual([read.requesterLabel, read.agentName, read.queries], ['Lap top', 'Hel per', ['deploy steps']]);
  const mode = port.setRequesterMode({ key: PEER, kind: 'peer', label: `Own${hidden}laptop`, mode: 'plan', ownDevice: true });
  assert.equal(mode.requester.label, 'Own laptop');
});

test('a failing provider is a plain refusal and its reserved row is marked failed', async (t) => {
  const port = access(t, { app: application(() => { throw new Error('C:\\Users\\someone\\secret'); }) });
  assert.deepEqual(await search(port), { ok: false, code: 'search_unavailable' });
  const [read] = reads(port);
  assert.deepEqual([read.outcome, read.code, read.queries], ['failed', 'search_unavailable', ['q']]);
});

test('the answer keeps only the project\'s own items, at most 8 per query', async (t) => {
  const facts = [
    fact({ id: 'own', fact: 'Build output', score: 9 }),
    fact({ id: 'global', defined_project_id: null }),
    fact({ id: 'other', defined_project_id: 'project-other' }),
    fact({ id: 'parent', inherited: true }),
    fact({ id: 'fla', project_agent_id: 'agent-1' }),
    fact({ id: 'preference', profile_aspect: 'communication' }),
    ...Array.from({ length: 10 }, (_, index) => fact({ id: `more-${index}`, fact: `More ${index}`, score: 1 }))
  ];
  const entities = [
    entity({ id: 'source', type: 'ProjectSource', summary: 'repository' }),
    entity({ id: 'project', type: 'PersonalProject' }),
    entity({ id: 'own-entity', name: 'Release decision', score: 8, source_uris: ['file:///home/someone/notes.md'] })
  ];
  const port = access(t, { app: application(() => ({ facts, entities })) });
  const result = await search(port, { queries: ['build'] });
  const items = result.results[0].items;
  assert.equal(items.length, 8);
  assert.deepEqual(items.slice(0, 2), [
    { kind: 'fact', title: 'USES', text: 'Build output' },
    { kind: 'Decision', title: 'Release decision', text: 'Synthetic summary' }
  ]);
  assert.ok(items.slice(2).every(item => item.kind === 'fact' && item.text.startsWith('More ')));
  assert.equal(result.truncated, false);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'results', 'truncated']);
  assert.doesNotMatch(JSON.stringify(result), /file:|notes\.md/);
});

test('local paths, credentials and secrets in titles and texts are replaced', async (t) => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJlLXN5bnRoZXRpYw';
  const pem = '-----BEGIN CERTIFICATE-----\nMIIBsyntheticAAAA\n-----END CERTIFICATE-----';
  const leaks = {
    'https://user:secret@host/repo': ['secret', 'user:'],
    'https://user:p@ss@host.invalid/x': ['p@ss', 'ss@host', 'user'],
    'https://user:pa:ss@host.invalid/x': ['pa:ss', 'user'],
    'C:\\Users\\Alice\\Private Repo': ['Alice', 'Private', 'Repo'],
    '/home/alice/my folder/file.txt': ['alice', 'folder', 'file.txt'],
    'https://host/path?token=xyz': ['xyz'],
    'see ?token=xyz here': ['xyz'],
    'key sk-abcdefghijklmnopqrst': ['sk-abcdefghijklmnopqrst'],
    [`bearer ${jwt}`]: [jwt.slice(0, 20)],
    [pem]: ['MIIBsynthetic', 'CERTIFICATE'],
    'read /etc/passwd now': ['/etc/passwd'],
    'deployed to /opt/app today': ['/opt/app'],
    'clone into ~/code/repo': ['~/code'],
    'run ./home/u/key first': ['./home', 'u/key'],
    'open ../secrets/key.pem': ['../secrets', 'key.pem'],
    'C:\\Users\\Alice Smith\\secret.txt is it': ['Alice', 'Smith', 'secret.txt'],
    'share \\\\server\\Team Share\\plan.docx': ['server', 'Team Share', 'plan.docx'],
    'link file:///Users/x': ['file:', '/Users/x'],
    'token 0123456789abcdef0123456789abcdef0123': ['0123456789abcdef0123456789abcdef']
  };
  const facts = Object.keys(leaks).map((text, index) => fact({ id: `f${index}`, relationship: text, fact: text }));
  for (let index = 0; index < facts.length; index += 8) {
    const batch = facts.slice(index, index + 8);
    const port = access(t, { app: application(() => ({ facts: batch, entities: [] })) });
    const { results: [{ items }] } = await search(port);
    assert.equal(items.length, batch.length);
    for (const [position, item] of items.entries()) {
      const original = batch[position].fact;
      for (const leak of leaks[original]) {
        assert.ok(!item.text.includes(leak) && !item.title.includes(leak), `${JSON.stringify(original)} kept ${leak}: ${item.text}`);
      }
    }
  }
});

test('prose after a path stays in a visitor\'s answer', async (t) => {
  const texts = ['see /opt/app for details.', 'clone into ~/code then run it'];
  const port = access(t, { app: application(() => ({ facts: texts.map((text, index) => fact({ id: `p${index}`, fact: text })),
    entities: [] })) });
  const { results: [{ items }] } = await search(port);
  assert.deepEqual(items.map(item => item.text), ['see [path] for details.', 'clone into [path] then run it']);
});

test('the search module refuses a project id it was not meant to get, whoever calls it', async () => {
  const app = application();
  for (const projectId of [undefined, 42, ['p'], '', ' padded ', 'p'.repeat(129)]) {
    await assert.rejects(searchSharedProject(app, { projectId, queries: ['q'] }), TypeError);
  }
  await assert.rejects(searchSharedProject(app, { projectId: PROJECT, queries: 'q' }), TypeError);
  assert.equal(app.requests.length, 0);
});

test('the whole returned answer, ok included, stays within 16 KB and its size is recorded', async (t) => {
  const long = '知识'.repeat(3000);
  const facts = Array.from({ length: 8 }, (_, index) => fact({ id: `f${index}`, fact: `${index}${long}` }));
  const port = access(t, { app: application(() => ({ facts, entities: [] })) });
  const result = await search(port, { queries: ['one', 'two', 'three', 'four'] });
  const bytes = Buffer.byteLength(JSON.stringify(result));
  assert.equal(result.truncated, true);
  assert.ok(bytes <= MAX_ANSWER_BYTES && bytes > MAX_ANSWER_BYTES - 64, String(bytes));
  assert.ok(result.results[0].items.at(-1).text.endsWith('…'));
  assert.deepEqual(result.results.slice(1).map(entry => entry.items.length), [0, 0, 0]);
  const [read] = reads(port);
  assert.deepEqual([read.outcome, read.bytes, read.resultsCount], ['answered', bytes, result.results[0].items.length]);
});

test('an answer that fits is never marked truncated', async (t) => {
  // Sizes around the bound: whatever fits whole is returned whole and unmarked.
  for (let extra = -12; extra <= 12; extra += 1) {
    const probe = access(t, { app: application(() => ({ facts: [fact({ fact: '' })], entities: [] })) });
    const empty = Buffer.byteLength(JSON.stringify(await search(probe)));
    // Short words, so no run reads as an opaque token and nothing is redacted.
    const text = Array.from({ length: MAX_ANSWER_BYTES - empty + extra }, (_, index) => (index % 4 === 3 ? ' ' : 'x'))
      .join('').replace(/ $/, 'x');
    const port = access(t, { app: application(() => ({ facts: [fact({ fact: text })], entities: [] })) });
    const result = await search(port);
    const bytes = Buffer.byteLength(JSON.stringify(result));
    assert.ok(bytes <= MAX_ANSWER_BYTES, `${extra}: ${bytes}`);
    const [item] = result.results[0].items;
    assert.equal(result.truncated, item?.text !== text, `${extra}: truncated ${result.truncated}`);
  }
});

test('each search is recorded with its queries as searched, newest first', async (t) => {
  const time = clock();
  const port = access(t, { time, app: application(() => ({ facts: [fact({})], entities: [] })) });
  const longQuery = `  ${'q'.repeat(250)}  `;
  await search(port, { queries: [longQuery, 'short'] });
  time.advance(1000);
  await search(port, { projectId: 'project-second', requester: { key: GUEST, label: 'Guest link' }, queries: ['guest query'] });
  const recorded = reads(port);
  assert.deepEqual(recorded.map(read => [read.requesterKey, read.projectId]), [[GUEST, 'project-second'], [PEER, PROJECT]]);
  assert.deepEqual(recorded[1].queries, ['q'.repeat(200), 'short']);
  assert.deepEqual([recorded[1].requesterLabel, recorded[1].agentName, recorded[1].action, recorded[1].outcome],
    ['Synthetic laptop', 'Synthetic helper', 'search', 'answered']);
  assert.equal(recorded[1].resultsCount, 2);
  assert.equal(recorded[1].at, START.toISOString());
  assert.equal(recorded[0].agentName, null);
  assert.deepEqual(reads(port, { requesterKey: PEER }).map(read => read.projectId), [PROJECT]);
  assert.deepEqual(reads(port, { projectId: 'project-second' }).map(read => read.requesterKey), [GUEST]);
  assert.equal(port.recentReads({ limit: 1 }).reads.length, 1);
  assert.deepEqual(port.recentReads({ requesterKey: 42, limit: 1 }), { ok: false, code: 'requester_invalid' });
  assert.deepEqual(port.recentReads({ projectId: {}, limit: 1 }), { ok: false, code: 'project_invalid' });
});

test('rows older than 90 days are deleted when the next attempt is recorded', async (t) => {
  const time = clock();
  const port = access(t, { time });
  await search(port, { queries: ['old'] });
  time.advance(89 * 24 * 60 * 60 * 1000);
  await search(port, { queries: ['kept'] });
  assert.equal(reads(port).length, 2);
  time.advance(2 * 24 * 60 * 60 * 1000);
  await search(port, { queries: ['new'] });
  assert.deepEqual(reads(port).map(read => read.queries[0]), ['new', 'kept']);
});

test('the store round-trips across reopening the file', async (t) => {
  const path = temporaryPath(t);
  const first = createVisitorAccess({ path, application: application(), now: () => START });
  assert.equal(first.setRequesterMode({ key: PEER, kind: 'peer', label: 'Own desktop', mode: 'trusted', ownDevice: true }).ok, true);
  await first.searchSharedProject({ projectId: PROJECT, requester: VISITOR, queries: ['persisted'] });
  first.close();
  const second = access(t, { path });
  assert.deepEqual(second.requesterMode(PEER), { ok: true, mode: 'trusted' });
  assert.deepEqual(reads(second).map(read => read.queries), [['persisted']]);
});

test('a requester\'s mode defaults to plan, and only the person\'s own peer device can be trusted', (t) => {
  const port = access(t);
  assert.deepEqual(port.requesterMode(PEER), { ok: true, mode: 'plan' });
  assert.deepEqual(port.requesterMode(GUEST), { ok: true, mode: 'ask_only' }, 'a guest link only asks');
  assert.deepEqual(port.setRequesterMode({ key: GUEST, kind: 'guest', label: 'Guest', mode: 'plan', ownDevice: false }),
    { ok: false, code: 'mode_not_allowed' });
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
  assert.deepEqual(port.requesterMode(PEER), { ok: true, mode: 'plan' });

  // A guest link is never run by a rule: neither auto nor trusted (owner decision 2026-11-14).
  assert.deepEqual(port.setRequesterMode({ key: GUEST, kind: 'guest', label: 'Guest', mode: 'auto', ownDevice: false }),
    { ok: false, code: 'mode_not_allowed' });
  const guest = port.setRequesterMode({ key: GUEST, kind: 'guest', label: 'Guest', mode: 'ask_only', ownDevice: true });
  assert.deepEqual(guest, { ok: true, requester: { key: GUEST, kind: 'guest', label: 'Guest', mode: 'ask_only', ownDevice: false,
    modeUpdatedAt: START.toISOString() }, effects: { cancelled: [], returned: [] } });
  assert.equal(port.setRequesterMode({ key: PEER, kind: 'peer', label: 'Own laptop', mode: 'trusted', ownDevice: true }).ok, true);
  assert.deepEqual(port.requesterMode(PEER), { ok: true, mode: 'trusted' });
});

test('a key that is not a string is refused by every entry, never thrown', async (t) => {
  const port = access(t);
  for (const key of [42, null, undefined, {}, [PEER], { toString: () => PEER, startsWith: () => true }]) {
    assert.deepEqual(port.setRequesterMode({ key, kind: 'peer', label: 'x', mode: 'plan', ownDevice: true }),
      { ok: false, code: 'requester_invalid' });
    assert.deepEqual(port.requesterMode(key), { ok: false, code: 'requester_invalid' });
    assert.deepEqual(await search(port, { requester: { key, label: 'x' } }), { ok: false, code: 'requester_invalid' });
  }
  assert.deepEqual(port.setRequesterMode(), { ok: false, code: 'requester_invalid' });
  assert.deepEqual(await port.searchSharedProject(), { ok: false, code: 'requester_invalid' });
});

test('a requester may try 30 times in 10 minutes and 300 times a day, refusals included', async (t) => {
  const time = clock();
  const app = application();
  const port = access(t, { time, app });
  for (let index = 0; index < 30; index += 1) assert.equal((await search(port)).ok, true);
  assert.deepEqual(await search(port), { ok: false, code: 'rate_limited_short' });
  // Another requester has its own count.
  assert.equal((await search(port, { requester: { key: GUEST, label: 'Guest' } })).ok, true);
  time.advance(10 * 60 * 1000);
  // The refused attempt is still inside this window.
  assert.equal((await search(port)).ok, true);

  let answered = 31;
  for (;;) {
    if (answered % 25 === 0) time.advance(10 * 60 * 1000);
    const result = await search(port);
    if (!result.ok) { assert.equal(result.code, 'rate_limited_day'); break; }
    answered += 1;
  }
  // 300 attempts in the day: 299 answered and the one short-window refusal.
  assert.equal(answered, 299);
  time.advance(24 * 60 * 60 * 1000);
  assert.equal((await search(port)).ok, true);
});

test('a rotated label with the same key shares one budget', async (t) => {
  const port = access(t);
  for (let index = 0; index < 30; index += 1) {
    assert.equal((await search(port, { requester: { key: PEER, label: `Label ${index}` } })).ok, true);
  }
  assert.deepEqual(await search(port, { requester: { key: PEER, label: 'A fresh name' } }),
    { ok: false, code: 'rate_limited_short' });
});

test('parallel searches cannot all pass the limit', async (t) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = application(async () => { await gate; return { facts: [], entities: [] }; });
  const port = access(t, { app });
  const pending = Array.from({ length: 40 }, () => search(port));
  release();
  const results = await Promise.all(pending);
  assert.equal(results.filter(result => result.ok).length, 30);
  assert.equal(results.filter(result => result.code === 'rate_limited_short').length, 10);
  assert.equal(app.requests.length, 30);
});

test('a flood of refusals is recorded only up to a bound', async (t) => {
  const path = temporaryPath(t);
  const port = access(t, { path });
  for (let index = 0; index < 1100; index += 1) await search(port, { queries: [] });
  assert.ok(reads(port).every(read => read.outcome === 'refused'));
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare('SELECT code, COUNT(*) AS count FROM visitor_reads GROUP BY code ORDER BY code').all()
      .map(row => [row.code, row.count]);
    assert.deepEqual(rows, [['queries_missing', 30], ['rate_limited_short', 970]]);
  } finally { database.close(); }
});
