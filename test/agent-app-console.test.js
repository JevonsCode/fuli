import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAgentAppApiRequest } from '../src/http/agent-app-api-router.js';
import { handleAgentAppPageRequest } from '../src/http/agent-app-page-router.js';
import { createServer } from '../src/server.js';
import { appRegistry, CONSOLE_USER, FILES, MANIFEST, verifiedApp } from '../test-support/agent-app-hosts.js';
import { closeServer, requestJson } from '../test-support/server.js';

// The console's Apps section (#346 0.23): starting, stopping and restarting an
// app, and opening a page app in its frame. Synthetic apps in a fake runner
// that starts nothing.

const PAGE = Object.freeze({ name: 'dispatch-board', runtime: { apiVersion: 1, webRoot: 'web' }, data: { scope: 'none' } });
const PAGE_FILES = Object.freeze([
  { path: 'web/index.html', content: '<h1>Synthetic dispatch board</h1><script src="board.js"></script>' },
  { path: 'web/board.js', content: 'document.title = "Synthetic board";\n' },
  { path: 'notes/outside.txt', content: 'not part of the page\n' }
]);

async function served(t, host) {
  const { server, url } = await createServer({ app: { agentApps: host.service }, port: 0 });
  t.after(() => closeServer(server));
  return url;
}

async function consoleApproved(host, manifest = {}, files = FILES) {
  const submitted = await host.service.submit({ personalSpaceId: 'space-a', agentId: 'agent-jvs',
    manifest: { ...MANIFEST, ...manifest }, files });
  await host.service.approve({ appId: submitted.appId, version: submitted.version, digest: submitted.digest,
    approver: CONSOLE_USER });
  return submitted;
}

test('the console starts, restarts and stops a confirmed app and answers with its instance', async (t) => {
  const host = appRegistry(t).host({ pid: 101 });
  const { appId } = await verifiedApp(host);
  const url = await served(t, host);
  const post = (action) => requestJson(`${url}/api/agent-apps/${appId}/${action}`, { method: 'POST', body: {} });

  const started = await post('start');
  assert.equal(started.status, 200);
  assert.deepEqual([started.body.status, started.body.instance.state, started.body.instance.generation],
    ['running', 'running', 1]);
  const restarted = await post('restart');
  assert.equal(restarted.status, 200);
  assert.deepEqual([restarted.body.status, restarted.body.instance.generation], ['running', 2]);
  assert.equal(host.runner.started.length, 2);
  const stopped = await post('stop');
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, 'sealed');
  assert.notEqual(stopped.body.instance.stoppedAt, null);
});

test('a start of a version approved only in the console is refused with the run gate\'s reason', async (t) => {
  const host = appRegistry(t).host({ pid: 101 });
  const { appId } = await consoleApproved(host);
  const url = await served(t, host);

  const refused = await requestJson(`${url}/api/agent-apps/${appId}/start`, { method: 'POST', body: {} });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'confirmation_required');
  assert.equal(host.runner.started.length, 0);
});

test('start, stop and restart are accepted only from this computer and take no body', async (t) => {
  const host = appRegistry(t).host({ pid: 101 });
  const { appId } = await verifiedApp(host);
  const app = { agentApps: host.service };
  for (const action of ['start', 'stop', 'restart']) {
    const remote = await apiDirectly(app, `/api/agent-apps/${appId}/${action}`, {}, '192.168.1.20');
    assert.equal(remote.status, 403, action);
  }
  await assert.rejects(apiDirectly(app, `/api/agent-apps/${appId}/start`, { force: true }, '127.0.0.1'),
    /Invalid Agent app request/);
  assert.equal(host.runner.started.length, 0);
});

test('a confirmed page app opens in a sandbox that keeps it away from the console origin', async (t) => {
  const host = appRegistry(t).host({ pid: 101 });
  const { appId } = await verifiedApp(host, PAGE, PAGE_FILES);
  const url = await served(t, host);

  const index = await fetch(`${url}/app-pages/${appId}/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await index.text(), /Synthetic dispatch board/);
  const policy = index.headers.get('content-security-policy');
  const authority = new URL(url).host;
  assert.match(policy, /^sandbox allow-scripts allow-forms;/);
  assert.match(policy, new RegExp(`script-src http://${authority}/app-pages/${appId}/;`));
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, new RegExp(`frame-ancestors http://${authority}$`));
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(index.headers.get('cache-control'), 'no-store');
  assert.equal(index.headers.get('access-control-allow-origin'), null);

  // Its own script, fetched from the sandbox's opaque origin as a module would be.
  const script = await fetch(`${url}/app-pages/${appId}/board.js`, { headers: { origin: 'null' } });
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(script.headers.get('access-control-allow-origin'), 'null');

  const bare = await fetch(`${url}/app-pages/${appId}`, { redirect: 'manual' });
  assert.deepEqual([bare.status, bare.headers.get('location')], [308, `/app-pages/${appId}/`]);
  for (const outside of ['..%2Fnotes%2Foutside.txt', '%2E%2E/notes/outside.txt', 'missing.js']) {
    assert.equal((await fetch(`${url}/app-pages/${appId}/${outside}`)).status, 404, outside);
  }
  assert.equal((await fetch(`${url}/app-pages/${appId}/`, { method: 'POST' })).status, 405);
});

test('a page opens only while the run gate accepts it, and only on this server\'s loopback authority', async (t) => {
  const host = appRegistry(t).host({ pid: 101 });
  const { appId } = await consoleApproved(host, PAGE, PAGE_FILES);
  const service = await verifiedApp(host);
  const url = await served(t, host);

  const unconfirmed = await fetch(`${url}/app-pages/${appId}/`);
  assert.equal(unconfirmed.status, 409);
  assert.equal((await unconfirmed.json()).code, 'confirmation_required');
  const notPage = await fetch(`${url}/app-pages/${service.appId}/`);
  assert.equal(notPage.status, 404);
  assert.equal((await notPage.json()).code, 'not_page');
  assert.equal((await fetch(`${url}/app-pages/no-such-app/`)).status, 404);

  const app = { agentApps: host.service };
  const authority = new URL(url).host;
  assert.equal((await pageDirectly(app, `/app-pages/${service.appId}/`, { host: 'fuli.example:80' }, authority)).status, 403);
  assert.equal((await pageDirectly(app, `/app-pages/${service.appId}/`, { host: authority }, authority, '192.168.1.20')).status, 403);
});

async function apiDirectly(app, path, body, remoteAddress) {
  const request = Object.assign((async function* () { yield Buffer.from(JSON.stringify(body)); })(), {
    method: 'POST', url: path, headers: { host: '127.0.0.1', 'content-type': 'application/json' }, socket: { remoteAddress }
  });
  const response = recorded();
  await handleAgentAppApiRequest({ request, response, url: new URL(path, 'http://127.0.0.1'), app });
  return response;
}

async function pageDirectly(app, path, headers, authority, remoteAddress = '127.0.0.1') {
  const request = { method: 'GET', url: path, headers, socket: { remoteAddress } };
  const response = recorded();
  await handleAgentAppPageRequest({ request, response, app, authority });
  return response;
}

function recorded() {
  return { status: null, body: null,
    writeHead(status) { this.status = status; }, setHeader() {}, end(text) { this.body = text ? JSON.parse(text) : null; } };
}
