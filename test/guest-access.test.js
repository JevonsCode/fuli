import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createGuestRoutes } from '../src/guest-access/guest-routes.js';
import { startGuestListener } from '../src/guest-access/listener.js';
import { createGuestAccess } from '../src/guest-access/runtime.js';
import { handleGuestLinksRequest } from '../src/http/guest-links-api-router.js';
import { handleVisitorAccessRequest } from '../src/http/visitor-access-api-router.js';
import { discoverGuestAddresses, discoverLanAddresses, isGuestSourceAddress } from '../src/server/lan-access.js';
import { createVisitorAccess } from '../src/visitor-access/port.js';
import { reachableModules } from '../test-support/module-graph.js';

// Synthetic data only: invented project, lead, knowledge and addresses; the
// listener binds loopback on an ephemeral port and accepts loopback as its
// "private" source for these tests.
const SPACE = 'space-synthetic';
const PROJECT = 'project-guest';
const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date('2026-11-01T00:00:00.000Z');

function clock() {
  let current = START.getTime();
  return { now: () => new Date(current), advance: (ms) => { current += ms; } };
}

function fakeHost() {
  return {
    getProject: async (projectId) => {
      if (projectId !== PROJECT) throw new Error('not found');
      return { projectId, name: 'Synthetic guest project' };
    },
    projectTeam: async () => ({ lead: { name: 'Synthetic lead', responsibility: 'Keeps notes in /home/someone/private/notes.md' } })
  };
}

function application(searches) {
  return { config: { personal: { spaceId: SPACE } }, personal: { search: async (request) => {
    searches.push(request);
    return { facts: [{ relationship: 'USES', fact: 'Deploys from /srv/synthetic/app on port 4100', score: 1,
      defined_project_id: request.active_personal_project_id, inherited: false }], entities: [] };
  } } };
}

function setup(t, { sourceAllowed = (address) => address === '127.0.0.1' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-guest-access-'));
  const time = clock();
  const searches = [];
  const visitorAccess = createVisitorAccess({ path: join(directory, 'visitor-access.sqlite'), application: application(searches), now: time.now });
  const started = [];
  const keptLinks = [];
  const guestAccess = createGuestAccess({ visitorAccess, host: fakeHost(), port: 0, discoverAddresses: () => ['127.0.0.1'],
    now: () => time.now().getTime(),
    createRoutes: (deps) => {
      const routes = createGuestRoutes(deps);
      return { ...routes, keepLinks: (ids) => { keptLinks.push(ids); return routes.keepLinks(ids); } };
    },
    startListener: async (options) => {
      const listener = await startGuestListener({ ...options, sourceAllowed });
      started.push(listener);
      return listener;
    } });
  t.after(async () => {
    await guestAccess.close();
    visitorAccess.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, time, searches, visitorAccess, guestAccess, started, keptLinks };
}

function call(authority, { method = 'GET', path = '/guest/1/card', token, host = authority, headers = {}, body } = {}) {
  const [hostname, port] = authority.split(':');
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname, port: Number(port), method, path, agent: false,
      headers: { host, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers } },
    (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}

test('a link is fgl_ and 32 random bytes, stored only as its SHA-256, 7 days by default, asking only', async (t) => {
  const { directory, guestAccess, visitorAccess } = setup(t);
  const created = await guestAccess.create({ projectId: PROJECT });
  assert.equal(created.ok, true);
  assert.match(created.token, /^fgl_[A-Za-z0-9_-]{43}$/);
  assert.equal(Date.parse(created.link.expiresAt) - Date.parse(created.link.createdAt), 7 * DAY_MS);
  assert.equal(visitorAccess.requesterMode(`guest:${created.link.id}`).mode, 'ask_only');
  const database = new DatabaseSync(join(directory, 'visitor-access.sqlite'), { readOnly: true });
  try {
    const stored = JSON.stringify(database.prepare('SELECT * FROM guest_links').all());
    assert.equal(stored.includes(created.token), false);
    assert.equal(stored.includes(created.token.slice(4)), false);
  } finally { database.close(); }
  for (const days of [1, 30]) assert.equal((await guestAccess.create({ projectId: PROJECT, days })).ok, true);
  assert.deepEqual(await guestAccess.create({ projectId: PROJECT, days: 365 }), { ok: false, code: 'days_invalid' });
  assert.deepEqual(await guestAccess.create({ projectId: 'project-unknown' }), { ok: false, code: 'project_unknown' });
});

test('the listener is absent without a live link and stops when the last one goes', async (t) => {
  const { guestAccess, started } = setup(t);
  await guestAccess.start();
  assert.equal(guestAccess.list({ projectId: PROJECT }).listening, false);
  assert.equal(started.length, 0);
  const { token, link, addresses: [authority] } = await guestAccess.create({ projectId: PROJECT });
  assert.equal((await call(authority, { token })).status, 200);
  assert.deepEqual(await guestAccess.revoke(link.id), { ok: true });
  assert.equal(guestAccess.list({ projectId: PROJECT }).listening, false);
  await assert.rejects(call(authority, { token }), { code: 'ECONNREFUSED' });
});

test('the card names the project and its lead without local paths, and how to ask, and is recorded', async (t) => {
  const { guestAccess, visitorAccess } = setup(t);
  const { token, link, addresses: [authority] } = await guestAccess.create({ projectId: PROJECT });
  const { status, body } = await call(authority, { token });
  assert.equal(status, 200);
  assert.equal(body.project.name, 'Synthetic guest project');
  assert.equal(body.assistant.name, 'Synthetic lead');
  assert.equal(body.assistant.responsibility.includes('/home/someone'), false);
  assert.equal(body.mode, 'ask_only');
  assert.equal(body.expiresAt, link.expiresAt);
  assert.deepEqual(body.actions.map(({ method, path }) => `${method} ${path}`), ['GET /guest/1/card', 'POST /guest/1/search']);
  assert.deepEqual(visitorAccess.recentReads({ requesterKey: `guest:${link.id}`, limit: 10 }).reads
    .map(({ action, outcome, projectId, requesterLabel }) => ({ action, outcome, projectId, requesterLabel })),
  [{ action: 'card', outcome: 'answered', projectId: PROJECT, requesterLabel: link.label }]);
  // 「最近被问」 names it as a guest link, by its label, never by its key.
  const shown = { setHeader() {}, writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
  await handleVisitorAccessRequest({ request: { method: 'GET', headers: { host: '127.0.0.1:2828' }, socket: { remoteAddress: '127.0.0.1' } },
    response: shown, url: new URL('http://127.0.0.1/api/visitor-access/reads'), visitorAccess });
  assert.deepEqual(shown.body.reads.map(({ requester, requesterKind }) => ({ requester, requesterKind })),
    [{ requester: link.label, requesterKind: 'guest' }]);
});

test('a card the project behind it cannot answer is refused in one word and recorded as refused', async (t) => {
  const { guestAccess, visitorAccess } = setup(t);
  const { link } = await guestAccess.create({ projectId: PROJECT });
  const host = fakeHost();
  host.getProject = async () => { throw new Error('gone'); };
  const routes = createGuestRoutes({ visitorAccess, host });
  t.after(() => routes.close());
  const response = { headers: {}, setHeader() {}, writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
  assert.equal(await routes.handle({ method: 'GET' }, response, { link, pathname: '/guest/1/card' }), true);
  assert.deepEqual({ status: response.status, body: response.body }, { status: 503, body: { error: 'unavailable' } });
  assert.deepEqual(visitorAccess.recentReads({ requesterKey: `guest:${link.id}`, limit: 10 }).reads
    .map(({ action, outcome, code }) => ({ action, outcome, code })), [{ action: 'card', outcome: 'refused', code: 'project_unavailable' }]);
});

test('a search reads only the link\'s project, through the narrowed visitor search, and is recorded', async (t) => {
  const { guestAccess, searches, visitorAccess } = setup(t);
  const { token, link, addresses: [authority] } = await guestAccess.create({ projectId: PROJECT });
  const answered = await call(authority, { method: 'POST', path: '/guest/1/search', token,
    body: { queries: ['deploy port'], projectId: 'project-other', personal_project_ids: ['project-other'] } });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.results[0].items[0].text.includes('/srv/synthetic'), false);
  assert.deepEqual(searches.map(({ personal_project_ids: ids, include_personal_global: global, inherit_project_knowledge: inherit,
    include_pending: pending }) => ({ ids, global, inherit, pending })), [{ ids: [PROJECT], global: false, inherit: false, pending: false }]);
  const refused = await call(authority, { method: 'POST', path: '/guest/1/search', token, body: { queries: ['a', 'b', 'c', 'd', 'e'] } });
  assert.deepEqual(refused, { status: 400, body: { error: 'too_many_queries' } });
  const rows = visitorAccess.recentReads({ requesterKey: `guest:${link.id}`, limit: 10 }).reads;
  assert.deepEqual(rows.map(({ outcome, code, projectId }) => ({ outcome, code, projectId })),
    [{ outcome: 'refused', code: 'too_many_queries', projectId: PROJECT }, { outcome: 'answered', code: null, projectId: PROJECT }]);
  assert.ok(guestAccess.list({ projectId: PROJECT }).links[0].lastUsedAt);
});

test('a wrong Host, an Origin or a source outside the private ranges is refused before the token', async (t) => {
  const { guestAccess } = setup(t);
  const { token, addresses: [authority] } = await guestAccess.create({ projectId: PROJECT });
  assert.equal((await call(authority, { token, host: `attacker.example:${authority.split(':')[1]}` })).status, 403);
  assert.equal((await call(authority, { token, headers: { origin: `http://${authority}` } })).status, 403);
  const outside = setup(t, { sourceAllowed: () => false });
  const other = await outside.guestAccess.create({ projectId: PROJECT });
  assert.deepEqual(await call(other.addresses[0], { token: other.token }), { status: 403, body: { error: 'forbidden' } });
});

test('missing, wrong, URL-borne, expired and revoked tokens get one answer', async (t) => {
  const { guestAccess, time } = setup(t);
  const kept = await guestAccess.create({ projectId: PROJECT, days: 30 });
  const short = await guestAccess.create({ projectId: PROJECT, days: 1 });
  const revoked = await guestAccess.create({ projectId: PROJECT });
  const authority = kept.addresses[0];
  await guestAccess.revoke(revoked.link.id);
  const unauthorized = { status: 401, body: { error: 'unauthorized' } };
  assert.deepEqual(await call(authority), unauthorized);
  assert.deepEqual(await call(authority, { token: `fgl_${'A'.repeat(43)}` }), unauthorized);
  assert.deepEqual(await call(authority, { path: `/guest/1/card?token=${kept.token}` }), unauthorized);
  assert.deepEqual(await call(authority, { token: revoked.token }), unauthorized);
  assert.equal((await call(authority, { token: short.token })).status, 200);
  time.advance(DAY_MS + 1);
  assert.deepEqual(await call(authority, { token: short.token }), unauthorized);
  assert.equal((await call(authority, { token: kept.token })).status, 200);
});

test('ten failed tokens from one address in ten minutes refuse even the right one', async (t) => {
  const listener = await startGuestListener({ addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    authenticate: (token) => (token === 'fgl_right' ? { ok: true, link: { id: 'link-1', projectId: PROJECT } } : { ok: false }),
    route: async (_request, response) => { response.writeHead(204).end(); return true; } });
  t.after(() => listener.close());
  const [authority] = listener.authorities;
  for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await call(authority, { token: 'fgl_wrong' })).status, 401);
  assert.deepEqual(await call(authority, { token: 'fgl_right' }), { status: 429, body: { error: 'too_many_attempts' } });
});

test('carrier-grade NAT addresses are guest sources and bind addresses, never console LAN addresses', () => {
  const interfaces = { vpn: [{ address: '100.101.7.9', family: 'IPv4', internal: false }],
    en0: [{ address: '192.168.31.8', family: 'IPv4', internal: false }, { address: '100.128.0.1', family: 'IPv4', internal: false }] };
  assert.deepEqual(discoverGuestAddresses(interfaces), ['100.101.7.9', '192.168.31.8']);
  assert.deepEqual(discoverLanAddresses(interfaces), ['192.168.31.8']);
  for (const address of ['100.64.0.1', '100.127.255.254', '::ffff:10.1.2.3', '172.16.0.4']) assert.equal(isGuestSourceAddress(address), true, address);
  for (const address of ['100.63.255.255', '100.128.0.1', '8.8.8.8', '127.0.0.1', '::1', undefined]) {
    assert.equal(isGuestSourceAddress(address), false, String(address));
  }
});

test('the guest entry never reaches the console\'s API router or server', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const modules = reachableModules(join(root, 'src/guest-access/runtime.js'));
  for (const consoleModule of ['src/http/api-router.js', 'src/server.js', 'src/http/guest-links-api-router.js']) {
    assert.equal(modules.has(join(root, consoleModule)), false, consoleModule);
  }
});

test('the console routes answer only on this computer; the token is returned once, at creation', async (t) => {
  const { guestAccess } = setup(t);
  const route = async ({ method, path, body, remoteAddress = '127.0.0.1' }) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const request = Object.assign((async function* stream() { yield* chunks; })(), { method, url: path, socket: { remoteAddress }, headers: {} });
    const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; },
      writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    assert.equal(await handleGuestLinksRequest({ request, response, url: new URL(path, 'http://127.0.0.1'), guestAccess }), true);
    return response;
  };
  assert.equal((await route({ method: 'POST', path: '/api/visitor-access/guest-links', body: { projectId: PROJECT },
    remoteAddress: '192.168.31.20' })).status, 403);
  const created = await route({ method: 'POST', path: '/api/visitor-access/guest-links', body: { projectId: PROJECT } });
  assert.equal(created.status, 201);
  assert.match(created.body.token, /^fgl_/);
  const listed = await route({ method: 'GET', path: `/api/visitor-access/guest-links?projectId=${PROJECT}` });
  assert.equal(JSON.stringify(listed.body).includes(created.body.token), false);
  assert.equal(JSON.stringify(listed.body).includes('tokenHash'), false);
  assert.equal(listed.body.links.length, 1);
  assert.equal((await route({ method: 'DELETE', path: `/api/visitor-access/guest-links/${created.body.link.id}` })).status, 200);
  assert.equal((await route({ method: 'DELETE', path: `/api/visitor-access/guest-links/${created.body.link.id}` })).status, 404);
});

async function connect(t, authority, token) {
  const client = new Client({ name: 'guest-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://${authority}/guest/1/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  t.after(() => client.close().catch(() => {}));
  return { client, transport };
}

test('MCP at /guest/1/mcp offers exactly the card and the scoped search, recorded like the JSON route', async (t) => {
  const { guestAccess, visitorAccess, searches } = setup(t);
  const { token, link, addresses: [authority] } = await guestAccess.create({ projectId: PROJECT });
  const { client } = await connect(t, authority, token);
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(), ['guest_card', 'search_project_knowledge']);
  const card = JSON.parse((await client.callTool({ name: 'guest_card', arguments: {} })).content[0].text);
  assert.equal(card.project.name, 'Synthetic guest project');
  const found = await client.callTool({ name: 'search_project_knowledge', arguments: { queries: ['deploy port'] } });
  assert.equal(found.isError, undefined);
  assert.equal(JSON.parse(found.content[0].text).results[0].items.length, 1);
  assert.deepEqual(searches.map(({ personal_project_ids: ids }) => ids), [[PROJECT]]);
  assert.equal(visitorAccess.recentReads({ requesterKey: `guest:${link.id}`, limit: 10 }).reads[0].outcome, 'answered');
  const stranger = new Client({ name: 'guest-test', version: '1.0.0' });
  await assert.rejects(stranger.connect(new StreamableHTTPClientTransport(new URL(`http://${authority}/guest/1/mcp`),
    { requestInit: { headers: { authorization: `Bearer fgl_${'B'.repeat(43)}` } } })));
});

test('revoking a link ends its open MCP sessions, and a session is never usable by another link', async (t) => {
  const { guestAccess } = setup(t);
  const kept = await guestAccess.create({ projectId: PROJECT });
  const revoked = await guestAccess.create({ projectId: PROJECT });
  const authority = kept.addresses[0];
  const keptSession = await connect(t, authority, kept.token);
  const revokedSession = await connect(t, authority, revoked.token);
  const borrowed = await call(authority, { method: 'POST', path: '/guest/1/mcp', token: kept.token,
    headers: { 'mcp-session-id': revokedSession.transport.sessionId, accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(borrowed.status, 404);
  await guestAccess.revoke(revoked.link.id);
  await assert.rejects(revokedSession.client.callTool({ name: 'guest_card', arguments: {} }));
  assert.equal((await keptSession.client.callTool({ name: 'guest_card', arguments: {} })).isError, undefined);
});

test('a link no longer kept loses its sessions even toward that link; a kept link keeps its own', async (t) => {
  const links = Object.fromEntries(['link-ended', 'link-kept'].map((id) => [`fgl_${id}`,
    { id, projectId: PROJECT, label: `guest-${id}`, expiresAt: '2026-11-08T00:00:00.000Z' }]));
  const visitorAccess = createVisitorAccess({ application: application([]) });
  const routes = createGuestRoutes({ visitorAccess, host: fakeHost() });
  const listener = await startGuestListener({ addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    authenticate: (token) => ({ ok: true, link: links[token] }), route: routes.handle });
  t.after(async () => { await routes.close(); await listener.close(); visitorAccess.close(); });
  const ended = await connect(t, listener.authorities[0], 'fgl_link-ended');
  const kept = await connect(t, listener.authorities[0], 'fgl_link-kept');
  assert.equal((await ended.client.callTool({ name: 'guest_card', arguments: {} })).isError, undefined);
  await routes.keepLinks(['link-kept']);
  await assert.rejects(ended.client.callTool({ name: 'guest_card', arguments: {} }), /404|session/i);
  assert.equal((await kept.client.callTool({ name: 'guest_card', arguments: {} })).isError, undefined);
});

test('when the listener notices a link expired, it ends that link\'s MCP sessions', async (t) => {
  const { guestAccess, time, keptLinks } = setup(t);
  const kept = await guestAccess.create({ projectId: PROJECT, days: 30 });
  const short = await guestAccess.create({ projectId: PROJECT, days: 1 });
  const { client } = await connect(t, kept.addresses[0], short.token);
  assert.equal((await client.callTool({ name: 'guest_card', arguments: {} })).isError, undefined);
  time.advance(DAY_MS + 1);
  await guestAccess.start();
  assert.deepEqual(keptLinks.at(-1), [kept.link.id]);
  await assert.rejects(client.callTool({ name: 'guest_card', arguments: {} }));
});
