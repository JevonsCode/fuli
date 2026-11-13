import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDeviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { callRoundtableTool } from '../src/agent-roundtable/tools.js';
import { handleVisitorAccessRequest } from '../src/http/visitor-access-api-router.js';
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
      assert.deepEqual([card.action, card.name, card.projectName], ['card', 'beta lead', 'beta project']);
      assert.match(card.guidance, /own model/);

      const answer = await visit(alpha.app, { address, action: 'search', queries: ['deploy port'] });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.deepEqual(answer.results, [{ query: 'deploy port',
        items: [{ kind: 'fact', title: 'DEPLOYS_ON', text: 'Synthetic service listens on port 4100' }] }]);
      // The search used the owner's share, narrowed: no inheritance, no global or pending items, no FLA memory.
      assert.equal(requests.length, 1);
      assert.deepEqual([requests[0].personal_project_ids, requests[0].inherit_project_knowledge, requests[0].include_personal_global,
        requests[0].include_pending, requests[0].project_agent_id], [['beta-project'], false, false, false, null]);
      assert.deepEqual(beta.calls.wakes, [], 'the owner\'s computer woke no client');
      assert.deepEqual(beta.calls.grants, [], 'and issued no wake grant');
      assert.equal(alpha.calls.origins.at(-1).purpose, 'query');

      const alphaDevice = await loadDeviceIdentity(alpha.app.peer.directory);
      const [read] = beta.app.visitorAccess.recentReads({ limit: 5 });
      assert.deepEqual([read.requesterKey, read.requesterLabel, read.agentName, read.projectId, read.queries, read.resultsCount],
        [`peer:${alphaDevice.fingerprint}`, 'Coordinator', 'alpha lead', 'beta-project', ['deploy port'], 1]);

      // The owner's console shows it, from this computer only.
      const response = fakeResponse();
      await handleVisitorAccessRequest({ request: { method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, response,
        url: new URL('http://127.0.0.1/api/visitor-access/reads?limit=5'), visitorAccess: beta.app.visitorAccess });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.reads.map((row) => [row.requester, row.agentName, row.projectId, row.queries, row.resultsCount]),
        [['Coordinator', 'alpha lead', 'beta-project', ['deploy port'], 1]]);

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
    await assert.rejects(visit(alpha.app, { address: 'project:beta', action: 'card' }), { code: 'validation' });
  } finally { await alpha.close(); await beta.close(); }
});

test('visitor reads are served only to this computer', async () => {
  const visitorAccess = { recentReads: () => { throw new Error('must not be read'); } };
  for (const remoteAddress of ['192.168.1.20', '10.0.0.5']) {
    const response = fakeResponse();
    assert.equal(await handleVisitorAccessRequest({ request: { method: 'GET', socket: { remoteAddress } }, response,
      url: new URL('http://127.0.0.1/api/visitor-access/reads'), visitorAccess }), true);
    assert.deepEqual([response.status, response.body.code], [403, 'local_user_only']);
  }
  const post = fakeResponse();
  await handleVisitorAccessRequest({ request: { method: 'POST', socket: { remoteAddress: '127.0.0.1' } }, response: post,
    url: new URL('http://127.0.0.1/api/visitor-access/reads'), visitorAccess });
  assert.equal(post.status, 405);
  assert.equal(await handleVisitorAccessRequest({ request: { method: 'GET', socket: { remoteAddress: '127.0.0.1' } },
    response: fakeResponse(), url: new URL('http://127.0.0.1/api/visitor-access/other'), visitorAccess }), false);
});

function fakeResponse() {
  return { status: null, body: null, headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); return this; },
    end(text) { this.body = text ? JSON.parse(text) : null; } };
}
