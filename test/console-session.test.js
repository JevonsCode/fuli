import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { handleConsoleSessionRequest, hasSignInToken } from '../src/console-session/http.js';
import { createSignInLaunchers, launcherParent } from '../src/console-session/launcher-file.js';
import { createConsoleSession, CODE_TTL_MS } from '../src/console-session/session.js';
import { sessionBoundPorts } from '../src/console-session/session-ports.js';
import { consoleSignInLauncher, isSignInLauncher } from '../src/console-session/sign-in-launcher.js';
import { handleApiRequest } from '../src/http/api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { knowledgeOwnerReads } from '../src/knowledge-owner-reads/console-port.js';
import { externalOpenInvocation } from '../src/local-runtime/console-browser.js';
import { createServer } from '../src/server.js';
import { closeServer } from '../test-support/server.js';

// rec#11 D-61: the console's protected reads and changes serve only the
// browser session `fuli open` started with a one-time code, carrying both its
// HttpOnly cookie and the session token the console page keeps in its
// origin's storage. Synthetic codes, tokens, judgment records and Provider
// answers only; launcher files go to a test temporary directory; no real data
// directory.

const SIGN_IN_TOKEN = 'synthetic-human-review-token';
const SECRET = 'SYNTHETIC_PRIVATE_SUMMARY';
const SESSION_HEADER = 'x-fuli-console-session';

function clock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: ms => { current += ms; } };
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'p61-console-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a code is issued for a landing path, redeemed once, and expires after its time', () => {
  const time = clock();
  const session = createConsoleSession({ now: time.now });
  const code = session.issueCode('/knowledge?item=s/entity:e1');
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(session.redeem(code), { next: '/knowledge?item=s/entity:e1' });
  assert.equal(session.redeem(code), null, 'a code is used once');

  const late = session.issueCode('/');
  time.advance(CODE_TTL_MS);
  assert.equal(session.redeem(late), null, 'an expired code is refused');

  const kept = session.issueCode('/');
  for (const wrong of [`${kept.slice(0, -1)}${kept.endsWith('A') ? 'B' : 'A'}`, kept.slice(0, 20), `${kept}x`, '', null, 42]) {
    assert.equal(session.redeem(wrong), null);
  }
  assert.deepEqual(session.redeem(kept), { next: '/' }, 'wrong guesses do not use up the real code');
});

test('codes and both credentials are compared in constant time, every waiting code each time', t => {
  const session = createConsoleSession();
  const codes = [session.issueCode('/'), session.issueCode('/a'), session.issueCode('/b')];
  const compared = [];
  const real = crypto.timingSafeEqual;
  t.mock.method(crypto, 'timingSafeEqual', (left, right) => { compared.push([left.length, right.length]); return real(left, right); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  assert.deepEqual(session.redeem(codes[0]), { next: '/' });
  assert.deepEqual(compared, [[32, 32], [32, 32], [32, 32]], 'all three codes, digests of equal length');
  compared.length = 0;
  assert.equal(session.redeem('not-a-code'), null);
  assert.deepEqual(compared, [[32, 32], [32, 32]]);
  compared.length = 0;
  const { cookie, token } = session.credentials();
  assert.equal(session.isSignedIn({ cookie, token: `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}` }), false);
  assert.equal(compared.length, 2, 'the cookie is compared even when the token decides');
});

test('a session needs both credentials of this launch; an earlier launch\'s count for nothing', () => {
  const earlier = createConsoleSession();
  const now = createConsoleSession();
  const current = now.credentials();
  assert.equal(now.isSignedIn(current), true);
  assert.notEqual(current.cookie, current.token);
  assert.equal(now.isSignedIn({ cookie: current.cookie }), false, 'the cookie alone');
  assert.equal(now.isSignedIn({ token: current.token }), false, 'the token alone');
  assert.equal(now.isSignedIn(earlier.credentials()), false, 'an earlier launch');
  assert.equal(now.isSignedIn({ cookie: current.cookie, token: earlier.credentials().token }), false, 'an earlier launch\'s token');
  assert.equal(now.isSignedIn({ cookie: '', token: '' }), false);
});

test('a landing path is a console path on this origin, checked again after normalizing', async t => {
  const server = await console_(t);
  const codes = `${server.url}/api/console-session/codes`;
  const token = { 'x-fuli-console-sign-in': SIGN_IN_TOKEN };
  for (const next of ['https://attacker.example/', '//attacker.example/x', '/\\attacker.example', 'http:/x', 'knowledge', '/a\nb',
    '/..//evil.example/', '/%2e%2e//evil.example', '/a/../..//evil.example', '/./%2E%2E//evil.example',
    '/api/judgment/records', '/auth/console', '/auth/console?code=x']) {
    const refused = await call(codes, { method: 'POST', headers: token, body: { next } });
    assert.equal(refused.status, 400, next);
    assert.match(refused.json.error, /next must be a console path/);
  }
  for (const [next, kept] of [['/knowledge?item=s/entity:e1#top', '/knowledge?item=s/entity:e1#top'], ['/a/../inbox', '/inbox'],
    ['/%2F%2Fevil', '/%2F%2Fevil']]) {
    const issued = await call(codes, { method: 'POST', headers: token, body: { next } });
    const answer = await redeemCode(server, launcherCode(issued.json.launcherPath));
    assert.equal(answer.json.next, kept, next);
  }
});

// Raw requests, so a test sets Origin, Sec-Fetch-Site and Cookie itself.
function call(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(url, { method,
      headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* a refusal page answers in plain text */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function console_(t, options = {}) {
  const session = options.consoleSession ?? createConsoleSession();
  // A synthetic data directory; its console-session folder holds the launchers.
  const dataDir = temporaryRoot(t);
  const root = launcherParent(dataDir);
  const runtime = await createServer({ port: 0, app: options.app ?? { config: { personal: { spaceId: 's' } } },
    consoleSession: session, signInLaunchers: createSignInLaunchers({ parent: () => root }),
    readSignInToken: () => SIGN_IN_TOKEN, ...options });
  t.after(() => closeServer(runtime.server));
  const cookieName = `fuli_console_${new URL(runtime.url).port}`;
  return { ...runtime, session, cookieName, root, dataDir };
}

function launcherCode(path) {
  return /#code=([A-Za-z0-9_-]+)/.exec(readFileSync(path, 'utf8'))[1];
}

// What the console's sign-in page sends: a same-origin POST.
function redeemCode(server, code, headers = { origin: server.url, 'sec-fetch-site': 'same-origin' }) {
  return call(`${server.url}/api/console-session/sign-in`, { method: 'POST', headers, body: { code } });
}

async function signIn(server) {
  const answer = await redeemCode(server, server.session.issueCode('/'));
  return { cookie: answer.headers['set-cookie'][0].split(';')[0], token: answer.json.token };
}

test('fuli open gets a sign-in only with the data directory\'s token; the code is only inside an owner-only file', async t => {
  const output = [];
  for (const name of ['log', 'info', 'warn', 'error']) t.mock.method(console, name, (...args) => output.push(args.join(' ')));
  const server = await console_(t);
  const codes = `${server.url}/api/console-session/codes`;
  for (const headers of [{}, { 'x-fuli-console-sign-in': 'another-token' }]) {
    const refused = await call(codes, { method: 'POST', headers, body: {} });
    assert.deepEqual([refused.status, refused.json.code], [403, 'console_sign_in_refused'], 'no sign-in is issued');
  }
  const issued = await call(codes, { method: 'POST', headers: { 'x-fuli-console-sign-in': SIGN_IN_TOKEN }, body: { next: '/inbox' } });
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  assert.equal(issued.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(issued.json).sort(), ['expiresInMs', 'launcherPath'], 'the answer holds no code');
  const { launcherPath } = issued.json;
  assert.equal(isSignInLauncher(launcherPath, server.root), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(launcherPath).mode & 0o777, 0o600, 'the file is the owner\'s alone');
    assert.equal(statSync(dirname(launcherPath)).mode & 0o777, 0o700, 'so is its directory');
  }
  const page = readFileSync(launcherPath, 'utf8');
  const code = launcherCode(launcherPath);
  assert.match(page, new RegExp(`location\\.replace\\("${server.url.replace(/[.]/g, '\\.')}/auth/console#code=${code}"\\)`));
  assert.match(page, /<meta name="referrer" content="no-referrer">/);

  const answer = await redeemCode(server, code);
  assert.equal(answer.status, 200);
  assert.equal(answer.json.next, '/inbox');
  assert.equal(existsSync(launcherPath), false, 'the file goes once its code is redeemed');
  const { cookie, token } = server.session.credentials();
  assert.equal(output.some(line => [code, cookie, token].some(secret => line.includes(secret))), false, 'never logged');

  const unavailable = await console_(t, { readSignInToken: () => { throw new TypeError('no human-review channel'); } });
  const none = await call(`${unavailable.url}/api/console-session/codes`, { method: 'POST',
    headers: { 'x-fuli-console-sign-in': SIGN_IN_TOKEN }, body: {} });
  assert.equal(none.status, 503);
});

test('fuli open opens the launcher file: its token goes in a header and no command line holds the code', async t => {
  const server = await console_(t);
  const requests = [];
  const fetchImpl = (url, init) => { requests.push({ url: String(url), init }); return fetch(url, init); };
  const launcher = await consoleSignInLauncher({ consoleUrl: server.url, dataDir: server.dataDir, next: '/inbox',
    readToken: () => SIGN_IN_TOKEN, fetchImpl });
  assert.equal(requests[0].url.includes(SIGN_IN_TOKEN), false);
  assert.equal(requests[0].init.headers['x-fuli-console-sign-in'], SIGN_IN_TOKEN);
  const code = launcherCode(launcher);
  for (const platform of ['win32', 'darwin', 'linux']) {
    const invocation = externalOpenInvocation(launcher, platform);
    assert.equal(invocation.args.at(-1), launcher, platform);
    assert.equal(JSON.stringify(invocation).includes(code), false, `${platform}: the code is not in argv`);
  }
  assert.equal(isSignInLauncher(launcher), true);
  assert.equal(isSignInLauncher(launcher, server.root), true);
  assert.equal(isSignInLauncher(launcher, launcherParent(join(server.dataDir, 'other'))), false, 'another data directory\'s is not');
  await assert.rejects(consoleSignInLauncher({ consoleUrl: server.url, dataDir: join(server.dataDir, 'other'),
    readToken: () => SIGN_IN_TOKEN }), /answered no sign-in file/);
  for (const path of [join(server.root, 'fuli-console-x', 'other.html'), join(server.root, 'elsewhere', basename(launcher)),
    join(server.root, 'fuli-console-x&calc', basename(launcher)), 'sign-in.html']) {
    assert.equal(isSignInLauncher(path, server.root), false, path);
  }
  await assert.rejects(consoleSignInLauncher({ consoleUrl: server.url, dataDir: server.dataDir, readToken: () => 'another-token' }),
    /Only fuli open on this computer can sign in/);
});

// What the console page's sign-in button sends: a same-origin POST.
function openSignedIn(server, body, headers = { origin: server.url, 'sec-fetch-site': 'same-origin' }) {
  return call(`${server.url}/api/console-session/open`, { method: 'POST', headers, body });
}

test('the console page signs in with a click: the console opens the launcher itself and answers neither code nor path', async t => {
  const opened = [];
  const server = await console_(t, { openSignInLauncher: async path => { opened.push(path); } });
  const answer = await openSignedIn(server, { next: '/agents/space/employee.bole' });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(answer.json).sort(), ['expiresInMs', 'status']);
  assert.equal(answer.json.status, 'opened');
  assert.equal(opened.length, 1);
  assert.equal(isSignInLauncher(opened[0], server.root), true, 'only an owner-only launcher is opened');
  assert.equal(answer.text.includes(launcherCode(opened[0])), false);
  assert.equal(answer.text.includes(opened[0]), false);
  assert.equal((await redeemCode(server, launcherCode(opened[0]))).json.next, '/agents/space/employee.bole');

  const refusedNext = await openSignedIn(server, { next: '//attacker.example/' });
  assert.equal(refusedNext.status, 400);
  assert.equal(opened.length, 1, 'a refused landing path opens nothing');
});

test('only the console\'s own page asks the console to open a sign-in', async t => {
  const opened = [];
  const server = await console_(t, { openSignInLauncher: async path => { opened.push(path); } });
  for (const [label, headers] of [['cross-site', { 'sec-fetch-site': 'cross-site', origin: 'https://attacker.example' }],
    ['another origin', { origin: 'http://127.0.0.1:47272' }],
    ['same-site, another port', { 'sec-fetch-site': 'same-site' }]]) {
    const refused = await openSignedIn(server, {}, headers);
    assert.equal(refused.status, 403, label);
  }
  assert.deepEqual(opened, []);
});

test('a click sign-in the console cannot open fails closed and leaves no usable code', async t => {
  const issued = [];
  const session = createConsoleSession();
  const issueCode = session.issueCode;
  session.issueCode = (next) => { const code = issueCode(next); issued.push(code); return code; };
  let launcher;
  const server = await console_(t, { consoleSession: session,
    openSignInLauncher: async path => { launcher = path; throw new Error('no desktop session'); } });
  const refused = await openSignedIn(server, {});
  assert.deepEqual([refused.status, refused.json.code], [503, 'console_sign_in_unavailable']);
  assert.equal(existsSync(launcher), false, 'its file is gone');
  assert.equal((await redeemCode(server, issued[0])).status, 401, 'its code is not usable');
});

test('a sign-in fails closed when its file cannot be made owner-only; fuli open says why', async t => {
  const root = temporaryRoot(t);
  const issued = [];
  const session = createConsoleSession();
  const issueCode = session.issueCode;
  session.issueCode = (next) => { const code = issueCode(next); issued.push(code); return code; };
  const server = await console_(t, { consoleSession: session,
    signInLaunchers: createSignInLaunchers({ parent: () => root, ownerOnly: () => { throw new Error('icacls failed'); } }) });
  const refused = await call(`${server.url}/api/console-session/codes`, { method: 'POST',
    headers: { 'x-fuli-console-sign-in': SIGN_IN_TOKEN }, body: {} });
  assert.deepEqual([refused.status, refused.json.code], [503, 'console_sign_in_unavailable']);
  assert.equal(refused.json.launcherPath, undefined);
  assert.deepEqual(readdirSync(root), [], 'nothing was written');
  assert.equal((await redeemCode(server, issued[0])).status, 401, 'the code it made is not usable');
  await assert.rejects(consoleSignInLauncher({ consoleUrl: server.url, dataDir: server.dataDir, readToken: () => SIGN_IN_TOKEN }),
    /Could not make the sign-in file private to this account/);
});

test('no request reads the data directory\'s token unless it names one', async t => {
  let reads = 0;
  const server = await console_(t, { readSignInToken: () => { reads += 1; return SIGN_IN_TOKEN; } });
  const { cookie, token } = await signIn(server);
  for (const [method, path, headers] of [['GET', '/'], ['GET', '/api/health'], ['GET', '/assets/missing.js'], ['GET', '/api/peer'],
    ['POST', '/api/peer/shares', {}], ['GET', '/api/state', { cookie, [SESSION_HEADER]: token }]]) {
    await call(`${server.url}${path}`, { method, headers, ...(method === 'POST' ? { body: {} } : {}) });
  }
  assert.equal(reads, 0);
  await call(`${server.url}/api/console-session/codes`, { method: 'POST', headers: { 'x-fuli-console-sign-in': SIGN_IN_TOKEN }, body: {} });
  assert.equal(reads, 1, 'a sign-in that names one reads it once');
});

test('the data directory\'s token stands in for the session only where it is asked for', () => {
  const signIn = { session: createConsoleSession(), readToken: () => SIGN_IN_TOKEN };
  const withHeader = (value) => ({ headers: value === undefined ? {} : { 'x-fuli-console-sign-in': value } });
  let reads = 0;
  assert.equal(hasSignInToken(withHeader(undefined), { ...signIn, readToken: () => { reads += 1; return SIGN_IN_TOKEN; } }), false);
  assert.equal(reads, 0, 'no header, no read');
  assert.equal(hasSignInToken(withHeader(SIGN_IN_TOKEN), signIn), true);
  for (const value of [undefined, '', 'another-token', `${SIGN_IN_TOKEN}x`]) assert.equal(hasSignInToken(withHeader(value), signIn), false);
  assert.equal(hasSignInToken(withHeader(SIGN_IN_TOKEN), { ...signIn, readToken: () => { throw new Error('no env'); } }), false);
});

test('a launcher file is deleted when its code expires, and the directory when the console stops', t => {
  const root = temporaryRoot(t);
  const timers = [];
  const launchers = createSignInLaunchers({ parent: () => root, setTimer: (run, ms) => { timers.push({ run, ms }); return {}; },
    clearTimer: () => {} });
  const expiring = launchers.write('synthetic-code-one', 'http://127.0.0.1:2727');
  const kept = launchers.write('synthetic-code-two', 'http://127.0.0.1:2727');
  assert.equal(timers[0].ms, CODE_TTL_MS);
  timers[0].run();
  assert.equal(existsSync(expiring), false);
  assert.equal(existsSync(kept), true);
  launchers.close();
  assert.equal(existsSync(dirname(kept)), false);
});

test('a redeemed code sets an HttpOnly, SameSite=Strict, Path=/ cookie and returns the session token, once', async t => {
  const server = await console_(t);
  const code = server.session.issueCode('/inbox');
  const answer = await redeemCode(server, code);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['cache-control'], 'no-store');
  const { cookie, token } = server.session.credentials();
  assert.deepEqual(answer.json, { next: '/inbox', token });
  const [setCookie] = answer.headers['set-cookie'];
  const [pair, ...attributes] = setCookie.split(';').map(part => part.trim());
  assert.equal(pair, `${server.cookieName}=${cookie}`);
  assert.deepEqual(attributes.sort(), ['HttpOnly', 'Path=/', 'SameSite=Strict']);

  const again = await redeemCode(server, code);
  assert.deepEqual([again.status, again.json.code], [401, 'console_sign_in_expired']);
  assert.equal(again.headers['set-cookie'], undefined);
});

test('only the console\'s own page redeems a code; any code in a URL is burned', async t => {
  const server = await console_(t);
  // Another site, another port of this host, or no page of the console at all.
  for (const [label, headers] of [['cross-site', { 'sec-fetch-site': 'cross-site', origin: 'https://attacker.example' }],
    ['another origin', { origin: 'http://127.0.0.1:47272' }],
    ['same-site, another port', { 'sec-fetch-site': 'same-site' }]]) {
    const code = server.session.issueCode('/');
    const refused = await redeemCode(server, code, headers);
    assert.equal(refused.status, 403, label);
    assert.equal(refused.headers['set-cookie'], undefined, label);
    assert.equal(refused.headers['access-control-allow-origin'], undefined, label);
  }
  const sameSite = server.session.issueCode('/');
  await redeemCode(server, sameSite, { 'sec-fetch-site': 'same-site' });
  assert.equal((await redeemCode(server, sameSite)).status, 401, 'a same-site attempt burned its code');

  // A code in a link or a subresource URL, from anywhere, is burned before the request policy answers.
  for (const headers of [{ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }, { 'sec-fetch-site': 'none' }]) {
    const code = server.session.issueCode('/');
    const linked = await call(`${server.url}/auth/console?code=${code}`, { headers });
    assert.ok([400, 403].includes(linked.status), JSON.stringify(headers));
    assert.equal(linked.headers['set-cookie'], undefined);
    assert.equal((await redeemCode(server, code)).status, 401, `${headers['sec-fetch-dest'] ?? 'none'}: burned`);
  }
  // The sign-in page itself is the static console, from anywhere.
  const page = await call(`${server.url}/auth/console`, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document' } });
  assert.notEqual(page.status, 403);
});

test('another origin\'s preflight gets no CORS permission for the session header', async t => {
  const server = await console_(t);
  const preflight = await call(`${server.url}/api/judgment/records`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:47272',
    'access-control-request-method': 'GET', 'access-control-request-headers': SESSION_HEADER } });
  assert.equal(preflight.status, 403);
  assert.equal(Object.keys(preflight.headers).some(name => name.startsWith('access-control-')), false);
});

function lanRequest(method, path, body = null) {
  return Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method, url: path,
    headers: { host: '192.168.1.5:4317', ...(body ? { 'content-type': 'application/json' } : {}) },
    socket: { remoteAddress: '192.168.1.20' } });
}

function recorder() {
  const sent = { headers: {} };
  return { sent, response: { setHeader(name, value) { sent.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) { sent.status = status; Object.assign(sent.headers, headers); },
    end(text) { sent.body = text; } } };
}

test('another device can neither ask for a sign-in nor redeem one', async t => {
  const session = createConsoleSession();
  const launchers = createSignInLaunchers({ parent: () => temporaryRoot(t) });
  const code = session.issueCode('/');
  const opened = [];
  for (const incoming of [lanRequest('POST', '/api/console-session/codes', {}), lanRequest('POST', '/api/console-session/sign-in', { code }),
    lanRequest('POST', '/api/console-session/open', {})]) {
    const { sent, response } = recorder();
    assert.equal(await handleConsoleSessionRequest({ request: incoming, response,
      signIn: { session, launchers, readToken: () => SIGN_IN_TOKEN, openLauncher: async path => { opened.push(path); } },
      authority: '127.0.0.1:4317' }), true);
    assert.deepEqual([sent.status, JSON.parse(sent.body).code], [403, 'local_user_only']);
  }
  assert.deepEqual(opened, [], 'nothing was opened for it');
  assert.deepEqual(session.redeem(code), { next: '/' }, 'the refused request did not redeem it');
});

// A synthetic Provider behind the real owner-read port: it answers every
// human-review read and records what was sent.
function ownerReadsPort() {
  const sent = [];
  const send = async (path) => {
    sent.push(path);
    return { ok: true, status: 200, payload: { nodes: [], edges: [], entries: [], unchanged_count: 0, turns: [], items: [],
      conflicts: [], drafts: [] } };
  };
  return { port: knowledgeOwnerReads('synthetic-data-dir', { send }), sent };
}

function recordingPort(names, answer = {}) {
  const calls = [];
  const port = Object.fromEntries(names.map(name => [name, async () => { calls.push(name); return answer; }]));
  return { port, calls };
}

// The real judgment service with a Tonborg review it applied, so the undo
// reaches its port; a refused request must not run, write or undo anything.
function judgmentWithAppliedReview(t, app) {
  const runs = [];
  const answer = name => async service => { runs.push(name); return { records: service.store().records('s'), remaining: null }; };
  const judgment = createJudgmentService({ app, engine: { review: answer('review'), assess: answer('assess'), accept: answer('accept') } });
  t.after(() => judgment.close());
  const store = judgment.store();
  const record = store.record('s', { personalProjectId: 'p', kind: 'review', target: 'entity:pref', title: 'Use tabs', summary: SECRET,
    evidence: [], confidence: 0.6, outcome: 'approve', aiReview: { state: 'ai_reviewed' } }, 'r1:entity:pref');
  store.execute('s', record.id, 'applying', { candidateKey: 'entity:pref', reviewId: 'review-1', aiReviewEvidenceToken: '0'.repeat(64) });
  store.execute('s', record.id, 'applied', { candidateKey: 'entity:pref', reviewId: 'review-1' });
  return { judgment, record, runs };
}

function protectedConsole(t) {
  const appCalls = [];
  const called = (name, value = {}) => async () => { appCalls.push(name); return value; };
  const app = {
    config: { personal: { spaceId: 's' } },
    listPersonalProjects: async () => [{ project_id: 'p' }],
    roleSuggestions: {}, readRoleSuggestions: async () => [],
    modelBackends: { roles: () => ({ roles: [], connections: {} }), localBuild: () => null, usage: () => ({}) },
    modelTrust: { setSuggestionsOnly: (...args) => { appCalls.push('trust'); return { history: null, args }; },
      acknowledgeWarning: () => ({ history: null }) },
    // The application passes the console's port on, as FederatedApplication does.
    getKnowledgeGraph: (input, ownerReads) => ownerReads.graph({ spaceId: 's', limit: 1 }),
    getWritingTasteProfile: (input, ownerReads) => ownerReads.graph({ spaceId: 's', limit: 1 }),
    listPreferenceConflicts: (input, ownerReads) => ownerReads.preferenceConflicts({ personalSpaceId: 's' }),
    deferPreferenceConflict: (input, ownerReads) => ownerReads.deferPreferenceConflict({}),
    completePreferenceConflict: (input, ownerReads) => ownerReads.completePreferenceConflict(input.conflictId, {}),
    listPersonalReviewQueue: (input, ownerReads) => ownerReads.publicationDrafts({ personalSpaceId: 's' }),
    reviewPersonalDraft: (input, ownerReads) => ownerReads.submissions.decidePublicationDraft('s', input.draftId, {}),
    // The owner's inspection, read with the application's own authority.
    queryAgentConversations: called('queryAgentConversations', { conversations: [] }),
    updateAgentConversationPolicy: called('updateAgentConversationPolicy'),
    inspectProjectAgentMemory: called('inspectProjectAgentMemory', { memory: [] }),
    exportInspectedProjectAgentMemory: called('exportInspectedProjectAgentMemory', { files: [] })
  };
  const { judgment, record, runs } = judgmentWithAppliedReview(t, app);
  app.judgment = judgment;
  const ownerReads = ownerReadsPort();
  const hardDelete = recordingPort(['preview', 'confirm', 'status', 'reconcile']);
  const scope = recordingPort(['changeScope', 'applySessionMigration']);
  const tags = recordingPort(['send']);
  const undo = recordingPort(['withdrawAiReview'], { decision_id: 'decision-1' });
  const migrations = recordingPort(['preview', 'apply', 'rollback']);
  migrations.port.prune = () => [];
  const roleSettings = recordingPort(['save'], { history: null });
  const touched = () => [ownerReads.sent.length, hardDelete.calls.length, scope.calls.length, tags.calls.length, undo.calls.length,
    migrations.calls.length, roleSettings.calls.length, appCalls.length, runs.length,
    judgment.store().get('s', record.id).feedback.revision, judgment.store().get('s', record.id).execution.status];
  return { app, record, touched, ports: { knowledgeOwnerReads: ownerReads.port, knowledgeHardDelete: hardDelete.port,
    knowledgeScope: scope.port, knowledgeTags: tags.port, judgmentUndo: undo.port, dataFormatMigrations: migrations.port,
    modelRoleSettings: roleSettings.port } };
}

const PROTECTED_ROUTES = [
  // Tonborg's records and suggestions, and the built-in Agents' suggestion log (rec#11 D-60).
  ['GET', '/api/judgment/records?personalSpaceId=s'],
  ['POST', '/api/judgment/feedback', id => ({ personalSpaceId: 's', decisionId: id, vote: 'up', reason: '', expectedRevision: 0 })],
  ['POST', '/api/judgment/review', () => ({ personalSpaceId: 's' })],
  ['POST', '/api/judgment/assess', () => ({ personalSpaceId: 's' })],
  ['POST', '/api/judgment/accept', () => ({ personalSpaceId: 's' })],
  ['GET', '/api/judgment/suggestions?personalSpaceId=s'],
  ['GET', '/api/model-backends/suggestions'],
  // The console's full knowledge reads (src/knowledge-owner-reads/console-port.js).
  ['GET', '/api/graph?spaceId=s'],
  ['GET', '/api/writing-taste-profile?personalSpaceId=s'],
  ['GET', '/api/preference-conflicts?personalSpaceId=s'],
  ['POST', '/api/preference-conflicts/defer', () => ({ personalSpaceId: 's', conflictId: 'c1' })],
  ['POST', '/api/preference-conflicts/c1/complete', () => ({ personalSpaceId: 's' })],
  ['GET', '/api/personal-review?personalSpaceId=s'],
  ['POST', '/api/personal-review/d1/decision', () => ({ decision: 'keep_personal' })],
  ['GET', '/api/knowledge/turn-receipt?personalSpaceId=s&episodes=e1'],
  ['GET', '/api/knowledge/entity/e1?personalSpaceId=s'],
  ['GET', '/api/knowledge/session-migration?personalSpaceId=s&client=codex&sessionId=session-1&projectId=p'],
  ['GET', '/api/session-records?personalSpaceId=s&sessionId=session-1'],
  // The person's other human-review ports: a permanent delete, where knowledge applies, tags, the undo.
  ['POST', '/api/knowledge/entity/e1/hard-delete/preview', () => ({ personalSpaceId: 's' })],
  ['POST', '/api/knowledge/entity/e1/scope', () => ({ personalSpaceId: 's', scope: 'global', expectedVersion: 0, reason: 'synthetic' })],
  ['GET', '/api/knowledge-tags/detail?personalSpaceId=s&tagId=t1'],
  ['POST', '/api/judgment/undo', id => ({ personalSpaceId: 's', decisionId: id })],
  // The owner's inspection of every client's conversations and of an Agent's private working memory.
  ['POST', '/api/agent-conversations/query', () => ({ personalSpaceId: 's', mode: 'events' })],
  ['PUT', '/api/agent-conversations/policy', () => ({ personalSpaceId: 's' })],
  ['GET', '/api/project-agents/agent-a/memory?personalSpaceId=s'],
  ['GET', '/api/project-agents/agent-a/memory/export?personalSpaceId=s'],
  // Writes that change real data or where a built-in Agent's model calls go.
  ['POST', '/api/data-format/apply', () => ({ digest: 'a'.repeat(64) })],
  ['POST', '/api/data-format/rollback', () => ({ label: 'synthetic-store', migrationId: 'm1' })],
  ['PUT', '/api/model-backends/roles/tonborg', () => ({ synthetic: true })],
  ['PUT', '/api/model-backends/roles/tonborg/trust', () => ({ expectedRevision: 0, suggestionsOnly: true })]
];

for (const [method, path, body] of PROTECTED_ROUTES) {
  test(`${method} ${path.split('?')[0]}: anything short of this launch's cookie and token gets 401 and nothing; the session passes`, async t => {
    const { app, record, touched, ports } = protectedConsole(t);
    const server = await console_(t, { app, ...ports });
    const input = body?.(record.id);
    const before = touched();
    const { cookie, token } = await signIn(server);
    const earlier = createConsoleSession().credentials();
    const cookieValue = cookie.split('=')[1];
    for (const [label, headers] of [
      ['nothing', {}],
      ['the cookie alone', { cookie }],
      ['the token alone', { [SESSION_HEADER]: token }],
      ['a wrong cookie', { cookie: `${server.cookieName}=forged`, [SESSION_HEADER]: token }],
      ['a wrong token', { cookie, [SESSION_HEADER]: 'forged' }],
      ['an earlier launch\'s token', { cookie, [SESSION_HEADER]: earlier.token }],
      ['an earlier launch\'s credentials', { cookie: `${server.cookieName}=${earlier.cookie}`, [SESSION_HEADER]: earlier.token }],
      ['another port\'s cookie name', { cookie: `fuli_console_1=${cookieValue}`, [SESSION_HEADER]: token }]]) {
      const refused = await call(`${server.url}${path}`, { method, body: input, headers });
      assert.equal(refused.status, 401, label);
      assert.equal(refused.json.code, 'console_session_required', label);
      assert.match(refused.json.error, /fuli open/, label);
      assert.equal(refused.text.includes(SECRET), false, label);
      assert.deepEqual(touched(), before, `${label}: nothing was sent, read, run or written`);
    }
    const passed = await call(`${server.url}${path}`, { method, body: input,
      headers: { cookie: `other=1; ${cookie}`, [SESSION_HEADER]: token } });
    assert.equal(passed.status, 200, `${passed.status} ${passed.text}`);
    assert.notDeepEqual(touched(), before, 'the session reached the port');
  });
}

test('a signed-in request from another device is still refused for Tonborg\'s records (D-60)', async t => {
  const { app, ports } = protectedConsole(t);
  const { sent, response } = recorder();
  const reviewPorts = sessionBoundPorts({ knowledgeOwnerReads: ports.knowledgeOwnerReads }, true);
  try {
    await handleApiRequest({ request: lanRequest('GET', '/api/judgment/records?personalSpaceId=s'), response, app, ...reviewPorts,
      consoleSignedIn: true });
  } catch (error) {
    const mapped = mapHttpError(error);
    sent.status = mapped.status;
    sent.body = JSON.stringify(mapped.body);
  }
  assert.deepEqual([sent.status, JSON.parse(sent.body).code], [403, 'local_user_only']);
});

test('reads that hold no protected history answer without a session', async t => {
  const { app, ports } = protectedConsole(t);
  Object.assign(app, { state: async () => ({ spaces: [] }), getCapturePolicy: () => ({ enabled: true }),
    getRecallPolicy: () => ({ enabled: true }) });
  app.judgment.pins = async () => ({ pins: [] });
  app.judgment.policy = async () => ({ autonomy: 'suggest' });
  const server = await console_(t, { app, ...ports });
  for (const path of ['/api/health', '/api/state', '/api/capture-policy', '/api/recall-policy', '/api/agent-pins?personalSpaceId=s',
    '/api/judgment/policy?personalSpaceId=s', '/api/model-backends/roles', '/api/data-format']) {
    assert.equal((await call(`${server.url}${path}`)).status, 200, path);
  }
});
