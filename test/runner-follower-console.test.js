import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { DELEGATION_HEADER } from '../src/agent-delegation/delegation-header.js';
import { runLocalRuntimeCommand } from '../src/cli/local-runtime-command.js';
import { runSetupCommand } from '../src/cli/setup-command.js';
import { runTrayAction } from '../src/desktop/desktop-controller.js';
import { BAND_SOURCE } from '../src/runner/follower-band.js';
import { LOCAL_PATH, startFollowerConsole, STATUS_PATH } from '../src/runner/follower-console.js';
import { ADDRESS_PATH, followerConsolePage, SYNC_PATH } from '../src/runner/follower-page.js';
import { capabilityLines } from '../src/runner/follower-runtime.js';
import { CAPABILITIES } from '../src/runner/follower-status.js';
import { createHostConnection } from '../src/runner/host-connection.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { isRunnerDataDirectory, runnerRuntimeConfig } from '../src/runner/runner-mode.js';
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
    response.end('<!doctype html><html><head><title>FULI</title></head><body><div id="app">host console</div></body></html>');
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
  const delivered = [];
  const entry = await startFollowerConsole({ dataDir, port: 0, store, connection, clients,
    deliver: async () => { delivered.push('once'); return { delivered: 0, refused: 0, ...store.outbox() }; } });
  t.after(async () => {
    await entry.close();
    connection.close();
    store.close();
    await listener.close();
    await routes.close();
    hostStore.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { entry, consoleSide, hostStore, runner, store, delivered,
    setAway: (value) => { away = value; connection.drop(); } };
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

test('paired console users can read the public version while host maintenance and private diagnostics stay on the host', async (t) => {
  const { entry, consoleSide } = await pairedRunner(t);
  const denied = [
    ['GET', '/api/system/update'], ['POST', '/api/system/update'],
    ['GET', '/api/diagnostics/issue-report'], ['GET', '/api/diagnostics/events'],
    ['GET', '/api/system/diagnostics'], ['GET', '/api/system/log-archives'], ['GET', '/api/debug-turns'],
    ['POST', '/api/system/doctor/repair'], ['PUT', '/api/system/cli-path'], ['PUT', '/api/system/settings'],
    ['POST', '/api/system/npm-copies/uninstall'], ['POST', '/api/data-format/apply'], ['POST', '/api/system/graph-migration'],
    ['GET', '/api/old-data'], ['POST', '/api/embedding-models/download']
  ];
  for (const [method, path] of denied) {
    const res = await get(entry.url + path, { method });
    assert.equal(res.status, 403, method + ' ' + path);
  }
  const delegated = await get(entry.url + '/api/system/version', { headers: { [DELEGATION_HEADER]: 'declared' } });
  assert.equal(delegated.status, 403);
  assert.equal(consoleSide.seen.length, 0);
  assert.equal((await get(entry.url + '/api/system/version')).status, 200);
  assert.equal(consoleSide.seen.length, 1);
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

// Review of 0.27.17: `//other-host/…` read as another address and skipped the
// host-only checks, so a runner could reach them or any address the host can.
test('a doubled slash neither skips the host-only checks nor leaves the console', async (t) => {
  const { entry, consoleSide } = await pairedRunner(t);
  for (const route of ['/api//runners/invitations', '//api/runners', '/api//peer/nearby',
    '//api//system/client-connection/connect']) {
    const answer = await get(`${entry.url}${route}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(answer.status, 403, route);
  }
  assert.equal(consoleSide.seen.length, 0);
  // `//127.0.0.1:9/…` stays a path of the console itself (one it does not have), never another address.
  await get(`${entry.url}//127.0.0.1:9/api/runners`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.deepEqual(consoleSide.seen.map((seen) => [seen.url, seen.host]),
    [['/127.0.0.1:9/api/runners', consoleSide.seen[0]?.host]]);
  assert.doesNotMatch(consoleSide.seen[0].host, /:9$/);
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
  // A receipt link opened while the host is away says whose page it was and that it cannot be shown now.
  const awayPage = await get(`${entry.url}/projects/synthetic`, { headers: { accept: 'text/html' } });
  assert.equal(awayPage.status, 503);
  assert.match(awayPage.text, /Host A/);
  assert.match(awayPage.text, /现在不在线/);
  assert.match(awayPage.text, /\/projects\/synthetic/, 'it names the page that cannot be shown');
  assert.match(awayPage.text, /<span class="beta"[^>]*>Beta<\/span>/, 'runners are in testing and say so');
  assert.equal(awayPage.headers['x-fuli-source'], 'unavailable');
  const awayApi = await get(`${entry.url}/api/tasks`);
  assert.equal(JSON.parse(awayApi.text).error, 'host_unreachable');
  assert.equal(awayApi.headers['x-fuli-source'], 'unavailable');
});

test('this computer\'s own console page says who it follows, what runs where and what waits', async (t) => {
  const { entry, store } = await pairedRunner(t);
  store.enqueue({ id: 'synthetic-entry-1', tool: 'checkpoint_task_knowledge', input: { workLog: 'synthetic work' },
    sourceApplication: 'codex' });
  const page = await get(`${entry.url}${LOCAL_PATH}`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.equal(page.headers['x-fuli-source'], 'local', 'its own page is its own');
  assert.match(page.text, /Host A/);
  assert.match(page.text, /什么跑在哪里/);
  assert.match(page.text, /checkpoint_task_knowledge/, 'every waiting record is listed one by one');
  assert.match(page.text, /同一个局域网，或同一个 VPN/, 'how the two computers reach each other is said here, not only in the docs');
  assert.match(page.text, /href="\/remote\/host-a\/"/, 'the host\'s console is one link away');

  // The state band is added to the host's own pages, and marks where the page's data came from.
  const hostPage = await get(`${entry.url}/projects`, { headers: { accept: 'text/html' } });
  assert.equal(hostPage.headers['x-fuli-source'], 'host');
  assert.match(hostPage.text, /__fuli-follower\/band\.js/);
  const band = await get(`${entry.url}/__fuli-follower/band.js`);
  assert.equal(band.status, 200);
  assert.match(band.headers['content-type'], /javascript/);
  assert.match(band.text, /x-fuli-source/);
});

// docs/runner-roles-design.md §3: whose data it is has three answers, because a
// scope one computer owns may be kept as a read-only copy on another.
test('where data comes from has three answers: the host, this computer, and a read-only copy here', () => {
  const capabilities = [{ id: 'own', where: 'local', offline: 'works', zh: '本机的', en: 'this computer\'s' },
    { id: 'owned', where: 'host', offline: 'cached', zh: '主机的', en: 'the host\'s' },
    { id: 'copy', where: 'replica', syncedAt: '2026-11-23T09:00:00.000Z', offline: 'cached',
      zh: '只读副本', en: 'a read-only copy' }];
  const page = followerConsolePage({ status: { paired: false, host: null,
    outbox: { queued: 0, failedCount: 0, failed: [], entries: [] }, capabilities }, hostPath: '/local' });
  assert.match(page, /本机只读副本（同步于 2026-11-23T09:00:00\.000Z）/);
  assert.match(page, /<span class="where local">本机<\/span>/);
  assert.match(page, /<span class="where host">主机<\/span>/);
  assert.deepEqual(capabilityLines(capabilities).slice(1, 4), [
    '  this computer · offline: works — this computer\'s',
    '  the host · offline: the answer kept here — the host\'s',
    '  a read-only copy here (synced 2026-11-23T09:00:00.000Z) · offline: the answer kept here — a read-only copy']);
  // The band, which the host's own pages load, reads the same third value off `x-fuli-source`.
  assert.match(BAND_SOURCE, /replica/);
});

test('`/remote/<host>/` reaches only the paired host, and lands on its own path', async (t) => {
  const { entry, consoleSide } = await pairedRunner(t);
  const named = await get(`${entry.url}/remote/host-a/projects/synthetic`, { headers: { accept: 'text/html' } });
  assert.equal(named.status, 302);
  assert.equal(named.headers.location, '/projects/synthetic');
  const api = await get(`${entry.url}/remote/host-a/api/tasks`);
  assert.equal(JSON.parse(api.text).url, '/api/tasks');
  const seen = consoleSide.seen.length;

  for (const route of ['/remote/attacker.example/api/tasks', '/remote/127.0.0.1:9/api/tasks',
    '/remote//api/tasks', '/remote/other-host/api/tasks']) {
    const refused = await get(`${entry.url}${route}`);
    assert.equal(refused.status, 404, route);
    assert.equal(JSON.parse(refused.text).error, 'unknown_host', route);
  }
  assert.equal(consoleSide.seen.length, seen, 'a host this computer is not paired with is never reached');
});

// The host does not answer: one button, then one field, instead of a dead end.
test('「添加主机地址」 takes a private address from this computer\'s own page and nothing else', async (t) => {
  const { entry, store, setAway } = await pairedRunner(t);
  setAway(true);
  const page = await get(`${entry.url}${LOCAL_PATH}`, { headers: { accept: 'text/html' } });
  assert.match(page.text, /添加主机地址/, 'the next step is offered while the host is away');
  assert.match(page.text, /不在线/, 'the page says plainly that the host did not answer, never "not checked"');
  assert.match(page.text, /同一个 VPN/, 'how the two computers reach each other is said as it is');
  assert.doesNotMatch(page.text, /中继/, 'no relay is planned, so none is promised');

  const forged = await get(`${entry.url}${ADDRESS_PATH}`, { method: 'POST', body: '{"address":"192.0.2.20"}',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example' } });
  assert.equal(forged.status, 403);
  const noOrigin = await get(`${entry.url}${ADDRESS_PATH}`, { method: 'POST', body: '{"address":"192.0.2.20"}',
    headers: { 'content-type': 'application/json' } });
  assert.equal(noOrigin.status, 405);
  for (const address of ['198.51.100.7', 'host.example', '', '127.0.0.1\n10.0.0.1']) {
    const refused = await get(`${entry.url}${ADDRESS_PATH}`, { method: 'POST', body: JSON.stringify({ address }),
      headers: { 'content-type': 'application/json', origin: entry.url } });
    assert.equal(refused.status, 400, address);
    assert.equal(JSON.parse(refused.text).error, 'not_a_private_address', address);
  }
  assert.deepEqual(store.host().addresses, ['127.0.0.1'], 'nothing outside a private network is kept');

  const saved = await get(`${entry.url}${ADDRESS_PATH}`, { method: 'POST', body: '{"address":"10.0.0.20"}',
    headers: { 'content-type': 'application/json', origin: entry.url } });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.text).reachable, false, 'it says plainly that the address did not answer');
  assert.equal(store.host().addresses[0], '10.0.0.20', 'the address is tried first next time');
});

test('「现在重试」 delivers now and only from this computer\'s own page', async (t) => {
  const { entry, delivered } = await pairedRunner(t);
  const forged = await get(`${entry.url}${SYNC_PATH}`, { method: 'POST', body: '{}',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example' } });
  assert.equal(forged.status, 403);
  const noOrigin = await get(`${entry.url}${SYNC_PATH}`, { method: 'POST', body: '{}',
    headers: { 'content-type': 'application/json' } });
  assert.equal(noOrigin.status, 405);
  assert.equal(delivered.length, 0);

  const asked = await get(`${entry.url}${SYNC_PATH}`, { method: 'POST', body: '{}',
    headers: { 'content-type': 'application/json', origin: entry.url } });
  assert.equal(asked.status, 200);
  assert.equal(delivered.length, 1);
  assert.match(JSON.parse(asked.text).html, /Nothing is waiting/);
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
  store.saveHost({ name: 'Host A', fingerprint: 'a'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['10.0.0.20'] });
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
      host: { name: 'Host A', reachable: true }, outbox: { queued: 2 }, capabilities: CAPABILITIES,
      line: { zh: '跟随 Host A · 在线 · 待送 2', en: 'Following Host A · answering · 2 waiting' } }; }]));
  const result = await runLocalRuntimeCommand('start', ['--data-dir', dataDir], { runnerHandlers, write: (line) => written.push(line),
    start: () => assert.fail('a runner never starts a graph runtime') });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [['start', 2727]]);
  // The same facts the console shows: who it follows, whether that computer answers, what waits, what runs where.
  assert.match(written.join('\n'),
    /This computer follows a FULI host[\s\S]*Following Host A · answering · 2 waiting[\s\S]*What runs where/);
  assert.match(written.join('\n'), /this computer · offline: works — 客户端接入/);
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

// docs/runner-roles-design.md §1.1: a computer that had a FULI of its own
// before it joined a host kept `graph-runtime.json`, so it stopped counting as
// a runner and its clients silently used an empty local FULI instead.
test('a pairing, not a missing runtime file, makes a computer follow its host', async (t) => {
  const dataDir = runnerDataDir(t);
  writeFileSync(path.join(dataDir, 'graph-runtime.json'), '{"synthetic":true}');
  assert.equal(isRunnerDataDirectory(dataDir), true);
  assert.equal(runnerRuntimeConfig(['--runtime-config', path.join(dataDir, 'graph-runtime.json')]), true,
    'its clients still reach FULI through the host');

  const invoked = [];
  let running = false;
  const started = await runTrayAction('start', { dataDir }, {
    runCli: async (_context, args) => {
      invoked.push(args[0]);
      if (args[0] === 'status') return { code: running ? 0 : 1, stdout: JSON.stringify({ status: running ? 'running' : 'stopped' }) };
      if (args[0] === 'start') running = true;
      return { code: 0, stdout: '', stderr: '' };
    },
    portBlocked: async () => false
  });
  assert.equal(started.ok, true);
  assert.ok(!invoked.includes('setup'), 'the desktop start never sets a new FULI up over the pairing');

  const written = [];
  const result = await runSetupCommand(['--data-dir', dataDir, '--yes'], { write: (line) => written.push(line),
    setupRunnerClients: async () => [{ id: 'codex', label: 'Codex', status: 'connected' }],
    planSetup: () => assert.fail('a computer that follows a host plans no graph runtime') });
  assert.equal(result.status, 'runner');
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
