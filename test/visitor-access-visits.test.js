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
// per-project limits, the lead checks, cards that cannot fail open, display
// names that never decide validity, the pre-release store. Synthetic data only.
const application = (search = async () => ({ facts: [], entities: [] })) => ({
  config: { personal: { spaceId: 'space' } }, personal: { search } });
const device = (index) => ({ key: `peer:${index.toString(16).padStart(64, '0')}`, label: `Device ${index}`, agentName: null });
const showCard = (port, { card, ...input }) => port.showSharedCard({ ...input, card: async () => card });

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
        : await showCard(port, { projectId: 'shared', requester: device(index), card: { name: 'Lead' } });
      assert.equal(answer.ok, true, `read ${index}`);
    }
    assert.deepEqual(await port.searchSharedProject({ projectId: 'shared', requester: device(61), queries: ['q'] }),
      { ok: false, code: 'project_rate_limited_short' });
    assert.deepEqual(await showCard(port, { projectId: 'shared', requester: device(62), card: {} }),
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
      clock = new Date(Date.parse('2026-11-14T00:00:00.000Z') + index * 66_000); // under 10 per 10 minutes
      assert.equal((await showCard(port, { projectId: 'shared', requester: device(index), card: {} })).ok, true, `read ${index}`);
    }
    clock = new Date(clock.getTime() + 60_000);
    assert.deepEqual(await showCard(port, { projectId: 'shared', requester: device(601), card: {} }),
      { ok: false, code: 'project_rate_limited_day' });
  } finally { port.close(); }
});

test('a pre-port refusal is recorded against the proven device, with its project when known, and counted', async () => {
  const port = createVisitorAccess({ application: application() });
  try {
    assert.deepEqual(port.recordRefusedVisit({ requester: device(1), action: 'search', code: 'origin_rejected', projectId: 'shared' }), { ok: true });
    for (let index = 1; index < 30; index += 1) {
      assert.deepEqual(port.recordRefusedVisit({ requester: device(1), action: 'search', code: 'origin_rejected' }), { ok: true });
    }
    assert.deepEqual(await showCard(port, { projectId: 'shared', requester: device(1), card: {} }), { ok: false, code: 'rate_limited_short' });
    const rows = port.recentReads({ limit: 50 }).reads;
    assert.deepEqual(rows.at(-1).projectId, 'shared', 'the probed project is named when the share is known');
    assert.deepEqual(rows.at(-2).projectId, '', 'and none when it is not');
    assert.deepEqual(port.recordRefusedVisit({ requester: device(1), action: 'wake', code: 'x' }), { ok: false, code: 'refusal_invalid' });
    assert.deepEqual(port.recordRefusedVisit({ requester: { key: 'peer:abc', label: 'x' }, action: 'card', code: 'x' }),
      { ok: false, code: 'requester_invalid' });
  } finally { port.close(); }
});

test('display names never decide validity: empty, blank, control-only and huge names are counted and recorded', async () => {
  const port = createVisitorAccess({ application: application() });
  try {
    const names = ['', '   ', '\u202e\u200b\u0007', 'n'.repeat(5000)];
    for (const [index, name] of names.entries()) {
      const requester = { key: device(index + 1).key, label: name, agentName: name };
      assert.equal((await port.searchSharedProject({ projectId: 'shared', requester, queries: ['q'] })).ok, true, JSON.stringify(name.slice(0, 5)));
      assert.equal((await showCard(port, { projectId: 'shared', requester, card: {} })).ok, true);
      assert.deepEqual(port.recordRefusedVisit({ requester, action: 'card', code: 'origin_rejected' }), { ok: true });
    }
    const rows = port.recentReads({ limit: 50 }).reads;
    assert.equal(rows.length, 12);
    for (const row of rows) {
      assert.ok(row.requesterLabel.length > 0 && row.requesterLabel.length <= 120, row.requesterLabel);
      assert.ok(row.agentName === null || row.agentName.length === 120);
    }
    assert.ok(rows.some((row) => row.requesterLabel === device(1).key.slice(0, 17)), 'an empty label becomes the start of the key');
    // A blank name is counted toward its device's limit like any other.
    const blank = { key: device(9).key, label: '\u202e', agentName: '' };
    for (let index = 0; index < 30; index += 1) await port.searchSharedProject({ projectId: 'shared', requester: blank, queries: ['q'] });
    assert.deepEqual(await port.searchSharedProject({ projectId: 'shared', requester: blank, queries: ['q'] }),
      { ok: false, code: 'rate_limited_short' });
  } finally { port.close(); }
});

test('a card never exceeds its bound, whatever the names are', () => {
  for (const text of ['"'.repeat(300), '😀'.repeat(300), '\\'.repeat(300), '名'.repeat(300)]) {
    const { card, bytes } = sharedCard({ name: text, responsibility: text.repeat(3), projectName: text });
    assert.ok(bytes <= 700 && Buffer.byteLength(JSON.stringify(card)) === bytes, `${text[0]}: ${bytes}`);
    assert.ok(card.name.length > 0 && card.projectName.length > 0);
  }
});

test('a card that cannot be built is a code, and its row is finished as failed', async () => {
  const port = createVisitorAccess({ application: application() });
  try {
    const broken = { get name() { throw new Error('C:\\private\\leak'); } };
    assert.deepEqual(await showCard(port, { projectId: 'shared', requester: device(1), card: broken }), { ok: false, code: 'card_unavailable' });
    assert.deepEqual(await port.showSharedCard({ projectId: 'shared', requester: device(1), card: async () => { throw new Error('x'); } }),
      { ok: false, code: 'card_unavailable' });
    assert.deepEqual(port.recentReads({ limit: 2 }).reads.map((row) => [row.action, row.outcome, row.code]),
      [['card', 'failed', 'card_unavailable'], ['card', 'failed', 'card_unavailable']]);
  } finally { port.close(); }
});

test('a visitor-access file from a pre-release build is set aside on open; its rows are kept and new reads work', async (t) => {
  const path = temporaryPath(t);
  const first = createVisitorAccess({ path, application: application() });
  assert.equal(first.setRequesterMode({ key: device(1).key, kind: 'peer', label: 'Desk', mode: 'ask_only' }).ok, true);
  first.close();
  // The table as a pre-release build of the visiting assistant made it: no outcome, search only, with one row.
  const database = new DatabaseSync(path);
  database.exec(`DROP INDEX visitor_reads_at; DROP INDEX visitor_reads_requester_at; DROP TABLE visitor_reads;
    CREATE TABLE visitor_reads(id INTEGER PRIMARY KEY AUTOINCREMENT, requester_key TEXT NOT NULL, requester_label TEXT NOT NULL,
      agent_name TEXT, project_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('search')), queries_json TEXT NOT NULL,
      results_count INTEGER NOT NULL, bytes INTEGER NOT NULL, at TEXT NOT NULL);
    CREATE INDEX visitor_reads_at ON visitor_reads(at);
    INSERT INTO visitor_reads(requester_key, requester_label, agent_name, project_id, action, queries_json, results_count, bytes, at)
      VALUES ('${device(1).key}', 'Desk', NULL, 'shared', 'search', '["old"]', 1, 10, '2026-11-13T00:00:00.000Z');`);
  database.close();
  const warnings = [];
  const port = createVisitorAccess({ path, application: application(), warn: (line) => warnings.push(line) });
  try {
    assert.equal((await showCard(port, { projectId: 'shared', requester: device(1), card: { name: 'Lead' } })).ok, true);
    assert.deepEqual(port.recentReads({ limit: 5 }).reads.map((row) => [row.action, row.outcome]), [['card', 'answered']]);
    assert.deepEqual(port.requesterMode(device(1).key), { ok: true, mode: 'ask_only' }, 'requesters are untouched');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /visitor_reads_prerelease_1/);
  } finally { port.close(); }
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(check.prepare('SELECT queries_json FROM visitor_reads_prerelease_1').all().map((row) => row.queries_json), ['["old"]']);
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND tbl_name = 'visitor_reads'").get().count, 2);
  } finally { check.close(); }
  // Opening it again changes nothing more.
  const again = createVisitorAccess({ path, application: application(), warn: (line) => warnings.push(line) });
  try { assert.equal(again.recentReads({ limit: 5 }).reads.length, 1); } finally { again.close(); }
  assert.equal(warnings.length, 1);
});

function hostWith({ lead, policy, visitorAccess, reads = { count: 0 } }) {
  return createFuliRoundtableHost({ config: { personal: { spaceId: 'space' } }, visitorAccess,
    personal: {
      getProjectAgentCoordinationPolicy: async () => { reads.count += 1; if (policy instanceof Error) throw policy; return policy; },
      getPersonalProject: async () => { reads.count += 1; return { project_id: 'shared', name: 'Shared project' }; },
      listProjectAgents: async () => { reads.count += 1; return lead ? [{ agent_id: lead, profile: { status: 'active', name: 'Lead' },
        assignments: [{ personal_project_id: 'shared', status: 'active' }] }] : []; },
    },
    listProjectAgents: async () => [] }, { warn: () => {} });
}
const hostRequester = (index = 1) => ({ node: index.toString(16).padStart(64, '0'), name: 'Device · 0000', agentName: null });

test('the host answers only while the share\'s Agent is, as read now, the project\'s lead; a refusal finishes the reserved row', async () => {
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
      const answer = await host.searchSharedProject({ projectId: 'shared', agentId, requester: hostRequester(),
        query: action === 'search' ? { action, queries: ['q'] } : { action } });
      assert.deepEqual(answer, { ok: false, code: 'query_refused' }, `${action} ${code}`);
      const rows = visitorAccess.recentReads({ limit: 5 }).reads;
      assert.deepEqual(rows.map((row) => [row.action, row.outcome, row.code]), [[action, 'refused', code]], `${action} ${code}`);
    } finally { visitorAccess.close(); }
  }
  const visitorAccess = createVisitorAccess({ application: application() });
  try {
    const host = hostWith({ policy: { team_lead_agent_id: 'lead' }, visitorAccess, lead: 'lead' });
    assert.equal((await host.searchSharedProject({ projectId: 'shared', agentId: 'lead', requester: hostRequester(),
      query: { action: 'search', queries: ['q'] } })).ok, true);
  } finally { visitorAccess.close(); }
});

test('a rate-limited device makes this computer do no Provider read at all', async () => {
  const visitorAccess = createVisitorAccess({ application: application() });
  const reads = { count: 0 };
  try {
    const host = hostWith({ policy: { team_lead_agent_id: 'lead' }, visitorAccess, lead: 'lead', reads });
    for (let index = 0; index < 30; index += 1) {
      visitorAccess.recordRefusedVisit({ requester: { key: `peer:${hostRequester().node}`, label: 'x' }, action: 'card', code: 'origin_rejected' });
    }
    for (const query of [{ action: 'card' }, { action: 'search', queries: ['q'] }]) {
      assert.deepEqual(await host.searchSharedProject({ projectId: 'shared', agentId: 'lead', requester: hostRequester(), query }),
        { ok: false, code: 'rate_limited_short' });
    }
    assert.equal(reads.count, 0, 'no lead, team or project read for a refused attempt');
  } finally { visitorAccess.close(); }
});
