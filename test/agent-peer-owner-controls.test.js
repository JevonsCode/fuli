import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { handlePeerApiRequest } from '../src/agent-peer/http.js';
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

async function call(peer, options) {
  const req = request(options);
  const res = response();
  const handled = await handlePeerApiRequest({ request: req, response: res, url: new URL(req.url, 'http://127.0.0.1'), peer });
  return { handled, status: res.statusCode, body: res.body };
}

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

test('the peer CLI lists nearby computers, starts a pairing and confirms the code read on the other computer', async () => {
  const requests = [];
  const lines = [];
  const pairing = { requestId: 'request-1', state: 'confirm', code: '042917', coordinator: 'other', confirmedHere: false,
    confirmedThere: false, expiresAt: '2026-11-13T09:02:00.000Z', device: { name: 'Laptop', shortFingerprint: 'ABCD 1234 5678 9ABC' } };
  const nearby = { on: true, name: 'Desk', canPair: true, reason: null, pairing,
    devices: [{ name: 'Laptop', fingerprint: 'abcd123456789abc', shortFingerprint: 'ABCD 1234 5678 9ABC', paired: false }] };
  const fetchImpl = async (url, init) => {
    requests.push({ path: new URL(url).pathname, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ role: 'coordinator', nearby }) };
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'fuli-peer-cli-nearby-'));
  const run = (args) => runPeerCommand([...args, '--data-dir', dataDir], { fetchImpl, write: (line) => lines.push(line) });
  try {
    await run(['nearby', 'on', '--name', 'Desk']);
    await run(['pair', 'abcd12']);
    await run(['confirm', '042', '917']);
    await run(['cancel']);
    assert.deepEqual(requests.map(({ method, path, body }) => [method, path, body]), [
      ['POST', '/api/peer/nearby', { on: true, name: 'Desk' }],
      ['POST', '/api/peer/nearby/pair', { fingerprint: 'abcd12' }],
      ['GET', '/api/peer', null],
      ['POST', '/api/peer/nearby/confirm', { requestId: 'request-1', code: '042917' }],
      ['POST', '/api/peer/nearby/cancel', {}],
    ]);
    assert.ok(lines.some((line) => line.includes('Laptop · ABCD 1234 5678 9ABC')));
    assert.ok(lines.some((line) => line.includes('code 042917') && line.includes('other computer will coordinate')));
    await assert.rejects(run(['confirm', '12']), /6-digit code/);
    await assert.rejects(run(['pair']), /fingerprint/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('the nearby controls answer only on the loopback console too', async () => {
  const calls = [];
  const peer = { nearbyOn: async (input) => { calls.push(['on', input]); return { role: null }; },
    nearbyOff: async () => { calls.push(['off']); return { role: null }; },
    confirmPairing: async (input) => { calls.push(['confirm', input]); return { role: null }; } };
  const remote = await call(peer, { method: 'POST', path: '/api/peer/nearby/confirm', remoteAddress: '192.168.1.20', body: { requestId: 'r', code: '1' } });
  assert.deepEqual([remote.status, remote.body.error], [403, 'local_owner_only']);
  assert.equal((await call(peer, { method: 'POST', path: '/api/peer/nearby', body: { on: 'yes' } })).status, 422);
  assert.equal((await call(peer, { method: 'POST', path: '/api/peer/nearby', body: { on: true, name: 'Desk' } })).status, 200);
  assert.equal((await call(peer, { method: 'POST', path: '/api/peer/nearby', body: { on: false } })).status, 200);
  assert.deepEqual(calls, [['on', { name: 'Desk' }], ['off']]);
});

test('the share search and the picked project read answer only on the loopback console, with the typed text', async () => {
  const calls = [];
  const peer = { searchShareable: async (input) => { calls.push(['search', input]); return { projects: [], more: false }; },
    shareableProject: async (projectId) => { calls.push(['project', projectId]); return { projectId }; } };
  const remote = await call(peer, { path: '/api/peer/shareable?query=app', remoteAddress: '192.168.1.20' });
  assert.deepEqual([remote.status, remote.body.error], [403, 'local_owner_only']);
  assert.equal((await call(peer, { path: '/api/peer/shareable/sample', host: '192.168.1.5:4100' })).status, 403);
  assert.deepEqual(calls, []);
  assert.deepEqual((await call(peer, { path: '/api/peer/shareable?query=Sample%20app&limit=5' })).body, { projects: [], more: false });
  await call(peer, { path: '/api/peer/shareable' });
  assert.deepEqual((await call(peer, { path: '/api/peer/shareable/sample%20project' })).body, { projectId: 'sample project' });
  assert.equal((await call(peer, { path: '/api/peer/shareable/%E0%A4%A' })).status, 404);
  assert.deepEqual(calls, [['search', { query: 'Sample app', limit: 5 }], ['search', { query: '' }], ['project', 'sample project']]);
});
