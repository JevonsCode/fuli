import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { handlePeerApiRequest } from '../src/agent-peer/http.js';
import { createPeerPort } from '../src/agent-peer/peer-port.js';
import { createPeerRuntime } from '../src/agent-peer/peer-runtime.js';
import { runPeerCommand } from '../src/cli/peer-command.js';

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
    const port = createPeerPort({ dataDir, provider: {}, spaceId: () => 'space' });
    const runtime = createPeerRuntime({ app: { config: { personal: { spaceId: 'space' } } }, port, interfaces: () => ({}) });
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
