import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createAgentDelegation } from '../src/agent-delegation/port.js';
import { DELEGATION_HEADER, encodeDelegation } from '../src/agent-delegation/delegation-header.js';
import { interfaceForRequest } from '../src/agent-tools/interface-catalog.js';
import { handleDelegatedRequest } from '../src/http/agent-delegation-gate.js';
import { createVisitorAccess } from '../src/visitor-access/port.js';
import { handleVisitRequestsApiRequest } from '../src/visit-requests/http.js';
import { createVisitRequests } from '../src/visit-requests/service.js';

// Synthetic requests through a fake runner; requests are plain objects, never a real server.
const PEER = `peer:${'e'.repeat(64)}`;
const PLAN = { areas: ['src/app.js'], risks: ['touches startup'], dependencyChanges: false, configChanges: false, network: false, size: 'm' };

function access(t) {
  let sequence = 0;
  const runner = {
    folder: async () => '/synthetic',
    prepare: async (request) => ({ projectFolder: '/synthetic', worktreePath: `/synthetic/wt/${request.id}`, branch: `fuli/visit/${request.id}`,
      baseCommit: 'f'.repeat(40) }),
    plan: async () => ({ plan: PLAN, error: null, ms: 10 }),
    run: async () => ({ ms: 20, hold: null, summary: 'Done.', intact: true, addedText: '+x', files: [{ path: 'src/app.js', added: 1, removed: 0 }],
      diffstat: { files: 1, added: 1, removed: 0 } }),
    patch: async () => ({ text: 'diff --git a/src/app.js b/src/app.js\n+x', truncated: false }),
    remove: async () => {}
  };
  const port = createVisitorAccess({ application: {},
    requests: ({ store, modeOf }) => createVisitRequests({ store, modeOf, runner, leads: { confirm: async () => true, constrainedClients: async () => ['claude_code'] }, idFactory: () => `http-request-${++sequence}` }) });
  t.after(() => port.close());
  return port;
}

function request(method, path, { body = undefined, remoteAddress = '127.0.0.1', host = '127.0.0.1:2828', headers = {} } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, { method, url: path, socket: { remoteAddress }, headers: { host, ...headers } });
}

function response() {
  return { status: null, body: null, headers: {}, statusCode: 200,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status) { this.status = status; this.statusCode = status; return this; },
    end(text) { this.body = text ? JSON.parse(text) : null; } };
}

async function call(port, method, path, options) {
  const sent = response();
  const handled = await handleVisitRequestsApiRequest({ request: request(method, path, options), response: sent,
    url: new URL(path, 'http://127.0.0.1'), visitorAccess: port });
  return { handled, ...sent };
}

async function awaiting(port, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await port.requests.card(id)).request.state === 'awaiting_owner') return;
    await delay(5);
  }
  assert.fail('not planned');
}

test('the list, the card and each decision answer this computer only, with the shapes the console reads', async (t) => {
  const port = access(t);
  port.submitRequest({ requester: { key: PEER, label: 'Synthetic desk', agentName: 'Visitor lead' }, projectId: 'synthetic-project',
    agentId: 'synthetic-lead', request: { title: 'Add‮ a check', what: 'Check the input\u0007 first', expectedAreas: ['src/'] } });
  await awaiting(port, 'http-request-1');

  const listed = await call(port, 'GET', '/api/visit-requests');
  assert.equal(listed.status, 200);
  assert.equal(listed.headers['cache-control'], 'no-store');
  assert.equal(listed.body.awaiting.count, 1);
  const [item] = listed.body.requests;
  assert.deepEqual(Object.keys(item), ['id', 'state', 'review', 'holdReason', 'requester', 'projectId', 'agentId', 'title', 'plan',
    'planError', 'risk', 'modeAtReceipt', 'modeAtDecision', 'decidedBy', 'reason', 'error', 'result', 'createdAt', 'updatedAt']);
  assert.deepEqual([item.title, item.requester, item.risk], ['Add a check',
    { key: PEER, label: 'Synthetic desk', agentName: 'Visitor lead', source: 'peer' }, { level: 'medium', flags: [] }]);
  assert.deepEqual(listed.body.awaiting.newest.map((row) => row.id), ['http-request-1']);

  const approved = await call(port, 'POST', '/api/visit-requests/http-request-1/approve', { body: {} });
  assert.deepEqual([approved.status, approved.body.request.state, approved.body.request.decidedBy], [200, 'approved', 'owner']);
  for (let attempt = 0; attempt < 200 && (await port.requests.card('http-request-1')).request.state !== 'awaiting_review'; attempt += 1) {
    await delay(5);
  }
  const card = await call(port, 'GET', '/api/visit-requests/http-request-1');
  assert.equal(card.status, 200);
  assert.equal(card.body.request.what, 'Check the input first');
  assert.deepEqual(card.body.request.result, { summary: 'Done.', branch: 'fuli/visit/http-request-1',
    files: [{ path: 'src/app.js', added: 1, removed: 0 }], diffstat: { files: 1, added: 1, removed: 0 } });
  assert.match(card.body.request.diff.text, /^diff --git/);
  assert.deepEqual(card.body.request.events.map((event) => event.to), ['received', 'planning', 'awaiting_owner', 'approved', 'running',
    'awaiting_review']);

  const again = await call(port, 'POST', '/api/visit-requests/http-request-1/approve', { body: {} });
  assert.deepEqual([again.status, again.body.code], [409, 'state_conflict']);
  const missing = await call(port, 'GET', '/api/visit-requests/nothing-here');
  assert.deepEqual([missing.status, missing.body.code], [404, 'request_not_found']);
  const kept = await call(port, 'POST', '/api/visit-requests/http-request-1/keep', { body: {} });
  assert.equal(kept.body.request.state, 'kept');
  assert.equal((await call(port, 'GET', '/api/visit-requests/http-request-1/approve')).status, 405);
  assert.equal((await call(port, 'GET', '/api/visit-requests-other')).handled, false);
});

test('a requester\'s mode is set here: trusted marks the computer, a guest link never goes past plan', async (t) => {
  const port = access(t);
  const path = `/api/visitor-access/requesters/${encodeURIComponent(PEER)}/mode`;
  const trusted = await call(port, 'PUT', path, { body: { mode: 'trusted', label: 'My other laptop' } });
  assert.deepEqual([trusted.status, trusted.body.requester.mode, trusted.body.requester.ownDevice, trusted.body.effects],
    [200, 'trusted', true, { cancelled: [], returned: [] }]);
  const lowered = await call(port, 'PUT', path, { body: { mode: 'plan' } });
  assert.deepEqual([lowered.body.requester.mode, lowered.body.requester.ownDevice, lowered.body.requester.label],
    ['plan', false, 'My other laptop']);
  const guest = await call(port, 'PUT', '/api/visitor-access/requesters/guest%3Asynthetic-link/mode', { body: { mode: 'auto', label: 'Guest' } });
  assert.deepEqual([guest.status, guest.body.code], [400, 'mode_not_allowed']);
  const unknown = await call(port, 'PUT', path, { body: { mode: 'everything' } });
  assert.deepEqual([unknown.status, unknown.body.code], [400, 'mode_unknown']);
});

test('every route refuses a caller that is not this computer\'s loopback, and a loopback address with another Host', async (t) => {
  const port = access(t);
  const routes = [['GET', '/api/visit-requests'], ['GET', '/api/visit-requests/r-1'], ['POST', '/api/visit-requests/r-1/approve'],
    ['POST', '/api/visit-requests/r-1/decline'], ['POST', '/api/visit-requests/r-1/keep'], ['POST', '/api/visit-requests/r-1/discard'],
    ['POST', '/api/visit-requests/r-1/cancel'], ['PUT', `/api/visitor-access/requesters/${encodeURIComponent(PEER)}/mode`]];
  for (const [method, path] of routes) {
    const lan = await call(port, method, path, { body: { mode: 'trusted' }, remoteAddress: '192.168.1.20', host: '192.168.1.5:2828' });
    assert.deepEqual([lan.handled, lan.status, lan.body.error], [true, 403, 'local_owner_only'], `${method} ${path}`);
    const forwarded = await call(port, method, path, { body: { mode: 'trusted' }, host: 'fuli.example.invalid' });
    assert.equal(forwarded.status, 403, `${method} ${path} with a foreign Host`);
  }
  assert.equal(port.requesterMode(PEER).mode, 'plan', 'no refused call changed anything');
});

test('an Agent may decline or cancel for the person, never approve, keep, discard or change a mode', async () => {
  const delegation = createAgentDelegation(null);
  delegation.setCategory('lan_roundtable', true);
  const delegated = async (method, path) => {
    const sent = response();
    let reached = false;
    await handleDelegatedRequest({ request: request(method, path, { headers: { [DELEGATION_HEADER]: encodeDelegation({
      actor: { agentId: 'synthetic-fla' }, reason: 'The person asked', bodyFields: [] }) } }), response: sent, delegation,
    agentAccessEnabled: () => true, handle: async () => { reached = true; sent.writeHead(200); sent.end('{}'); return true; } });
    return { reached, status: sent.status, code: sent.body?.code };
  };
  for (const action of ['approve', 'keep', 'discard']) {
    assert.deepEqual(await delegated('POST', `/api/visit-requests/r-1/${action}`), { reached: false, status: 403, code: 'local_user_only' }, action);
    assert.equal(interfaceForRequest('POST', `/api/visit-requests/r-1/${action}`).access, 'local_user_only');
  }
  assert.deepEqual(await delegated('PUT', `/api/visitor-access/requesters/${encodeURIComponent(PEER)}/mode`),
    { reached: false, status: 403, code: 'local_user_only' });
  for (const action of ['decline', 'cancel']) {
    assert.equal((await delegated('POST', `/api/visit-requests/r-1/${action}`)).reached, true, action);
  }
  delegation.close();
});
