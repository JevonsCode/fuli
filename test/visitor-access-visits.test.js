import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { sharedCard } from '../src/visitor-access/shared-project-search.js';
import { createVisitorAccess } from '../src/visitor-access/port.js';

// The visiting assistant's use of the visitor-access port and the FULI host:
// per-project limits, the lead checks, cards that cannot fail open, the
// pre-release store. Synthetic data only.
const application = (search = async () => ({ facts: [], entities: [] })) => ({
  config: { personal: { spaceId: 'space' } }, personal: { search } });
const device = (index) => ({ key: `peer:${index.toString(16).padStart(64, '0')}`, label: `Device ${index}`, agentName: null });

function temporaryPath(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-visitor-visits-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'visitor-access.sqlite');
}

test('one shared project is read at most 60 times in 10 minutes by everyone together; refusals keep their own code', async () => {
  const port = createVisitorAccess({ application: application() });
  try {
    // 60 different devices (as a coordinator inventing devices could make), one read each.
    for (let index = 1; index <= 60; index += 1) {
      const answer = index % 2 ? await port.searchSharedProject({ projectId: 'shared', requester: device(index), queries: ['q'] })
        : port.showSharedCard({ projectId: 'shared', requester: device(index), card: { name: 'Lead' } });
      assert.equal(answer.ok, true, `read ${index}`);
    }
    assert.deepEqual(await port.searchSharedProject({ projectId: 'shared', requester: device(61), queries: ['q'] }),
      { ok: false, code: 'project_rate_limited_short' });
    assert.deepEqual(port.showSharedCard({ projectId: 'shared', requester: device(62), card: {} }),
      { ok: false, code: 'project_rate_limited_short' });
    const [refusal] = port.recentReads({ limit: 1 }).reads;
    assert.deepEqual([refusal.outcome, refusal.code, refusal.projectId], ['refused', 'project_rate_limited_short', 'shared']);
    // Refusals are not reads: they never extend the project's limit, and another project is unaffected.
    assert.equal((await port.searchSharedProject({ projectId: 'other', requester: device(63), queries: ['q'] })).ok, true);
  } finally { port.close(); }
});

test('the project limit is 600 a day across requesters', async () => {
  let clock = new Date('2026-11-14T00:00:00.000Z');
  const port = createVisitorAccess({ application: application(), now: () => clock });
  try {
    for (let index = 1; index <= 600; index += 1) {
      clock = new Date(Date.parse('2026-11-14T00:00:00.000Z') + index * 11 * 1000 * 6); // 66 s apart: under 10 per 10 minutes
      assert.equal(port.showSharedCard({ projectId: 'shared', requester: device(index), card: {} }).ok, true, `read ${index}`);
    }
    clock = new Date(clock.getTime() + 60_000);
    assert.deepEqual(port.showSharedCard({ projectId: 'shared', requester: device(601), card: {} }),
      { ok: false, code: 'project_rate_limited_day' });
  } finally { port.close(); }
});

test('a pre-port refusal is recorded against the proven device and counted toward its limits', async () => {
  const port = createVisitorAccess({ application: application() });
  try {
    for (let index = 0; index < 30; index += 1) {
      assert.deepEqual(port.recordRefusedVisit({ requester: device(1), action: 'search', code: 'origin_rejected' }), { ok: true });
    }
    assert.deepEqual(port.showSharedCard({ projectId: 'shared', requester: device(1), card: {} }), { ok: false, code: 'rate_limited_short' });
    const [latest, earlier] = port.recentReads({ limit: 2 }).reads;
    assert.deepEqual([latest.code, earlier.code, earlier.outcome, earlier.projectId], ['rate_limited_short', 'origin_rejected', 'refused', '']);
    assert.deepEqual(port.recordRefusedVisit({ requester: device(1), action: 'wake', code: 'x' }), { ok: false, code: 'refusal_invalid' });
    assert.deepEqual(port.recordRefusedVisit({ requester: { key: 'peer:abc', label: 'x' }, action: 'card', code: 'x' }),
      { ok: false, code: 'requester_invalid' });
  } finally { port.close(); }
});

test('a card never exceeds its bound, whatever the names are', () => {
  for (const text of ['"'.repeat(300), '😀'.repeat(300), '\\'.repeat(300), '名'.repeat(300)]) {
    const { card, bytes } = sharedCard({ name: text, responsibility: text.repeat(3), projectName: text });
    assert.ok(bytes <= 700 && Buffer.byteLength(JSON.stringify(card)) === bytes, `${text[0]}: ${bytes}`);
    assert.ok(card.name.length > 0 && card.projectName.length > 0);
  }
});

test('a card that cannot be built is a code, and its row is finished as failed', () => {
  const port = createVisitorAccess({ application: application() });
  try {
    const broken = { get name() { throw new Error('C:\\private\\leak'); } };
    assert.deepEqual(port.showSharedCard({ projectId: 'shared', requester: device(1), card: broken }), { ok: false, code: 'card_unavailable' });
    const [row] = port.recentReads({ limit: 1 }).reads;
    assert.deepEqual([row.action, row.outcome, row.code], ['card', 'failed', 'card_unavailable']);
  } finally { port.close(); }
});

test('a visitor-access file from a pre-release build is refused whole, with a code, never written', (t) => {
  const path = temporaryPath(t);
  const first = createVisitorAccess({ path, application: application() });
  assert.equal(first.showSharedCard({ projectId: 'shared', requester: device(1), card: {} }).ok, true);
  first.close();
  // The table as a pre-release build of the visiting assistant made it: no outcome, search only.
  const database = new DatabaseSync(path);
  database.exec(`DROP TABLE visitor_reads;
    CREATE TABLE visitor_reads(id INTEGER PRIMARY KEY AUTOINCREMENT, requester_key TEXT NOT NULL, requester_label TEXT NOT NULL,
      agent_name TEXT, project_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('search')), queries_json TEXT NOT NULL,
      results_count INTEGER NOT NULL, bytes INTEGER NOT NULL, at TEXT NOT NULL);`);
  database.close();
  const port = createVisitorAccess({ path, application: application() });
  try {
    assert.deepEqual(port.showSharedCard({ projectId: 'shared', requester: device(1), card: {} }), { ok: false, code: 'visitor_store_outdated' });
    assert.deepEqual(port.recentReads({ limit: 5 }), { ok: false, code: 'visitor_store_outdated' });
    assert.deepEqual(port.requesterMode(device(1).key), { ok: false, code: 'visitor_store_outdated' });
  } finally { port.close(); }
  const check = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(check.prepare('SELECT COUNT(*) AS count FROM visitor_reads').get().count, 0, 'nothing was written'); }
  finally { check.close(); }
});

function hostWith({ lead, policy, visitorAccess }) {
  return createFuliRoundtableHost({ config: { personal: { spaceId: 'space' } }, visitorAccess,
    personal: {
      getProjectAgentCoordinationPolicy: async () => { if (policy instanceof Error) throw policy; return policy; },
      getPersonalProject: async () => ({ project_id: 'shared', name: 'Shared project' }),
      listProjectAgents: async () => (lead ? [{ agent_id: lead, profile: { status: 'active', name: 'Lead' },
        assignments: [{ personal_project_id: 'shared', status: 'active' }] }] : []),
    },
    listProjectAgents: async () => [] }, { warn: () => {} });
}

test('the host answers only while the share\'s Agent is, as read now, the project\'s lead', async () => {
  const requester = { node: '1'.padStart(64, '0'), name: 'Device · 0000', agentName: null };
  const cases = [
    // [what the policy read gives, the share's agentId, the action, the recorded code]
    [{ team_lead_agent_id: null }, null, 'search', 'lead_unreadable'],
    [{ team_lead_agent_id: null }, '', 'card', 'lead_unreadable'],
    [new Error('graph unavailable'), 'lead', 'search', 'lead_unreadable'],
    [new Error('graph unavailable'), 'lead', 'card', 'lead_unreadable'],
    [{ team_lead_agent_id: 'someone-else' }, 'lead', 'search', 'lead_changed'],
  ];
  for (const [policy, agentId, action, code] of cases) {
    const visitorAccess = createVisitorAccess({ application: application(async () => { throw new Error('must not search'); }) });
    try {
      const host = hostWith({ policy, visitorAccess, lead: policy?.team_lead_agent_id ?? null });
      const answer = await host.searchSharedProject({ projectId: 'shared', agentId, requester,
        query: action === 'search' ? { action, queries: ['q'] } : { action } });
      assert.deepEqual(answer, { ok: false, code: 'query_refused' }, `${action} ${code}`);
      const [row] = visitorAccess.recentReads({ limit: 1 }).reads;
      assert.deepEqual([row?.outcome, row?.code], ['refused', code], `${action} ${code}`);
    } finally { visitorAccess.close(); }
  }
  const visitorAccess = createVisitorAccess({ application: application() });
  try {
    const host = hostWith({ policy: { team_lead_agent_id: 'lead' }, visitorAccess, lead: 'lead' });
    assert.equal((await host.searchSharedProject({ projectId: 'shared', agentId: 'lead', requester,
      query: { action: 'search', queries: ['q'] } })).ok, true);
  } finally { visitorAccess.close(); }
});
