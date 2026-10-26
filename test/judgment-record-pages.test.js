import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { handleJudgmentApiRequest } from '../src/judgment/http.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { ownerProofPort } from '../test-support/owner-proof-port.js';

// The console's Tonborg records page: cursor pages, search across every
// record (not only a loaded page) and the 需要人工 view, all in the store.
// Synthetic records and project names only.

const projects = [{ project_id: 'p-garden', profile: { name: 'Synthetic Garden' } },
  { project_id: 'p-river', profile: { name: 'Synthetic River' } }];
const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => projects };

function judgmentWith(t, count) {
  const judgment = createJudgmentService({ app });
  t.after(() => judgment.close());
  const store = judgment.store();
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(store.record('s', { personalProjectId: index % 2 ? 'p-river' : 'p-garden', kind: 'routing', target: `job-${index}`,
      title: `Synthetic record ${index}`, summary: `Plain conclusion ${index}`, evidence: [], outcome: 'recommend',
      policy: { mode: 'shared' }, client: 'codex', model: 'synthetic-model' }, `request-${index}`).id);
  }
  return { judgment, store, ids };
}

function get(judgment, query) {
  const sent = { headers: {} };
  const response = { setHeader(name, value) { sent.headers[name] = value; }, writeHead(status) { sent.status = status; },
    end(text) { sent.body = JSON.parse(text); } };
  const path = `/api/judgment/records?${new URLSearchParams({ personalSpaceId: 's', ...query })}`;
  const request = Object.assign(Readable.from([]), { method: 'GET', url: path, headers: { host: '127.0.0.1:4317' },
    socket: { remoteAddress: '127.0.0.1' } });
  return handleJudgmentApiRequest({ request, response, url: new URL(`http://127.0.0.1${path}`), app: { ...app, judgment },
    ownerReads: ownerProofPort().port }).then(() => sent);
}

test('records come in cursor pages, newest first, with no record repeated or skipped', async t => {
  const { judgment, ids } = judgmentWith(t, 7);
  const seen = [];
  let after = null;
  for (const size of [3, 3, 1]) {
    const { status, body } = await get(judgment, { limit: '3', ...(after ? { after } : {}) });
    assert.equal(status, 200);
    assert.equal(body.records.length, size);
    seen.push(...body.records.map(record => record.id));
    after = body.nextCursor;
  }
  assert.equal(after, null, 'the last page has no next cursor');
  assert.deepEqual(seen, [...ids].reverse());
});

test('search reaches every record, not only the first page, by words, reasons, source and project name', async t => {
  const { judgment, store, ids } = judgmentWith(t, 60);
  const oldest = ids[0];
  store.feedback('s', ids[1], 'down', 'Synthetic reason about tabs', 0);
  store.execute('s', ids[2], 'stale', { reason: 'Synthetic receipt drift' });

  const byTitle = await get(judgment, { search: 'record 0', limit: '10' });
  assert.deepEqual(byTitle.body.records.map(record => record.id), [oldest]);
  assert.equal(byTitle.body.nextCursor, null);
  assert.deepEqual((await get(judgment, { search: 'reason about TABS' })).body.records.map(record => record.id), [ids[1]]);
  assert.deepEqual((await get(judgment, { search: 'receipt drift' })).body.records.map(record => record.id), [ids[2]]);
  assert.equal((await get(judgment, { search: 'synthetic-model', limit: '100' })).body.records.length, 60);

  const garden = [];
  let after = null;
  do {
    const { body } = await get(judgment, { search: 'garden', limit: '20', ...(after ? { after } : {}) });
    garden.push(...body.records);
    after = body.nextCursor;
  } while (after);
  assert.equal(garden.length, 30);
  assert.ok(garden.every(record => record.personalProjectId === 'p-garden'));

  // LIKE wildcards are the person's text, not patterns.
  assert.deepEqual((await get(judgment, { search: '%' })).body.records, []);
  assert.deepEqual((await get(judgment, { search: 'record_1' })).body.records, []);
});

test('the human-needed view pages only records that wait for the person', async t => {
  const { judgment, store, ids } = judgmentWith(t, 5);
  const escalated = store.record('s', { personalProjectId: 'p-garden', kind: 'review', target: 'entity:a', title: 'Synthetic escalation',
    summary: 'Needs you', evidence: [], outcome: 'escalate', policy: { mode: 'shared' } }, 'request-escalate').id;
  const manual = store.record('s', { personalProjectId: 'p-river', kind: 'routing', target: 'job-manual', title: 'Synthetic manual',
    summary: 'Waits', evidence: [], outcome: 'recommend', policy: { mode: 'manual' } }, 'request-manual').id;
  store.execute('s', manual, 'applied', {});
  store.execute('s', ids[3], 'failed', { reason: 'Synthetic failure' });

  const first = await get(judgment, { filter: 'human', limit: '1' });
  assert.deepEqual(first.body.records.map(record => record.id), [escalated]);
  const second = await get(judgment, { filter: 'human', limit: '1', after: first.body.nextCursor });
  assert.deepEqual(second.body.records.map(record => record.id), [ids[3]]);
  assert.equal(second.body.nextCursor, null);
  assert.deepEqual((await get(judgment, { filter: 'human', search: 'escalation' })).body.records.map(record => record.id), [escalated]);
});

test('a page request outside the limits is refused', async t => {
  const { judgment } = judgmentWith(t, 1);
  await assert.rejects(get(judgment, { limit: '0' }), { name: 'TypeError' });
  await assert.rejects(get(judgment, { limit: 'many' }), { name: 'TypeError' });
  await assert.rejects(get(judgment, { filter: 'others' }), { name: 'TypeError' });
});
