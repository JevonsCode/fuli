import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { runLocalRuntimeCommand } from '../src/cli/local-runtime-command.js';
import { runSetupCommand } from '../src/cli/setup-command.js';
import { runTrayAction } from '../src/desktop/desktop-controller.js';
import { startFollowerConsole, STATUS_PATH } from '../src/runner/follower-console.js';
import { createHostConnection } from '../src/runner/host-connection.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { RunnerStore } from '../src/runner/runner-store.js';

const identity = async () => deviceIdentity(await createDeviceCertificate());

// The host's own console, reduced to what the relay must carry: a page, an API
// answer that shows what it was asked, and a live event stream.
async function hostConsole(t) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, host: request.headers.host, origin: request.headers.origin,
      runner: request.headers['x-fuli-runner'], method: request.method });
    if (request.url === '/api/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      return;
    }
    if (request.url?.startsWith('/api/')) {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ url: request.url, body }));
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><div id="app">host console</div>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}

// A host listener with one paired runner, and that runner's console entry.
async function pairedRunner(t, { clients = null } = {}) {
  const [host, runner] = await Promise.all([identity(), identity()]);
  const consoleSide = await hostConsole(t);
  const hostStore = new RunnerHostStore(':memory:');
  hostStore.invite({ code: 'synthetic-invitation-code-0001', name: 'Runner B' });
  hostStore.pair({ code: 'synthetic-invitation-code-0001', fingerprint: runner.fingerprint, name: 'Runner B' });
  const routes = createRunnerRoutes({ app: {}, store: hostStore, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation(), consoleOrigin: () => consoleSide.origin });
  let away = false;
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    route: (request, response, context) => (away ? (request.socket.destroy(), true) : routes.handle(request, response, context)) });
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-follower-')));
  const store = new RunnerStore(path.join(dataDir, 'runner', 'runner.sqlite'));
  store.saveHost({ name: 'Host A', fingerprint: host.fingerprint, certPem: host.certPem, port: listener.port, addresses: ['127.0.0.1'] });
  const connection = createHostConnection({ store, identity: runner, lookUp: async () => [] });
  const entry = await startFollowerConsole({ dataDir, port: 0, store, connection, clients });
  t.after(async () => {
    await entry.close();
    connection.close();
    store.close();
    await listener.close();
    await routes.close();
    hostStore.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { entry, consoleSide, hostStore, runner, setAway: (value) => { away = value; connection.drop(); } };
}

function get(url, { headers = {}, method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on('error', reject);
    request.end(body ?? undefined);
  });
}

test('a runner opens its host\'s console: pages, API calls and its own name on the host', async (t) => {
  const { entry, consoleSide } = await pairedRunner(t);

  const page = await get(`${entry.url}/projects`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(page.text, /host console/);

  const api = await get(`${entry.url}/api/tasks?status=open`, { method: 'POST', body: '{"a":1}',
    headers: { 'content-type': 'application/json', origin: entry.url } });
  assert.equal(JSON.parse(api.text).url, '/api/tasks?status=open');
  assert.equal(JSON.parse(api.text).body, '{"a":1}');
  const asked = consoleSide.seen.at(-1);
  assert.equal(asked.host, new URL(consoleSide.origin).host, 'the host console sees its own authority');
  assert.equal(asked.origin, consoleSide.origin, 'and its own origin, as a page of its own would send');
  assert.match(asked.runner, /^[0-9a-f]{16}$/);
});

test('another site\'s page cannot act on the host through a runner', async (t) => {
  const { entry, consoleSide } = await pairedRunner(t);
  const forged = await get(`${entry.url}/api/tasks`, { method: 'POST', body: '{}',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example' } });
  assert.equal(forged.status, 403);
  assert.equal(consoleSide.seen.length, 0);
});

test('a live event stream reaches the runner as it is written', async (t) => {
  const { entry } = await pairedRunner(t);
  const first = await new Promise((resolve, reject) => {
    const request = httpRequest(`${entry.url}/api/stream`, (response) => {
      response.once('data', (chunk) => { resolve(String(chunk)); request.destroy(); });
    });
    request.on('error', (error) => (error.code === 'ECONNRESET' ? null : reject(error)));
    request.end();
  });
  assert.match(first, /data: first/);
});

test('who may reach the host stays the host\'s: runners and pairing are not managed through a runner', async (t) => {
  const { entry, consoleSide } = await pairedRunner(t);
  for (const route of ['/api/runners/invitations', '/api/runners', '/api/peer/nearby']) {
    const answer = await get(`${entry.url}${route}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(answer.status, 403, route);
  }
  assert.equal(consoleSide.seen.length, 0);
});

test('a runner reads the host computer\'s clients but never connects, adds, restarts or launches one there', async (t) => {
  const { entry, consoleSide } = await pairedRunner(t);
  for (const route of ['/api/system/client-connection/connect', '/api/system/client-connection/restart',
    '/api/system/client-connection/custom-clients', '/api/session-launch/new-session']) {
    const answer = await get(`${entry.url}${route}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(answer.status, 403, route);
    assert.equal(JSON.parse(answer.text).error, 'host_computer_only');
  }
  assert.equal(consoleSide.seen.length, 0);
  assert.equal((await get(`${entry.url}/api/system/client-connection/status`)).status, 200);
});

test('a runner\'s 客户端接入 lists and connects this computer\'s own clients, never the host\'s', async (t) => {
  const connected = [];
  const clients = {
    clientConnection: () => ({ standard: { mcpServers: {} } }),
    clientConnectionStatus: async () => ({ clients: [{ id: 'codex', label: 'Codex on the runner', status: 'connected' }] }),
    connectClient: async (input) => { connected.push(input.clientId); return { id: input.clientId, status: 'connected' }; },
    restartClient: async () => ({ status: 'restarted' }),
    addCustomClient: async () => ({ id: 'custom-client' }),
    removeCustomClient: async () => ({ removed: true })
  };
  const { entry, consoleSide } = await pairedRunner(t, { clients });
  const status = await get(`${entry.url}/api/system/client-connection/status`);
  assert.equal(JSON.parse(status.text).clients[0].label, 'Codex on the runner');
  const connect = await get(`${entry.url}/api/system/client-connection/connect`, { method: 'POST', body: '{"clientId":"codex"}',
    headers: { 'content-type': 'application/json' } });
  assert.equal(connect.status, 200);
  assert.deepEqual(connected, ['codex']);
  assert.equal(consoleSide.seen.length, 0, 'nothing of it reaches the host');
});

test('the entry answers only to this computer under its own name, and says when the host is away', async (t) => {
  const { entry, setAway } = await pairedRunner(t);
  const rebound = await get(`${entry.url}/`, { headers: { host: 'attacker.example:2727' } });
  assert.equal(rebound.status, 403);

  const status = JSON.parse((await get(`${entry.url}${STATUS_PATH}`)).text);
  assert.equal(status.kind, 'fuli-runner-console');
  assert.equal(status.host.reachable, true);

  setAway(true);
  const awayPage = await get(`${entry.url}/`, { headers: { accept: 'text/html' } });
  assert.equal(awayPage.status, 503);
  assert.match(awayPage.text, /Host A/);
  assert.match(awayPage.text, /outbox: <b>0<\/b>/);
  assert.match(awayPage.text, /<span class="beta"[^>]*>Beta<\/span>/, 'runners are in testing and say so');
  const awayApi = await get(`${entry.url}/api/tasks`);
  assert.equal(JSON.parse(awayApi.text).error, 'host_unreachable');
});

test('a revoked runner\'s console entry reaches nothing on the host', async (t) => {
  const { entry, hostStore, runner, consoleSide } = await pairedRunner(t);
  hostStore.revoke(runner.fingerprint);
  const answer = await get(`${entry.url}/api/tasks`);
  assert.notEqual(answer.status, 200);
  assert.equal(consoleSide.seen.length, 0);
});

// A data directory that is a runner: paired, no graph runtime of its own.
function runnerDataDir(t) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-dir-')));
  mkdirSync(path.join(dataDir, 'runner'));
  const store = new RunnerStore(path.join(dataDir, 'runner', 'runner.sqlite'));
  store.saveHost({ name: 'Host A', fingerprint: 'a'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['192.168.1.20'] });
  store.close();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test('on a runner, start, status and stop manage its console entry, never a graph runtime', async (t) => {
  const dataDir = runnerDataDir(t);
  const calls = [];
  const written = [];
  const runnerHandlers = Object.fromEntries(['start', 'stop', 'restart', 'status', 'open'].map((command) =>
    [command, async (input) => { calls.push([command, input.port]); return { status: 'running', url: `http://127.0.0.1:${input.port}`,
      host: { name: 'Host A', reachable: true }, outbox: 2 }; }]));
  const result = await runLocalRuntimeCommand('start', ['--data-dir', dataDir], { runnerHandlers, write: (line) => written.push(line),
    start: () => assert.fail('a runner never starts a graph runtime') });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [['start', 2727]]);
  assert.match(written.join('\n'), /This computer is a runner[\s\S]*Host: Host A, answering[\s\S]*Outbox: 2 waiting/);
});

test('FULI.app on a runner starts its console entry and never runs setup', async (t) => {
  const dataDir = runnerDataDir(t);
  const invoked = [];
  let running = false;
  const result = await runTrayAction('start', { dataDir }, {
    runCli: async (_context, args) => {
      invoked.push(args[0]);
      if (args[0] === 'status') return { code: running ? 0 : 1, stdout: JSON.stringify({ status: running ? 'running' : 'stopped' }) };
      if (args[0] === 'start') running = true;
      return { code: 0, stdout: '', stderr: '' };
    },
    portBlocked: async () => false
  });
  assert.equal(result.ok, true);
  assert.ok(!invoked.includes('setup'), 'setup would give the runner a FULI of its own');
  assert.ok(invoked.includes('start'));
});

test('fuli setup on a runner sets up its clients only', async (t) => {
  const dataDir = runnerDataDir(t);
  const written = [];
  const result = await runSetupCommand(['--data-dir', dataDir, '--yes'], { write: (line) => written.push(line),
    setupRunnerClients: async () => [{ id: 'codex', label: 'Codex', status: 'connected' }],
    planSetup: () => assert.fail('a runner plans no graph runtime') });
  assert.equal(result.status, 'runner');
  assert.equal(result.exitCode, 0);
  assert.match(written.join('\n'), /only its clients/);
});
