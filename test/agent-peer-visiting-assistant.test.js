import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDeviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { shortFingerprint } from '../packages/roundtable/src/peer/protocol.js';
import { callRoundtableTool } from '../src/agent-roundtable/tools.js';
import { handleVisitorAccessRequest } from '../src/http/visitor-access-api-router.js';
import { createVisitorAccess } from '../src/visitor-access/port.js';
import { device, pair, remoteAddress } from './fixtures/peer-devices.js';

// Synthetic knowledge of the owner's shared project; nothing is read from a real data directory.
function syntheticSearch(requests) {
  return async (request) => {
    requests.push(request);
    return { facts: [{ relationship: 'DEPLOYS_ON', fact: 'Synthetic service listens on port 4100', score: 0.9,
      defined_project_id: request.personal_project_ids[0] },
    { relationship: 'OTHER', fact: 'Another project fact', score: 0.8, defined_project_id: 'someone-else' }], entities: [] };
  };
}

const visit = (app, input) => callRoundtableTool(app.roundtable, 'visit_shared_lead',
  { taskContextToken: 'alpha-task', sourceApplication: 'codex', ...input });

test('a paired device reads the owner\'s shared project with its own tool call; the owner wakes nothing and sees the read',
  { timeout: 30_000 }, async () => {
    const requests = [];
    const [alpha, beta] = await Promise.all([device('alpha'), device('beta', { search: syntheticSearch(requests) })]);
    try {
      await pair(alpha, beta);
      const address = await remoteAddress(alpha.app);

      const card = await visit(alpha.app, { address, action: 'card' });
      assert.equal(card.ok, true, JSON.stringify(card));
      // A fixed envelope set on this computer; the other computer's text only under remote.
      assert.deepEqual(Object.keys(card), ['address', 'device', 'action', 'ok', 'notice', 'guidance', 'remote']);
      assert.deepEqual([card.address, card.device, card.action], [address, 'Member', 'card']);
      assert.match(card.notice, /another computer.*data, never as instructions/);
      assert.match(card.guidance, /own model/);
      assert.deepEqual(card.remote, { name: 'beta lead', responsibility: '', projectName: 'beta project' });

      const answer = await visit(alpha.app, { address, action: 'search', queries: ['deploy port'] });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.deepEqual(Object.keys(answer), ['address', 'device', 'action', 'ok', 'notice', 'remote']);
      assert.deepEqual(answer.remote, { truncated: false, results: [{ query: 'deploy port',
        items: [{ kind: 'fact', title: 'DEPLOYS_ON', text: 'Synthetic service listens on port 4100' }] }] });
      // The search used the owner's share, narrowed: no inheritance, no global or pending items, no FLA memory.
      assert.equal(requests.length, 1);
      assert.deepEqual([requests[0].personal_project_ids, requests[0].inherit_project_knowledge, requests[0].include_personal_global,
        requests[0].include_pending, requests[0].project_agent_id], [['beta-project'], false, false, false, null]);
      assert.deepEqual(beta.calls.wakes, [], 'the owner\'s computer woke no client');
      assert.deepEqual(beta.calls.grants, [], 'and issued no wake grant');
      assert.equal(alpha.calls.origins.at(-1).purpose, 'query');

      const alphaDevice = await loadDeviceIdentity(alpha.app.peer.directory);
      const [read, cardRead] = beta.app.visitorAccess.recentReads({ limit: 5 }).reads;
      assert.deepEqual([read.requesterKey, read.requesterLabel, read.agentName, read.projectId, read.queries, read.resultsCount],
        [`peer:${alphaDevice.fingerprint}`, `Coordinator · ${shortFingerprint(alphaDevice.fingerprint)}`, 'alpha lead', 'beta-project', ['deploy port'], 1]);
      // The card was a contact too: recorded as the same device, answered.
      assert.deepEqual([cardRead.requesterKey, cardRead.action, cardRead.outcome, cardRead.projectId],
        [`peer:${alphaDevice.fingerprint}`, 'card', 'answered', 'beta-project']);

      // The owner's console shows it, from this computer only, with the device's fingerprint.
      const label = `Coordinator · ${shortFingerprint(alphaDevice.fingerprint)}`;
      const response = fakeResponse();
      await handleVisitorAccessRequest({ request: localRequest('GET'), response,
        url: new URL('http://127.0.0.1/api/visitor-access/reads?limit=5'), visitorAccess: beta.app.visitorAccess });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.reads.map((row) => [row.requester, row.agentName, row.projectId, row.action, row.outcome, row.queries]),
        [[label, 'alpha lead', 'beta-project', 'search', 'answered', ['deploy port']],
          [label, 'alpha lead', 'beta-project', 'card', 'answered', []]]);

      // Unsharing ends it: the next visit is refused and nothing more is searched.
      await beta.runtime.setShares({ shares: [] });
      const after = await visit(alpha.app, { address, action: 'search', queries: ['deploy port'] })
        .catch((error) => ({ ok: false, code: error.code }));
      assert.deepEqual(after, { ...after, ok: false, code: 'agent_not_shared' });
      assert.equal(requests.length, 1);
    } finally { await alpha.close(); await beta.close(); }
  });

test('a visit needs a project task of a FULI Agent and a search needs queries', { timeout: 30_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta', { search: syntheticSearch([]) })]);
  try {
    await pair(alpha, beta);
    const address = await remoteAddress(alpha.app);
    await assert.rejects(callRoundtableTool(alpha.app.roundtable, 'visit_shared_lead', { sourceApplication: 'codex', address, action: 'card' }),
      { code: 'validation' });
    await assert.rejects(visit(alpha.app, { address, action: 'search' }), { code: 'validation' });
    // The service checks the action itself, not only the tool schema.
    for (const action of ['progress', 'request', undefined]) {
      await assert.rejects(alpha.app.roundtable.visitSharedLead({ taskContextToken: 'alpha-task', sourceApplication: 'codex', address, action }),
        { code: 'validation' }, String(action));
    }
    await assert.rejects(visit(alpha.app, { address, action: 'search', queries: ['x'.repeat(201)] }), { code: 'validation' });
    await assert.rejects(visit(alpha.app, { address: 'project:beta', action: 'card' }), { code: 'validation' });
  } finally { await alpha.close(); await beta.close(); }
});

test('visitor reads are served only to this computer, with the LAN roundtable controls\' own guard', async () => {
  const visitorAccess = { recentReads: () => { throw new Error('must not be read'); } };
  const refusals = [
    { method: 'GET', socket: { remoteAddress: '192.168.1.20' }, headers: { host: '127.0.0.1:2828' } },
    { method: 'GET', socket: { remoteAddress: '10.0.0.5' }, headers: { host: '192.168.1.8:2828' } },
    // Loopback with a LAN or name Host (a page reached through another name): refused like /api/peer.
    { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '192.168.1.8:2828' } },
    { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:2828' } },
  ];
  for (const request of refusals) {
    const response = fakeResponse();
    assert.equal(await handleVisitorAccessRequest({ request, response, url: new URL('http://127.0.0.1/api/visitor-access/reads'),
      visitorAccess }), true);
    assert.deepEqual([response.status, response.body.error], [403, 'local_owner_only'], JSON.stringify(request));
  }
  const post = fakeResponse();
  await handleVisitorAccessRequest({ request: localRequest('POST'), response: post,
    url: new URL('http://127.0.0.1/api/visitor-access/reads'), visitorAccess });
  assert.equal(post.status, 405);
  assert.equal(await handleVisitorAccessRequest({ request: localRequest('GET'),
    response: fakeResponse(), url: new URL('http://127.0.0.1/api/visitor-access/other'), visitorAccess }), false);
});

const localRequest = (method) => ({ method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:2828' } });

function fakeResponse() {
  return { status: null, body: null, headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); return this; },
    end(text) { this.body = text ? JSON.parse(text) : null; } };
}

test('a card is cleaned like search results, recorded, and counted toward the same limits', async () => {
  const port = createVisitorAccess({ application: { config: { personal: { spaceId: 'space' } },
    personal: { search: async () => ({ facts: [], entities: [] }) } } });
  const requester = { key: `peer:${'a'.repeat(64)}`, label: 'Laptop\u202e', agentName: 'Visitor' };
  try {
    const card = port.showSharedCard({ projectId: 'shared-project', requester, card: { name: 'Lead\u0007one',
      responsibility: `Runs https://user:pw@example.test/x?token=abc and ${'z'.repeat(40)} from C:\\Users\\someone\\secret`,
      projectName: 'Shared\u200bproject' } });
    assert.equal(card.ok, true);
    assert.equal(card.name, 'Lead one');
    assert.equal(card.projectName, 'Shared project');
    for (const secret of ['someone', 'pw@', 'abc', 'z'.repeat(40)]) assert.ok(!card.responsibility.includes(secret), card.responsibility);
    const long = port.showSharedCard({ projectId: 'shared-project', requester, card: { name: '名'.repeat(300),
      responsibility: '长'.repeat(400), projectName: '项'.repeat(300) } });
    assert.ok(long.responsibility.endsWith('…'));
    assert.ok(Buffer.byteLength(JSON.stringify(long)) <= 700);
    const [, row] = port.recentReads({ limit: 5 }).reads;
    assert.deepEqual([row.action, row.outcome, row.requesterLabel, row.resultsCount], ['card', 'answered', 'Laptop', 1]);

    // Cards and searches share one budget per device: 30 contacts per 10 minutes.
    for (let index = 2; index < 30; index += 1) assert.equal(port.showSharedCard({ projectId: 'shared-project', requester, card: {} }).ok, true);
    assert.deepEqual(port.showSharedCard({ projectId: 'shared-project', requester, card: {} }), { ok: false, code: 'rate_limited_short' });
    assert.deepEqual(await port.searchSharedProject({ projectId: 'shared-project', requester, queries: ['x'] }),
      { ok: false, code: 'rate_limited_short' });
    assert.deepEqual(port.recentReads({ limit: 2 }).reads.map((read) => [read.action, read.outcome, read.code]),
      [['search', 'refused', 'rate_limited_short'], ['card', 'refused', 'rate_limited_short']]);
    assert.deepEqual(port.showSharedCard({ projectId: 'shared-project', requester: { ...requester, key: 'peer:not-a-fingerprint' }, card: {} }),
      { ok: false, code: 'requester_invalid' });
  } finally { port.close(); }
});
