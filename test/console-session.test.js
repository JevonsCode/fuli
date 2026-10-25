import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import test from 'node:test';

import { handleConsoleSessionRequest } from '../src/console-session/http.js';
import { createConsoleSession, CODE_TTL_MS } from '../src/console-session/session.js';
import { sessionBoundPorts } from '../src/console-session/session-ports.js';
import { consoleSignInUrl } from '../src/console-session/sign-in-link.js';
import { handleApiRequest } from '../src/http/api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { knowledgeOwnerReads } from '../src/knowledge-owner-reads/console-port.js';
import { createServer } from '../src/server.js';
import { closeServer } from '../test-support/server.js';

// rec#11 D-61: the console's human-review reads and changes serve only the
// browser session `fuli open` started with a one-time code. Synthetic codes,
// tokens, judgment records and Provider answers only; no real data directory.

const SIGN_IN_TOKEN = 'synthetic-human-review-token';
const SECRET = 'SYNTHETIC_PRIVATE_SUMMARY';

function clock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: ms => { current += ms; } };
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

test('codes and cookies are compared in constant time, every waiting code each time', t => {
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
  assert.equal(session.isValid(session.cookieValue()), true);
  assert.equal(compared.length, 1);
});

test('a cookie of an earlier launch is not a session of this one', () => {
  const earlier = createConsoleSession();
  const now = createConsoleSession();
  assert.equal(now.isValid(now.cookieValue()), true);
  assert.equal(now.isValid(earlier.cookieValue()), false);
  assert.equal(now.isValid(''), false);
  assert.equal(now.isValid(undefined), false);
});

// Raw requests, so a test sets Sec-Fetch-Site and Cookie itself.
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
        try { json = JSON.parse(text); } catch { /* a sign-in page answers in plain text */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function console_(t, options = {}) {
  const session = options.consoleSession ?? createConsoleSession();
  const runtime = await createServer({ port: 0, app: options.app ?? { config: { personal: { spaceId: 's' } } },
    consoleSession: session, readSignInToken: () => SIGN_IN_TOKEN, ...options });
  t.after(() => closeServer(runtime.server));
  const cookieName = `fuli_console_${new URL(runtime.url).port}`;
  return { ...runtime, session, cookieName };
}

async function signIn(server, headers = {}) {
  const code = server.session.issueCode('/');
  const answer = await call(`${server.url}/auth/console?code=${code}`, { headers: { 'sec-fetch-site': 'none', ...headers } });
  return answer.headers['set-cookie']?.[0]?.split(';')[0];
}

test('fuli open gets a code only with the data directory\'s token, and only for a console path', async t => {
  const server = await console_(t);
  const codes = `${server.url}/api/console-session/codes`;
  for (const headers of [{}, { 'x-fuli-console-sign-in': 'another-token' }]) {
    const refused = await call(codes, { method: 'POST', headers, body: {} });
    assert.deepEqual([refused.status, refused.json.code], [403, 'console_sign_in_refused'], 'no code is issued');
  }
  const token = { 'x-fuli-console-sign-in': SIGN_IN_TOKEN };
  for (const next of ['https://attacker.example/', '//attacker.example/x', '/\\attacker.example', 'http:/x',
    '/api/judgment/records', '/auth/console?code=x', 'knowledge', '/a\nb']) {
    const refused = await call(codes, { method: 'POST', headers: token, body: { next } });
    assert.equal(refused.status, 400, next);
    assert.match(refused.json.error, /next must be a console path/);
  }
  const issued = await call(codes, { method: 'POST', headers: token, body: { next: '/knowledge?item=s/entity:e1#top' } });
  assert.equal(issued.status, 200);
  assert.equal(issued.headers['cache-control'], 'no-store');
  assert.equal(issued.json.expiresInMs, CODE_TTL_MS);
  const landed = await call(`${server.url}/auth/console?code=${issued.json.code}`, { headers: { 'sec-fetch-site': 'none' } });
  assert.equal(landed.status, 303);
  assert.equal(landed.headers.location, '/knowledge?item=s/entity:e1#top');

  const unavailable = await console_(t, { readSignInToken: () => { throw new TypeError('no human-review channel'); } });
  const none = await call(`${unavailable.url}/api/console-session/codes`, { method: 'POST', headers: token, body: {} });
  assert.equal(none.status, 503);
});

test('fuli open\'s sign-in URL carries the code alone; the token goes in a header', async t => {
  const server = await console_(t);
  const requests = [];
  const fetchImpl = (url, init) => { requests.push({ url: String(url), init }); return fetch(url, init); };
  const signInUrl = await consoleSignInUrl({ consoleUrl: server.url, dataDir: 'synthetic-data-dir', next: '/inbox',
    readToken: () => SIGN_IN_TOKEN, fetchImpl });
  const url = new URL(signInUrl);
  assert.equal(url.pathname, '/auth/console');
  assert.deepEqual([...url.searchParams.keys()], ['code']);
  assert.equal(signInUrl.includes(SIGN_IN_TOKEN), false);
  assert.equal(requests[0].url.includes(SIGN_IN_TOKEN), false);
  assert.equal(requests[0].init.headers['x-fuli-console-sign-in'], SIGN_IN_TOKEN);
  const landed = await call(signInUrl, { headers: { 'sec-fetch-site': 'none' } });
  assert.deepEqual([landed.status, landed.headers.location], [303, '/inbox']);

  await assert.rejects(consoleSignInUrl({ consoleUrl: server.url, dataDir: 'synthetic-data-dir', readToken: () => 'another-token' }),
    /Only fuli open on this computer can sign in/);
});

test('a redeemed code answers 303 with an HttpOnly, SameSite=Strict, Path=/ cookie, no-store and no referrer', async t => {
  const output = [];
  for (const name of ['log', 'info', 'warn', 'error']) t.mock.method(console, name, (...args) => output.push(args.join(' ')));
  const server = await console_(t);
  const code = server.session.issueCode('/inbox');
  const answer = await call(`${server.url}/auth/console?code=${code}`, { headers: { 'sec-fetch-site': 'none' } });
  assert.equal(answer.status, 303);
  assert.equal(answer.headers.location, '/inbox');
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.equal(answer.headers['referrer-policy'], 'no-referrer');
  const [cookie] = answer.headers['set-cookie'];
  const [pair, ...attributes] = cookie.split(';').map(part => part.trim());
  assert.equal(pair, `${server.cookieName}=${server.session.cookieValue()}`);
  assert.deepEqual(attributes.sort(), ['HttpOnly', 'Path=/', 'SameSite=Strict']);
  assert.equal(cookie.includes(code), false, 'the cookie is not the code');

  const again = await call(`${server.url}/auth/console?code=${code}`, { headers: { 'sec-fetch-site': 'none' } });
  assert.equal(again.status, 401);
  assert.equal(again.headers['set-cookie'], undefined);
  assert.match(again.text, /fuli open/);
  assert.equal(output.some(line => line.includes(code) || line.includes(server.session.cookieValue())), false, 'never logged');
});

test('a code redeemed from another site, or another site on this computer, is refused and burned', async t => {
  const server = await console_(t);
  for (const site of ['cross-site', 'same-site']) {
    const code = server.session.issueCode('/');
    const navigation = { 'sec-fetch-site': site, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    const refused = await call(`${server.url}/auth/console?code=${code}`, { headers: navigation });
    assert.equal(refused.status, 403, site);
    assert.equal(refused.headers['set-cookie'], undefined, site);
    assert.equal(refused.headers['cache-control'], 'no-store');
    assert.match(refused.text, /another site/);
    const later = await call(`${server.url}/auth/console?code=${code}`, { headers: { 'sec-fetch-site': 'none' } });
    assert.equal(later.status, 401, `${site}: the code was burned`);
  }
  // A browser without Fetch Metadata, and a same-origin navigation, redeem as usual.
  for (const headers of [{}, { 'sec-fetch-site': 'same-origin' }]) {
    const code = server.session.issueCode('/');
    assert.equal((await call(`${server.url}/auth/console?code=${code}`, { headers })).status, 303);
  }
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

test('another device can neither ask for a code nor redeem one', async () => {
  const session = createConsoleSession();
  const code = session.issueCode('/');
  for (const incoming of [lanRequest('POST', '/api/console-session/codes', {}), lanRequest('GET', `/auth/console?code=${code}`)]) {
    const { sent, response } = recorder();
    assert.equal(await handleConsoleSessionRequest({ request: incoming, response, session, readSignInToken: () => SIGN_IN_TOKEN,
      authority: '127.0.0.1:4317' }), true);
    assert.deepEqual([sent.status, JSON.parse(sent.body).code], [403, 'local_user_only']);
  }
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
  const app = {
    config: { personal: { spaceId: 's' } },
    listPersonalProjects: async () => [{ project_id: 'p' }],
    modelBackends: {}, roleSuggestions: {}, readRoleSuggestions: async () => [],
    // The application passes the console's port on, as FederatedApplication does.
    getKnowledgeGraph: (input, ownerReads) => ownerReads.graph({ spaceId: 's', limit: 1 }),
    getWritingTasteProfile: (input, ownerReads) => ownerReads.graph({ spaceId: 's', limit: 1 }),
    listPreferenceConflicts: (input, ownerReads) => ownerReads.preferenceConflicts({ personalSpaceId: 's' }),
    deferPreferenceConflict: (input, ownerReads) => ownerReads.deferPreferenceConflict({}),
    completePreferenceConflict: (input, ownerReads) => ownerReads.completePreferenceConflict(input.conflictId, {}),
    listPersonalReviewQueue: (input, ownerReads) => ownerReads.publicationDrafts({ personalSpaceId: 's' }),
    reviewPersonalDraft: (input, ownerReads) => ownerReads.submissions.decidePublicationDraft('s', input.draftId, {})
  };
  const { judgment, record, runs } = judgmentWithAppliedReview(t, app);
  app.judgment = judgment;
  const ownerReads = ownerReadsPort();
  const hardDelete = recordingPort(['preview', 'confirm', 'status', 'reconcile']);
  const scope = recordingPort(['changeScope', 'applySessionMigration']);
  const tags = recordingPort(['send']);
  const undo = recordingPort(['withdrawAiReview'], { decision_id: 'decision-1' });
  const touched = () => [ownerReads.sent.length, hardDelete.calls.length, scope.calls.length, tags.calls.length, undo.calls.length,
    runs.length, judgment.store().get('s', record.id).feedback.revision, judgment.store().get('s', record.id).execution.status];
  return { app, record, touched, ports: { knowledgeOwnerReads: ownerReads.port, knowledgeHardDelete: hardDelete.port,
    knowledgeScope: scope.port, knowledgeTags: tags.port, judgmentUndo: undo.port } };
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
  ['POST', '/api/judgment/undo', id => ({ personalSpaceId: 's', decisionId: id })]
];

for (const [method, path, body] of PROTECTED_ROUTES) {
  test(`${method} ${path.split('?')[0]}: no cookie, a wrong cookie and an earlier launch's cookie get 401 and nothing; the session passes`, async t => {
    const { app, record, touched, ports } = protectedConsole(t);
    const server = await console_(t, { app, ...ports });
    const input = body?.(record.id);
    const before = touched();
    const earlier = createConsoleSession();
    for (const [label, cookie] of [['no cookie', null], ['wrong cookie', `${server.cookieName}=forged`],
      ['earlier launch', `${server.cookieName}=${earlier.cookieValue()}`], ['another port\'s cookie', `fuli_console_1=${server.session.cookieValue()}`]]) {
      const refused = await call(`${server.url}${path}`, { method, body: input, headers: cookie ? { cookie } : {} });
      assert.equal(refused.status, 401, label);
      assert.equal(refused.json.code, 'console_session_required', label);
      assert.match(refused.json.error, /fuli open/, label);
      assert.equal(refused.text.includes(SECRET), false, label);
      assert.deepEqual(touched(), before, `${label}: nothing was sent, read, run or written`);
    }
    const cookie = await signIn(server);
    const passed = await call(`${server.url}${path}`, { method, body: input, headers: { cookie: `other=1; ${cookie}` } });
    assert.equal(passed.status, 200, `${passed.status} ${passed.text}`);
    assert.notDeepEqual(touched(), before, 'the session reached the port');
  });
}

test('a signed-in request from another device is still refused for Tonborg\'s records (D-60)', async t => {
  const { app, ports } = protectedConsole(t);
  const { sent, response } = recorder();
  const reviewPorts = sessionBoundPorts({ knowledgeOwnerReads: ports.knowledgeOwnerReads }, true);
  try {
    await handleApiRequest({ request: lanRequest('GET', '/api/judgment/records?personalSpaceId=s'), response, app, ...reviewPorts });
  } catch (error) {
    const mapped = mapHttpError(error);
    sent.status = mapped.status;
    sent.body = JSON.stringify(mapped.body);
  }
  assert.deepEqual([sent.status, JSON.parse(sent.body).code], [403, 'local_user_only']);
});

test('reads that hold no protected history answer without a session', async t => {
  const app = { config: { personal: { spaceId: 's' } }, state: async () => ({ spaces: [] }),
    getCapturePolicy: () => ({ enabled: true }), getRecallPolicy: () => ({ enabled: true }),
    judgment: { pins: async () => ({ pins: [] }), policy: async () => ({ autonomy: 'suggest' }) } };
  const server = await console_(t, { app, knowledgeOwnerReads: ownerReadsPort().port });
  for (const path of ['/api/health', '/api/state', '/api/capture-policy', '/api/recall-policy', '/api/agent-pins?personalSpaceId=s',
    '/api/judgment/policy?personalSpaceId=s']) {
    assert.equal((await call(`${server.url}${path}`)).status, 200, path);
  }
});
