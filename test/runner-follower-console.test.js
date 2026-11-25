import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, createServer as createServerReal, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { DELEGATION_HEADER } from '../src/agent-delegation/delegation-header.js';
import { runLocalRuntimeCommand } from '../src/cli/local-runtime-command.js';
import { runSetupCommand } from '../src/cli/setup-command.js';
import { runTrayAction } from '../src/desktop/desktop-controller.js';
import { createFollowerLocalApi } from '../src/runner/follower-local-api.js';
import { BAND_SOURCE } from '../src/runner/follower-band.js';
import { inspectProjectRequest } from '../src/runner/console-scope-paths.js';
import { LOCAL_PATH, startFollowerConsole, STATUS_PATH, whoAnswers } from '../src/runner/follower-console.js';
import { ADDRESS_PATH, followerConsolePage, LOOK_TRIES, MAKE_LOCAL_PATH, outbox, SYNC_PATH } from '../src/runner/follower-page.js';
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

// A connection that never finds the host and opens nothing: for a test that must not depend on
// the network it runs on (the address a person adds would otherwise be tried for real).
const NOWHERE = Object.freeze({ connect: async () => null, hello: async () => null, drop() {}, close() {},
  postJson: async () => ({ reachable: false }), current: null, pinFailed: false });

// A host listener with one paired runner, and that runner's console entry.
// nowhere: the entry's connection never reaches anything.
async function pairedRunner(t, { clients = null, nowhere = false, localApi = null, projectIds, inspect, makeLocal,
  keepChoices, ownsRuntime } = {}) {
  const [host, runner] = await Promise.all([identity(), identity()]);
  const consoleSide = await hostConsole(t);
  const hostStore = new RunnerHostStore(':memory:');
  hostStore.invite({ code: 'synthetic-invitation-code-0001', name: 'Runner B' });
  hostStore.pair({ code: 'synthetic-invitation-code-0001', fingerprint: runner.fingerprint, name: 'Runner B' });
  const routes = createRunnerRoutes({ app: {}, store: hostStore, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation(), consoleOrigin: () => consoleSide.origin });
  let away = false;
  // helloUnanswered: how many hellos on the kept connection go unanswered while everything else is served.
  const flaky = { helloUnanswered: 0 };
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    route: (request, response, context) => {
      if (away) return (request.socket.destroy(), true);
      if (flaky.helloUnanswered > 0 && request.url === '/runner/1/hello') {
        flaky.helloUnanswered -= 1;
        return true;
      }
      return routes.handle(request, response, context);
    } });
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-follower-')));
  const store = new RunnerStore(path.join(dataDir, 'runner', 'runner.sqlite'));
  store.saveHost({ name: 'Host A', fingerprint: host.fingerprint, certPem: host.certPem, port: listener.port, addresses: ['127.0.0.1'] });
  const looked = { mdns: 0 };
  const connection = nowhere ? NOWHERE : createHostConnection({ store, identity: runner,
    lookUp: async () => { looked.mdns += 1; return []; } });
  const delivered = [];
  const entry = await startFollowerConsole({ dataDir, port: 0, store, connection, clients, localApi, projectIds, inspect,
    makeLocal, keepChoices, ownsRuntime, deliver: async () => { delivered.push('once'); return { delivered: 0, refused: 0, ...store.outbox() }; } });
  t.after(async () => {
    await entry.close();
    connection.close();
    store.close();
    await listener.close();
    await routes.close();
    hostStore.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { entry, consoleSide, hostStore, runner, store, delivered, hostFingerprint: host.fingerprint, flaky, looked,
    // The host goes off the network; nothing here is told so (review of #1069: a manual drop hid that the status
    // kept a dead connection).
    setAway: (value) => { away = value; } };
}

// A request whose path is sent exactly as written (no URL normalisation on the way).
function rawGet(base, rawPath) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname, port, path: rawPath, method: 'GET', headers: { host: `127.0.0.1:${port}` } },
      (response) => { response.resume(); response.on('end', () => resolve({ status: response.statusCode })); });
    request.on('error', reject);
    request.end();
  });
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

// Review of #1069: a hello that went unanswered ended the whole connection, and with it the host's
// pages and live event streams the follower was carrying.
test('a hello that goes unanswered once does not cut a live event stream from a host that is still there', async (t) => {
  const { entry, flaky } = await pairedRunner(t);
  assert.equal(JSON.parse((await get(`${entry.url}${STATUS_PATH}`)).text).host.reachable, true);
  let closed = false;
  const opened = await new Promise((resolve, reject) => {
    const request = httpRequest(`${entry.url}/api/stream`, (response) => {
      response.once('data', () => resolve(request));
      response.on('close', () => { closed = true; });
    });
    request.on('error', (error) => (error.code === 'ECONNRESET' ? null : reject(error)));
    request.end();
  });
  t.after(() => opened.destroy());
  flaky.helloUnanswered = 1;
  const status = JSON.parse((await get(`${entry.url}${STATUS_PATH}`)).text);
  assert.equal(status.host.reachable, true, 'found again on a fresh connection');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(closed, false, 'the stream carried on the earlier connection is still open');
});

// Review of #1069: with the host away, `/local` waited for a whole search (up to about 8 seconds) before
// it drew anything.
test('this computer\'s own page is drawn at once while the host is away, and looks for it afterwards', async (t) => {
  const { entry, setAway, looked } = await pairedRunner(t);
  setAway(true);
  const searches = looked.mdns;
  const page = await get(`${entry.url}${LOCAL_PATH}`, { headers: { accept: 'text/html' } });
  assert.equal(looked.mdns, searches, 'drawn without looking for the host first');
  assert.equal(page.status, 200);
  assert.match(page.text, /正在找主机…/);
  assert.match(page.text, /void look\(\)/, 'and the page asks right away');
});

// Review of #1075: when looking again also failed, the old connection was ended at once, cutting what it
// still carried, and the look skipped mDNS.
test('when the host cannot be found again, what the old connection carries still finishes, after a full search', async (t) => {
  const { entry, flaky, looked } = await pairedRunner(t);
  assert.equal(JSON.parse((await get(`${entry.url}${STATUS_PATH}`)).text).host.reachable, true);
  let closed = false;
  const opened = await new Promise((resolve, reject) => {
    const request = httpRequest(`${entry.url}/api/stream`, (response) => {
      response.once('data', () => resolve(request));
      response.on('close', () => { closed = true; });
    });
    request.on('error', (error) => (error.code === 'ECONNRESET' ? null : reject(error)));
    request.end();
  });
  t.after(() => opened.destroy());
  const searchesBefore = looked.mdns;
  // Every hello goes unanswered (the search tries each address from each adapter) while the stream is served.
  flaky.helloUnanswered = 1000;
  const status = JSON.parse((await get(`${entry.url}${STATUS_PATH}`)).text);
  assert.equal(status.host.reachable, false, 'not found again: said as it is');
  assert.equal(looked.mdns, searchesBefore + 1, 'the search looked over mDNS too');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, 'the stream on the old connection was not cut');
});

test('a host that went away after it was reached is shown as away, not as answering', async (t) => {
  const { entry, setAway, store } = await pairedRunner(t);
  const first = JSON.parse((await get(`${entry.url}${STATUS_PATH}`)).text);
  assert.equal(first.host.reachable, true);
  assert.ok(store.host().lastSeenAt, 'reaching the host is recorded');
  assert.match(first.line.zh, /在线 · 上次连上 /);
  setAway(true);
  const later = JSON.parse((await get(`${entry.url}${STATUS_PATH}`)).text);
  assert.equal(later.host.reachable, false, 'the kept connection is not taken for the host answering');
  assert.match(later.line.zh, /不在线 · 上次连上 /);
  assert.equal(later.host.lastSeenAt, store.host().lastSeenAt);
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
  assert.match(page.text, /任务记录[\s\S]*a task&#39;s record[\s\S]*等待送出/, 'every waiting record is listed one by one, in words');
  assert.doesNotMatch(page.text, /checkpoint_task_knowledge/, 'no internal name a person must look up');
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
  const { entry, consoleSide, hostFingerprint } = await pairedRunner(t);
  const named = await get(`${entry.url}/remote/host-a/projects/synthetic`, { headers: { accept: 'text/html' } });
  assert.equal(named.status, 302);
  assert.equal(named.headers.location, '/projects/synthetic');
  const api = await get(`${entry.url}/remote/host-a/api/tasks`);
  assert.equal(JSON.parse(api.text).url, '/api/tasks');
  // A receipt names the computer whose console its links open as `issued_by.fingerprint`: the first
  // 16 hex characters of the identity the pairing pinned. That name reaches the same host.
  const byFingerprint = await get(`${entry.url}/remote/${hostFingerprint.slice(0, 16)}/api/tasks`);
  assert.equal(JSON.parse(byFingerprint.text).url, '/api/tasks');
  const seen = consoleSide.seen.length;

  for (const route of ['/remote/attacker.example/api/tasks', '/remote/127.0.0.1:9/api/tasks',
    '/remote//api/tasks', '/remote/other-host/api/tasks']) {
    const refused = await get(`${entry.url}${route}`);
    assert.equal(refused.status, 404, route);
    assert.equal(JSON.parse(refused.text).error, 'unknown_host', route);
  }
  assert.equal(consoleSide.seen.length, seen, 'a host this computer is not paired with is never reached');
});

// Review of #1069: a doubled slash after the host's name, a raw `..`, and a malformed escape.
test('the named proxy and the console relay stay on the host\'s console, whatever the path', async (t) => {
  const { entry, consoleSide } = await pairedRunner(t);
  await get(`${entry.url}/remote/host-a//evil.example/api/tasks`);
  assert.equal(consoleSide.seen.at(-1).url, '/evil.example/api/tasks', 'a path of the console, never another address');
  assert.equal(consoleSide.seen.at(-1).host, new URL(consoleSide.origin).host);
  const seen = consoleSide.seen.length;
  for (const raw of ['/../runner/1/mcp', '/../../replay', '/%2e%2e/runner/1/mcp']) {
    const escaped = await rawGet(entry.url, raw);
    assert.ok([400, 404].includes(escaped.status), `${raw}: ${escaped.status}`);
  }
  assert.equal(consoleSide.seen.length, seen, 'nothing outside the console was reached on the host');
  assert.equal((await get(`${entry.url}/remote/%E0%A4%A/api/tasks`)).status, 400, 'a malformed escape is the caller\'s');
  const badJson = await get(`${entry.url}${ADDRESS_PATH}`, { method: 'POST', body: '{not json',
    headers: { 'content-type': 'application/json', origin: entry.url } });
  assert.equal(badJson.status, 400);
});

// The host does not answer: one button, then one field, instead of a dead end.
test('「添加主机地址」 takes a private address from this computer\'s own page and nothing else', async (t) => {
  const { entry, store } = await pairedRunner(t, { nowhere: true });
  const page = await get(`${entry.url}${LOCAL_PATH}`, { headers: { accept: 'text/html' } });
  assert.match(page.text, /添加主机地址/, 'the next step is there, shown once the page finds the host away');
  assert.match(page.text, /正在找主机…/, 'drawn at once, saying it is looking for the host');
  assert.equal(JSON.parse((await get(`${entry.url}${STATUS_PATH}`)).text).host.reachable, false,
    'what the page then asks says plainly that the host did not answer');
  assert.match(page.text, /同一个 VPN/, 'how the two computers reach each other is said as it is');
  assert.doesNotMatch(page.text, /中继/, 'no relay is planned, so none is promised');

  const forged = await get(`${entry.url}${ADDRESS_PATH}`, { method: 'POST', body: '{"address":"192.0.2.20"}',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example' } });
  assert.equal(forged.status, 403);
  const noOrigin = await get(`${entry.url}${ADDRESS_PATH}`, { method: 'POST', body: '{"address":"192.0.2.20"}',
    headers: { 'content-type': 'application/json' } });
  assert.equal(noOrigin.status, 405);
  for (const address of ['198.51.100.7', 'host.example', '', '127.0.0.1\n10.0.0.1', '100.128.0.1']) {
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
  // A VPN's carrier-grade address (Tailscale and the like) is one a host is reached at, as with add-address.
  const vpn = await get(`${entry.url}${ADDRESS_PATH}`, { method: 'POST', body: '{"address":"100.84.12.9"}',
    headers: { 'content-type': 'application/json', origin: entry.url } });
  assert.equal(vpn.status, 200);
  assert.equal(store.host().addresses[0], '100.84.12.9');
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

// Review of #1069: 「现在重试」 on a revoked computer said the host was unreachable.
test('a revoked computer is told it was revoked, with the step that pairs it again, never that the host is away', async (t) => {
  const { entry, hostStore, runner, store } = await pairedRunner(t);
  hostStore.revoke(runner.fingerprint);
  await get(`${entry.url}/api/tasks`);
  assert.ok(store.host().revokedAt, 'the host said so');
  const sync = await get(`${entry.url}${SYNC_PATH}`, { method: 'POST', body: '{}',
    headers: { 'content-type': 'application/json', origin: entry.url } });
  assert.equal(sync.status, 403);
  const body = JSON.parse(sync.text);
  assert.equal(body.error, 'runner_revoked');
  assert.match(body.message, /撤销/);
  assert.equal(body.action.command, 'fuli runner invite');
  const api = await get(`${entry.url}/api/tasks`);
  assert.equal(JSON.parse(api.text).error, 'runner_revoked');
});

test('the band opens this computer\'s own page, and a host page shown while away opens by itself later', async (t) => {
  const { entry, setAway } = await pairedRunner(t);
  const band = await get(`${entry.url}/__fuli-follower/band.js`);
  assert.match(band.text, /line\.href = "\/local"/);
  setAway(true);
  const awayPage = await get(`${entry.url}/projects/synthetic`, { headers: { accept: 'text/html' } });
  assert.match(awayPage.text, /<body data-requested="1">/);
  assert.match(awayPage.text, /location\.reload\(\)/);
  const own = await get(`${entry.url}${LOCAL_PATH}`, { headers: { accept: 'text/html' } });
  assert.doesNotMatch(own.text, /data-requested/, 'this computer\'s own page does not reload itself');
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
    setupRunnerClients: async () => [{ id: 'codex', label: 'Codex', status: 'connected' }], prepareLocalRuntime: () => false,
    planSetup: () => assert.fail('a computer that follows a host plans no graph runtime') });
  assert.equal(result.status, 'runner');
  // `fuli update` runs `fuli setup --yes --connected-only` with the new version: the pairing stays.
  const updated = await runSetupCommand(['--data-dir', dataDir, '--yes', '--connected-only'], { write: () => {},
    setupRunnerClients: async () => [{ id: 'codex', label: 'Codex', status: 'connected' }], prepareLocalRuntime: () => false,
    planSetup: () => assert.fail('an update never sets a FULI up over the pairing') });
  assert.equal(updated.status, 'runner');
  assert.equal(isRunnerDataDirectory(dataDir), true);
});

test('fuli setup on a runner sets up its clients only', async (t) => {
  const dataDir = runnerDataDir(t);
  const written = [];
  const result = await runSetupCommand(['--data-dir', dataDir, '--yes'], { write: (line) => written.push(line),
    setupRunnerClients: async () => [{ id: 'codex', label: 'Codex', status: 'connected' }], prepareLocalRuntime: () => false,
    planSetup: () => assert.fail('a runner plans no graph runtime') });
  assert.equal(result.status, 'runner');
  assert.equal(result.exitCode, 0);
  assert.match(written.join('\n'), /only its clients/);
});

// Runs the page's own script with a stub page: each element the script asks for, a fetch it is given and
// timers that fire at once, so what the script does is checked without a browser or the wall clock.
async function runPageScript(html, answers) {
  const script = html.split('<script type="module">')[1].split('</script>')[0];
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, { selector, textContent: '', hidden: selector === '[data-away-step]', className: 'dot',
        dataset: {}, addEventListener() {}, append() {}, focus() {} });
    }
    return elements.get(selector);
  };
  const timers = [];
  const document = { querySelector: element, querySelectorAll: () => [], body: { dataset: {} } };
  let call = 0;
  const fetch = async () => {
    const next = answers[Math.min(call++, answers.length - 1)];
    if (next instanceof Error) throw next;
    return { json: async () => next };
  };
  new Function('document', 'fetch', 'setTimeout', 'setInterval', 'location', 'navigator', script)(
    document, fetch, (run) => timers.push(run), () => {}, { reload() {} }, {});
  for (let index = 0; index < 50; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const next = timers.shift();
    if (!next) break;
    next();
  }
  return { element, calls: () => call };
}

const PAGE_STATUS = { paired: true, host: { name: 'Host A', reachable: null, revokedAt: null, lastSeenAt: '2026-11-01T00:00:00.000Z' },
  outbox: { entries: [] }, capabilities: [] };

// Review of #1075: a look that failed once left the page at 「正在找主机…」 for ever, with the next step hidden.
test('this computer\'s own page keeps looking for a while; a console that never answered is not taken for the host being away', async () => {
  const html = followerConsolePage({ status: PAGE_STATUS, hostPath: '/remote/host-a/' });
  const silent = await runPageScript(html, [new Error('busy')]);
  assert.equal(silent.calls(), LOOK_TRIES, 'asked again, a bounded number of times');
  assert.match(silent.element('[data-reach]').textContent, /本机控制台没有回答，请刷新页面/);
  assert.equal(silent.element('[data-away-step]').hidden, true, 'no next step about the host, which nothing was learned of');

  const away = await runPageScript(html, [new Error('busy'), { host: { reachable: false }, line: { zh: '跟随 Host A · 不在线' } }]);
  assert.equal(away.element('[data-reach]').textContent, '现在不在线');
  assert.equal(away.element('[data-away-step]').hidden, false, '「添加主机地址」 is offered when the host is said to be away');
});

test('once the host is found, the page says so and when it was last reached', async () => {
  const html = followerConsolePage({ status: PAGE_STATUS, hostPath: '/remote/host-a/' });
  const found = { host: { reachable: true, lastSeenAt: '2026-11-23T09:00:00.000Z' }, line: { zh: '跟随 Host A · 在线' } };
  const page = await runPageScript(html, [new Error('busy'), found]);
  assert.equal(page.element('[data-reach]').textContent, '现在在线');
  assert.equal(page.element('[data-reached]').textContent, '2026-11-23T09:00:00.000Z');
  assert.equal(page.element('[data-away-step]').hidden, true);
});

test('a follower with no explicit local project keeps each existing console destination', () => {
  for (const [path, answer] of [[LOCAL_PATH, 'local'], [STATUS_PATH, 'local'], [SYNC_PATH, 'local'],
    [ADDRESS_PATH, 'local'], ['/remote/host-a/', 'host'], ['/api/personal-projects', 'host'],
    ['/api/personal-projects/sample/history', 'host'], ['/api/system/runtime/leases', 'host'],
    ['/api/project-agent-tasks', 'host'], ['/api/data-format', 'host'], ['/', 'host']]) {
    assert.equal(whoAnswers(path, { ids: [], projectId: 'sample' }), answer, path);
  }
});

test('project page data and loopback leases go to the owning computer; a relayed body keeps its bytes', async (t) => {
  const handled = [];
  const localApi = { async handle(request, response, url) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    handled.push([url.pathname, Buffer.concat(chunks).toString()]);
    response.end('here');
  } };
  const { entry, consoleSide } = await pairedRunner(t, { localApi, projectIds: () => ['sample'] });
  for (const path of ['/api/personal-projects/sample/history', '/api/project-agent-tasks?personalProjectId=sample',
    '/api/system/runtime/leases', '/api/system/runtime/leases/synthetic', '/api/personal-projects']) {
    assert.equal(await (await fetch(entry.url + path)).text(), 'here', path);
  }
  const put = body => fetch(entry.url + '/api/personal-projects', { method: 'PUT', body,
    headers: { 'content-type': 'application/json' } });
  const local = '{ "projectId": "sample" }';
  assert.equal(await (await put(local)).text(), 'here');
  assert.deepEqual(handled.at(-1), ['/api/personal-projects', local]);
  const remote = '{ "projectId": "elsewhere" }';
  assert.equal((await (await put(remote)).json()).body, remote);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(entry.url + '/api/system/runtime/leases', { headers: { host: 'example.test' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal((await fetch(entry.url + '/__fuli-follower/graph-backups', { method: 'POST' })).status, 403);
  assert.equal(consoleSide.seen.some(row => row.url.includes('/runtime/leases')), false);
});

test('the local lease endpoints and merged project list use only this computer’s broker and application', async t => {
  let opens = 0;
  const calls = [];
  const broker = { current: async () => ({ withLease: (_owner, fn) => fn(),
    acquire: async () => { calls.push('acquire'); return { leaseId: 'sample' }; },
    refresh: id => ({ refreshed: id === 'sample' }), release: id => ({ released: id === 'sample' }) }) };
  const localApi = createFollowerLocalApi({ paths: {}, broker: () => broker, store: { host: () => ({ name: 'Host A' }) },
    connection: { getText: async () => ({ status: 200, text: JSON.stringify([{ project_id: 'from-host' }]) }) },
    open: async () => { opens++; return { listPersonalProjects: async () => [{ project_id: 'sample' }, { project_id: 'unrouted' }] }; } });
  const { entry } = await pairedRunner(t, { projectIds: () => ['sample'], localApi });
  const lease = entry.url + '/api/system/runtime/leases';
  const json = { 'content-type': 'application/json' };
  const acquired = await (await fetch(lease, { method: 'POST', body: '{}', headers: json })).json();
  assert.equal(acquired.leaseId, 'sample', JSON.stringify(acquired));
  assert.equal((await (await fetch(lease + '/sample', { method: 'PATCH', body: '{}', headers: json })).json()).refreshed, true);
  assert.equal((await (await fetch(lease + '/sample', { method: 'DELETE' })).json()).released, true);
  assert.deepEqual(calls, ['acquire']);
  assert.equal(opens, 0);
  const list = await (await fetch(entry.url + '/api/personal-projects')).json();
  assert.deepEqual(list.map(row => [row.project_id, row.owner]), [['from-host', 'host'], ['sample', 'this_computer']]);
  assert.equal(opens, 1);
});

// A local API that only records what reached it.
function recordingApi() {
  const handled = [];
  return { handled, async handle(request, response, url) {
    handled.push([request.method, url.pathname]);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"here":true}');
  } };
}

test('this computer’s own API refuses an FLA’s delegated change and keeps the console’s request policy', async (t) => {
  const api = recordingApi();
  const { entry, consoleSide } = await pairedRunner(t, { localApi: api, projectIds: () => ['sample'] });
  const json = { 'content-type': 'application/json' };
  const delegated = await fetch(`${entry.url}/api/project-agent-tasks?personalProjectId=sample`, { method: 'POST',
    headers: { ...json, [DELEGATION_HEADER]: 'synthetic' }, body: '{}' });
  assert.equal(delegated.status, 503);
  assert.equal((await delegated.json()).code, 'delegation_unavailable');
  const forwarded = await fetch(`${entry.url}/api/project-agent-tasks?personalProjectId=sample`, {
    headers: { [DELEGATION_HEADER]: 'synthetic', 'x-forwarded-for': '192.0.2.7' } });
  assert.equal((await forwarded.json()).code, 'local_user_only');
  for (const path of ['/__fuli-follower/graph-backups', '/__fuli-follower/graph-format']) {
    const answer = await fetch(entry.url + path, { method: 'POST', body: '{"action":"backup"}',
      headers: { ...json, origin: entry.url, [DELEGATION_HEADER]: 'synthetic' } });
    assert.equal(answer.status, 503, path);
    assert.equal((await fetch(entry.url + path, { method: 'POST', body: '{}',
      headers: { ...json, origin: 'http://example.test' } })).status, 403, `${path}: another site`);
    assert.equal((await fetch(entry.url + path, { method: 'POST', body: '{}', headers: json })).status, 403,
      `${path}: no Origin is not this console's page`);
  }
  const plain = await fetch(`${entry.url}/api/project-agent-tasks?personalProjectId=sample`, { method: 'POST', body: '{}' });
  assert.equal(plain.status, 415, 'a write that is not JSON');
  const crossSite = await fetch(`${entry.url}/api/project-agent-tasks?personalProjectId=sample`,
    { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
  assert.equal(crossSite.status, 403, 'another site’s link reaches nothing of this computer’s data');
  const script = await fetch(`${entry.url}/api/project-agent-tasks?personalProjectId=sample`,
    { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(script.status, 403);
  assert.deepEqual(api.handled, []);
  assert.equal(consoleSide.seen.length, 0, 'nothing was carried to the host');
  assert.equal((await fetch(`${entry.url}/api/project-agent-tasks?personalProjectId=sample`, { method: 'POST',
    body: '{}', headers: json })).status, 200);
  assert.deepEqual(api.handled, [['POST', '/api/project-agent-tasks']]);
});

test('only a loopback socket under this console’s own name reaches it', async (t) => {
  let handler;
  const createServer = (listener) => { handler = listener; return createServerReal(listener); };
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-follower-')));
  const store = new RunnerStore(path.join(dataDir, 'runner', 'runner.sqlite'));
  const api = recordingApi();
  const entry = await startFollowerConsole({ dataDir, port: 0, store, connection: NOWHERE, localApi: api,
    projectIds: () => ['sample'], createServer });
  t.after(async () => { await entry.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const host = new URL(entry.url).host;
  for (const remoteAddress of ['192.0.2.5', '::ffff:192.0.2.5']) {
    const answer = fakeResponse();
    handler({ method: 'GET', url: '/api/project-agent-tasks?personalProjectId=sample', headers: { host },
      socket: { remoteAddress } }, answer);
    await answer.done;
    assert.equal(answer.status, 403, remoteAddress);
  }
  assert.deepEqual(api.handled, []);
});

function fakeResponse() {
  let finish;
  const response = { status: null, headers: {}, headersSent: false, done: new Promise(resolve => { finish = resolve; }),
    setHeader(name, value) { this.headers[name] = value; }, removeHeader(name) { delete this.headers[name]; },
    writeHead(status) { this.status = status; this.headersSent = true; }, end() { finish(); }, destroy() { finish(); } };
  return response;
}

test('a request naming a project of this computer is answered here or refused here, never carried to the host', async (t) => {
  const api = recordingApi();
  const { entry, consoleSide } = await pairedRunner(t, { localApi: api, projectIds: () => ['sample'] });
  const json = { 'content-type': 'application/json' };
  const send = (path, { method = 'GET', body } = {}) => fetch(entry.url + path,
    { method, headers: json, ...(body === undefined ? {} : { body }) });
  const cases = [
    // [path, options, status, refusal code or where it went]
    ['/api/capture', { method: 'POST', body: '{"personalProjectId":"sample","text":"x"}' }, 200, 'here'],
    ['/api/knowledge/items?projectId=sample', {}, 200, 'here'],
    ['/api/knowledge/items/synthetic?projectId=sample', { method: 'PATCH', body: '{}' }, 200, 'here'],
    ['/api/project-agent-name-changes?personalProjectId=sample', {}, 200, 'here'],
    ['/api/project-agent-executor-actuals', { method: 'POST', body: '{"project_id":"sample"}' }, 200, 'here'],
    ['/api/personal-projects', { method: 'PUT', body: '{"project":"sample"}' }, 200, 'here'],
    ['/api/data-format?personalProjectId=sample', {}, 409, 'not_served_here'],
    ['/api/project-agents', { method: 'POST', body: '{"personalProjectId":"sample"}' }, 409, 'not_served_here'],
    ['/api/personal-projects/sample/archive', { method: 'POST', body: '{}' }, 409, 'not_served_here'],
    ['/api/capture', { method: 'POST', body: '{"personalProjectId":"sample",' }, 409, 'body_unreadable'],
    ['/api/capture', { method: 'POST', body: JSON.stringify({ personalProjectId: 'sample', text: 'x'.repeat(1024 * 1024) }) },
      409, 'body_too_large'],
    ['/api/capture?projectId=elsewhere', { method: 'POST', body: '{"personalProjectId":"sample"}' }, 409, 'projects_on_both'],
    ['/api/capture', { method: 'POST', body: '{"personalProjectId":"elsewhere"}' }, 200, 'host'],
    ['/api/data-format', {}, 200, 'host'],
    // Larger than read to decide: whatever the rest names, it goes nowhere while projects are here.
    ['/api/capture', { method: 'POST', body: JSON.stringify({ text: 'y'.repeat(1024 * 1024 + 10) }) }, 409, 'body_too_large'],
    // This computer's project named only where the destination is not decided (audit of #1115, item 3):
    // nested, in a list, under another field's name, in another query value, escaped.
    ['/api/employee-templates/synthetic/call', { method: 'POST', body: '{"arguments":{"personalProjectId":"sample"}}' },
      409, 'not_decidable'],
    ['/api/project-agent-recruitments', { method: 'POST', body: '{"personalProjectIds":["sample"]}' }, 409, 'not_decidable'],
    ['/api/search?contextPersonalProjectId=sample&q=x', {}, 409, 'not_decidable'],
    ['/api/search?scopes=global,sample', {}, 409, 'not_decidable'],
    ['/api/capture', { method: 'POST', body: '{"text":"\\u0073ample"}' }, 409, 'not_decidable'],
    ['/api/capture', { method: 'POST', body: '{"personalProjectId":"sample","related":["elsewhere"]}' }, 200, 'here'],
    ['/api/capture', { method: 'POST', body: '{"personalProjectId":"elsewhere","context":{"projectId":"sample"}}' },
      409, 'projects_on_both'],
    ['/api/search?q=other', {}, 200, 'host']
  ];
  for (const [path, options, status, where] of cases) {
    const hostSeen = consoleSide.seen.length;
    const handled = api.handled.length;
    const answer = await send(path, options);
    const body = await answer.json();
    assert.equal(answer.status, status, `${path} ${JSON.stringify(body)}`);
    if (where === 'here') assert.equal(api.handled.length, handled + 1, path);
    else if (where === 'host') assert.equal(consoleSide.seen.length, hostSeen + 1, path);
    else {
      assert.equal(body.error, where, path);
      assert.equal(consoleSide.seen.length, hostSeen, `${path}: not carried to the host`);
      assert.equal(api.handled.length, handled, `${path}: not answered here`);
    }
  }
});

test('a follower with no project routed here never reads a request to decide where it goes', async (t) => {
  let inspected = 0;
  const api = recordingApi();
  const { entry, consoleSide } = await pairedRunner(t, { localApi: api, projectIds: () => [],
    inspect: async (...args) => { inspected++; return inspectProjectRequest(...args); } });
  for (const [path, method, body] of [['/api/capture', 'POST', '{"personalProjectId":"sample"}'],
    ['/api/personal-projects/sample/history', 'GET'], ['/api/personal-projects', 'GET'],
    ['/api/system/runtime/leases', 'POST', '{}'], ['/api/capture', 'POST', '{"personalProjectId":"sample",']]) {
    const answer = await fetch(entry.url + path, { method, headers: { 'content-type': 'application/json' }, body });
    assert.equal(answer.status, 200, path);
  }
  assert.equal(inspected, 0);
  assert.deepEqual(api.handled, []);
  assert.equal(consoleSide.seen.length, 5);
});

test('the merged project list answers the host’s projects without waiting long for this computer’s', async t => {
  const hostList = { getText: async () => ({ status: 200, text: JSON.stringify([{ project_id: 'from-host' }]) }) };
  const asleep = { current: async () => ({ withLease: () => new Promise(() => {}) }) };
  const waiting = createFollowerLocalApi({ paths: {}, broker: () => asleep, store: { host: () => ({ name: 'Host A' }) },
    connection: hostList, localListWaitMs: 50, open: async () => assert.fail('not reached') });
  const { entry } = await pairedRunner(t, { projectIds: () => ['sample'], localApi: waiting });
  const answer = await fetch(entry.url + '/api/personal-projects');
  assert.equal(answer.headers.get('x-fuli-local-projects'), 'unavailable');
  assert.equal(answer.headers.get('x-fuli-host-projects'), null);
  assert.deepEqual((await answer.json()).map(row => [row.project_id, row.owner]), [['from-host', 'host']]);

  const none = createFollowerLocalApi({ paths: {}, broker: () => null, store: { host: () => null },
    connection: { getText: async () => ({ reachable: false }) }, open: async () => assert.fail('not reached') });
  const away = await pairedRunner(t, { projectIds: () => ['sample'], localApi: none });
  const empty = await fetch(away.entry.url + '/api/personal-projects');
  assert.equal(empty.headers.get('x-fuli-host-projects'), 'unavailable');
  assert.equal(empty.headers.get('x-fuli-local-projects'), 'unavailable');
  assert.deepEqual(await empty.json(), []);
  assert.equal((await fetch(away.entry.url + '/api/project-agent-tasks?personalProjectId=sample')).status, 503);
});

test('「放在这台电脑」 is asked by this computer\'s own page only, and answers what came of it', async (t) => {
  const asked = [];
  const makeLocal = async (input) => {
    asked.push(input);
    return input.folder === '/synthetic/on-host'
      ? { refused: { code: 'project_on_host', message: 'Project on-host is already on Host A.\n项目 on-host 在 Host A 上已经有了。' } }
      : { status: 'local', scope: 'project:widgets', folder: input.folder, made: true };
  };
  const { entry, consoleSide } = await pairedRunner(t, { makeLocal });
  const json = { 'content-type': 'application/json' };
  const post = (body, headers = { ...json, origin: entry.url }) => fetch(entry.url + MAKE_LOCAL_PATH,
    { method: 'POST', body: JSON.stringify(body), headers });
  const made = await post({ projectPath: ' /synthetic/widgets ', projectId: '' });
  assert.equal(made.status, 200);
  assert.equal((await made.json()).scope, 'project:widgets');
  assert.deepEqual(asked, [{ folder: '/synthetic/widgets', projectId: null }]);
  const refused = await post({ projectPath: '/synthetic/on-host' });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'project_on_host',
    message: 'Project on-host is already on Host A.\n项目 on-host 在 Host A 上已经有了。' });
  for (const headers of [json, { ...json, origin: 'http://example.test' }]) {
    assert.notEqual((await post({ projectPath: '/synthetic/widgets' }, headers)).status, 200, JSON.stringify(headers));
  }
  assert.equal(asked.length, 2, 'another site\'s page, or a program without this page\'s origin, asks nothing');
  assert.equal(consoleSide.seen.length, 0, 'never carried to the host');
});

test('while the first project is made, this computer\'s leases are its own; otherwise they stay the host\'s', () => {
  assert.equal(whoAnswers('/api/system/runtime/leases', { ids: [], ownsRuntime: true }), 'local');
  assert.equal(whoAnswers('/api/system/runtime/leases/synthetic', { ids: [], ownsRuntime: true }), 'local');
  assert.equal(whoAnswers('/api/system/runtime/leases', { ids: [], ownsRuntime: false }), 'host');
  assert.equal(whoAnswers('/api/personal-projects', { ids: [], ownsRuntime: true }), 'host', 'only the leases');
  assert.equal(whoAnswers(MAKE_LOCAL_PATH, { ids: [] }), 'local');
});

test('the page offers the folders worked in here, says why it cannot when it cannot, and types no command', async (t) => {
  const keep = { refusal: null, folders: ['/synthetic/checkout-x'], localProjects: [{ id: 'widgets', scope: 'project:widgets',
    folder: '/synthetic/widgets' }] };
  const { entry } = await pairedRunner(t, { keepChoices: () => keep });
  const page = await (await fetch(entry.url + LOCAL_PATH, { headers: { accept: 'text/html' } })).text();
  assert.match(page, /放在这台电脑/);
  assert.match(page, /data-keep-folder="\/synthetic\/checkout-x" aria-label="把 \/synthetic\/checkout-x 放在这台电脑/);
  assert.match(page, /<label>文件夹的完整路径[\s\S]*<input name="projectPath"/, 'each field has its label');
  assert.match(page, /data-own-projects="1"/, 'with a project here, its backups and data format are asked for');
  assert.match(page, /只能恢复到这台电脑/);
  const own = page.slice(page.indexOf('id="keep-here"'), page.indexOf('<h2>什么跑在哪里'));
  assert.doesNotMatch(own, /fuli [a-z]/, 'no command to type in what this computer offers');

  const closed = followerConsolePage({ status: PAGE_STATUS, hostPath: '/remote/host-a/', keep: { refusal: {
    code: 'host_needs_update', message: 'FULI on Host A is too old.\nHost A 的 FULI 版本旧。' }, folders: [], localProjects: [] } });
  assert.match(closed, /Host A 的 FULI 版本旧/);
  assert.doesNotMatch(closed, /<form data-keep-form|data-own-projects="1"/, 'nothing to press while it cannot be done');
});

test('what waits for the host says held apart from refused, in words, without the code', () => {
  const html = outbox({ queued: 1, failedCount: 2, entries: [
    { id: 'recruit:synthetic', tool: 'global_writes', state: 'queued', queuedAt: '2026-11-25T08:00:00.000Z', reason: null },
    { id: 'global:synthetic', tool: 'global_writes', state: 'failed', queuedAt: '2026-11-25T08:01:00.000Z',
      reason: 'host_too_old:0.28.0' },
    { id: 'global:other', tool: 'global_writes', state: 'failed', queuedAt: '2026-11-25T08:02:00.000Z',
      reason: 'invalid_input' }] });
  assert.match(html, /1 条等待送出，1 条暂存，1 条被主机拒绝/);
  assert.match(html, /请主机建一位 FLA/);
  assert.match(html, /1 位 FLA 在等主机建[\s\S]*离开主机时还没建好的，离开后要在这台电脑上取消再重新招/);
  assert.match(html, /暂存：主机版本旧，主机更新后自动送出/);
  assert.match(html, /主机拒绝了，不会再送/);
  assert.doesNotMatch(html, /host_too_old|invalid_input|global_writes/);
});
