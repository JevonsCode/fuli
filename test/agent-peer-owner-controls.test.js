import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { handlePeerApiRequest } from '../src/agent-peer/http.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { createPeerPort } from '../packages/roundtable/src/peer/peer-port.js';
import { createPeerRuntime } from '../packages/roundtable/src/peer/peer-runtime.js';
import { runPeerCommand } from '../src/cli/peer-command.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';

function request({ method = 'GET', path = '/api/peer', remoteAddress = '127.0.0.1', host = '127.0.0.1:4100', body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, { method, url: path, headers: { host, 'content-type': 'application/json' },
    socket: { remoteAddress } });
}

function response() {
  return { statusCode: null, body: null, headers: {}, setHeader(name, value) { this.headers[name] = value; },
    writeHead(status) { this.statusCode = status; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
}

async function call(peer, { ownerChangeAllowed = false, ...options } = {}) {
  const req = request(options);
  const res = response();
  try {
    const handled = await handlePeerApiRequest({ request: req, response: res, url: new URL(req.url, 'http://127.0.0.1'), peer,
      ownerChangeAllowed: () => ownerChangeAllowed });
    return { handled, status: res.statusCode, body: res.body, unread: req.readableLength > 0 || !req.readableEnded };
  } catch (error) {
    const mapped = mapHttpError(error);
    return { handled: true, status: mapped.status, body: mapped.body, unread: !req.readableEnded };
  }
}

// rec#11 D-61: what changes where this device's data can go needs the console
// session, or `fuli peer` with the data directory's human-review token.
test('becoming a coordinator, inviting, joining and sharing need the console owner; status, revoke and off do not', async () => {
  const calls = [];
  const record = (name, value = { role: null }) => async (input) => { calls.push(name); return { ...value, input }; };
  const peer = { status: record('status'), enableCoordinator: record('coordinator'), createInvitation: record('invite'),
    previewInvitation: record('preview'), join: record('join'), setShares: record('shares'), revokeDevice: record('revoke'),
    disable: record('disable') };
  const changes = [['POST', '/api/peer/coordinator', { host: '192.168.1.5' }], ['POST', '/api/peer/invitations', {}],
    ['POST', '/api/peer/join', { invitation: 'synthetic-invitation' }],
    ['PUT', '/api/peer/shares', { shares: [{ projectId: 'sample-project', clients: ['codex'], workingDirectory: '/synthetic' }] }]];
  for (const [method, path, body] of changes) {
    const refused = await call(peer, { method, path, body });
    assert.deepEqual([refused.status, refused.body.code], [401, 'console_session_required'], path);
    assert.equal(refused.unread, true, `${path}: refused before its body is read`);
  }
  assert.deepEqual(calls, [], 'nothing was paired, invited or shared');
  for (const [method, path, body] of changes) {
    assert.equal((await call(peer, { method, path, body, ownerChangeAllowed: true })).status, 200, path);
  }
  assert.deepEqual(calls, ['coordinator', 'invite', 'join', 'shares']);
  calls.length = 0;
  for (const [method, path, body] of [['GET', '/api/peer'], ['POST', '/api/peer/invitations/preview', { invitation: 'x' }],
    ['POST', `/api/peer/devices/${'a'.repeat(64)}/revoke`, {}], ['POST', '/api/peer/disable', {}]]) {
    assert.equal((await call(peer, { method, path, body })).status, 200, path);
  }
  assert.deepEqual(calls, ['status', 'preview', 'revoke', 'disable']);
  // Another device is still refused first, owner or not.
  const lan = await call(peer, { method: 'PUT', path: '/api/peer/shares', body: { shares: [] }, remoteAddress: '192.168.1.20',
    ownerChangeAllowed: true });
  assert.equal(lan.body.error, 'local_owner_only');
});

test('fuli peer sends the data directory\'s human-review token with every request, never in the URL', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => { requests.push({ url, headers: init.headers });
    return { ok: true, json: async () => ({ role: null, addresses: [] }) }; };
  const dataDir = await mkdtemp(join(tmpdir(), 'p61-peer-token-'));
  try {
    await runPeerCommand(['invite', '--data-dir', dataDir], { fetchImpl, write: () => {}, readToken: () => 'synthetic-review-token' })
      .catch(() => {});
    await runPeerCommand(['status', '--data-dir', dataDir], { fetchImpl, write: () => {}, readToken: () => 'synthetic-review-token' });
    assert.ok(requests.length >= 2);
    for (const { url, headers } of requests) {
      assert.equal(headers['x-fuli-console-sign-in'], 'synthetic-review-token');
      assert.equal(url.includes('synthetic-review-token'), false);
    }
    // Without a readable token the request goes out without one, and the console refuses a change.
    requests.length = 0;
    await runPeerCommand(['status', '--data-dir', dataDir], { fetchImpl, write: () => {}, readToken: () => { throw new Error('none'); } });
    assert.equal(requests[0].headers['x-fuli-console-sign-in'], undefined);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('LAN roundtable owner controls answer only on the loopback console', async () => {
  const calls = [];
  const peer = { status: async () => ({ role: null }), disable: async () => { calls.push('disable'); return { role: null }; } };
  assert.equal((await call(peer, {})).status, 200);
  for (const options of [{ remoteAddress: '192.168.1.20' }, { host: '192.168.1.5:4100' }, { remoteAddress: '192.168.1.20', host: '192.168.1.5:4100' }]) {
    const result = await call(peer, { ...options, method: 'POST', path: '/api/peer/disable', body: {} });
    assert.equal(result.status, 403);
    assert.equal(result.body.error, 'local_owner_only');
  }
  assert.deepEqual(calls, []);
  assert.equal((await call(peer, { path: '/api/other' })).handled, false);
});

test('nothing is written or listened on until the owner turns the LAN roundtable on', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fuli-peer-off-'));
  try {
    const port = createPeerPort({ dataDir, host: createFuliRoundtableHost({ config: { personal: { spaceId: 'space' } }, personal: {} }) });
    const runtime = createPeerRuntime({ host: createFuliRoundtableHost({ config: { personal: { spaceId: 'space' } } }), port, interfaces: () => ({}) });
    await runtime.resume();
    assert.equal((await runtime.status()).role, null);
    assert.equal(await port.remoteAgents({}), null);
    assert.equal(port.hasSent('message'), false);
    assert.equal(port.configured(), false);
    await assert.rejects(runtime.enableCoordinator({ host: '0.0.0.0', port: 0 }), { code: 'invalid_address' });
    assert.equal(runtime.runnerActive(), false);
    port.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('the peer CLI sends the owner\'s explicit client and folder choices to the local console', async () => {
  const requests = [];
  const lines = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ role: null, addresses: [] }) };
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'fuli-peer-cli-'));
  try {
    await runPeerCommand(['share', '--project', 'sample-project', '--clients', 'codex', '--folder', '/synthetic/folder',
      '--data-dir', dataDir], { fetchImpl, write: (line) => lines.push(line) });
    assert.match(requests[0].url, /^http:\/\/127\.0\.0\.1:\d+\/api\/peer\/shares$/);
    assert.deepEqual(requests[0].body, { shares: [{ projectId: 'sample-project', clients: ['codex'], workingDirectory: '/synthetic/folder' }] });
    await assert.rejects(runPeerCommand(['revoke', '--device', 'short', '--data-dir', dataDir], { fetchImpl }), /full fingerprint/);
    await assert.rejects(runPeerCommand(['host', '--data-dir', dataDir], { fetchImpl }), /--address/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
