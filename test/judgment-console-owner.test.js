import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { handleApiRequest } from '../src/http/api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { rejectRequestOutsidePolicy } from '../src/http/request-policy.js';
import { handleJudgmentApiRequest } from '../src/judgment/http.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { handleModelBackendApiRequest } from '../src/model-backends/http.js';
import { reachableModules } from '../test-support/module-graph.js';
import { OWNER_PROOF_TOKEN, ownerProofPort } from '../test-support/owner-proof-port.js';

// rec#11 D-60: every console route that answers with Tonborg's full records,
// its suggestions or the built-in Agents' suggestion log is consistent with
// the console's other full reads. It answers only a loopback request, LAN code
// or not, and only after the console server confirmed its own human-review
// proof with the Provider. The server attaches that proof itself, so these
// tests do not show that a local HTTP caller is refused; that is rec#11 D-61.
// Synthetic judgment records, a synthetic Provider and synthetic model words only.

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SECRET = 'SYNTHETIC_PRIVATE_SUMMARY';
const LAN_AUTHORITY = '192.168.1.5:4317';
const LAN_CODE = 'synthetic-lan-code';
const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => [{ project_id: 'p' }] };
const suggested = { state: 'ai_suggested', modelOutcome: 'approve', interceptions: ['gate_not_passed'],
  gate: { status: 'not_passed', reason: 'not_configured', modelId: null } };

// The real service and store; Tonborg's runs answer with the stored record,
// as the engine answers with its records, and count that they ran.
function judgmentWithRecord(t) {
  const runs = [];
  const answer = name => async (service, input) => {
    runs.push([name, input]);
    return { records: service.store().records('s'), remaining: null };
  };
  const judgment = createJudgmentService({ app, engine: { review: answer('review'), assess: answer('assess'), accept: answer('accept') } });
  t.after(() => judgment.close());
  const record = judgment.store().record('s', { personalProjectId: 'p', kind: 'review', target: 'entity:pref', title: 'Use tabs',
    summary: SECRET, evidence: [`${SECRET} evidence`], confidence: 0.6, outcome: 'escalate', aiReview: suggested }, 'r1:entity:pref');
  return { judgment, record, runs };
}

const ROUTES = [
  ['GET', '/api/judgment/records?personalSpaceId=s', null, body => body.records[0].summary],
  ['POST', '/api/judgment/feedback', id => ({ personalSpaceId: 's', decisionId: id, vote: 'up', reason: '', expectedRevision: 0 }),
    body => body.summary],
  ['POST', '/api/judgment/review', () => ({ personalSpaceId: 's' }), body => body.records[0].summary],
  ['POST', '/api/judgment/assess', () => ({ personalSpaceId: 's' }), body => body.records[0].summary],
  ['POST', '/api/judgment/accept', () => ({ personalSpaceId: 's' }), body => body.records[0].summary],
  ['GET', '/api/judgment/suggestions?personalSpaceId=s', null, body => body.suggestions[0].summary],
];

function request(method, path, body, { remoteAddress = '127.0.0.1', headers = {} } = {}) {
  return Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method, url: path,
    headers: { host: '127.0.0.1:4317', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    socket: { remoteAddress } });
}

function recorder() {
  const sent = { headers: {} };
  return { sent, response: { setHeader(name, value) { sent.headers[name.toLowerCase()] = value; },
    writeHead(status) { sent.status = status; }, end(text) { sent.body = JSON.parse(text); } } };
}

async function handled(handle, response, sent) {
  try {
    await handle();
  } catch (error) {
    const mapped = mapHttpError(error);
    sent.status = mapped.status;
    sent.body = mapped.body;
  }
  return sent;
}

function callJudgment(judgment, incoming, ownerReads) {
  const { sent, response } = recorder();
  return handled(() => handleJudgmentApiRequest({ request: incoming, response, url: new URL(`http://127.0.0.1${incoming.url}`),
    app: { ...app, judgment }, ownerReads }), response, sent);
}

const REFUSALS = [
  ['no port', () => ({ port: null, sent: [] }), 'human_review_proof_required'],
  ['no token', () => ownerProofPort(null), 'human_review_proof_required'],
  ['wrong token', () => ownerProofPort('another-token'), null],
];

for (const [method, path, body, summaryOf] of ROUTES) {
  test(`${method} ${path.split('?')[0]}: no proof, a wrong proof and another device get 403 and nothing; the confirmed proof gets it in full`, async t => {
    const { judgment, record, runs } = judgmentWithRecord(t);
    const input = () => body?.(record.id) ?? null;
    for (const [label, makePort, code] of REFUSALS) {
      const proof = makePort();
      const refused = await callJudgment(judgment, request(method, path, input()), proof.port);
      assert.equal(refused.status, 403, label);
      if (code) assert.equal(refused.body.code, code, label);
      assert.equal(JSON.stringify(refused.body).match(/SYNTHETIC|Use tabs|entity:pref/), null, label);
      assert.equal(refused.headers['cache-control'], 'no-store', label);
    }
    const remote = ownerProofPort();
    const fromLan = await callJudgment(judgment, request(method, path, input(), { remoteAddress: '192.168.1.20' }), remote.port);
    assert.deepEqual([fromLan.status, fromLan.body.code], [403, 'local_user_only']);
    assert.equal(JSON.stringify(fromLan.body).includes(SECRET), false);
    assert.deepEqual(remote.sent, [], 'another device is refused before any proof is sent');
    // Nothing ran or was written for a refused request.
    assert.deepEqual(runs, []);
    assert.equal(judgment.store().get('s', record.id).feedback.revision, 0);

    const owner = ownerProofPort();
    const read = await callJudgment(judgment, request(method, path, input()), owner.port);
    assert.equal(read.status, 200);
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.equal(summaryOf(read.body), SECRET);
    assert.deepEqual(owner.sent.map(({ url, proof }) => [new URL(url).pathname, new URL(url).searchParams.get('limit'), proof]),
      [['/v1/spaces/s/graph', '1', OWNER_PROOF_TOKEN]]);
  });
}

test('a LAN device with a valid LAN code passes the request policy and is still refused with local_user_only', async t => {
  const { judgment, record } = judgmentWithRecord(t);
  const lanHeaders = { host: LAN_AUTHORITY, authorization: `Basic ${Buffer.from(`fuli:${LAN_CODE}`).toString('base64')}` };
  for (const [method, path, body] of [...ROUTES, ['GET', '/api/model-backends/suggestions', null]]) {
    const incoming = request(method, path, body?.(record.id) ?? null, { remoteAddress: '192.168.1.20', headers: lanHeaders });
    const { sent: policy, response: policyResponse } = recorder();
    assert.equal(rejectRequestOutsidePolicy({ request: incoming, response: policyResponse, authority: '127.0.0.1:4317',
      lanAuthorities: [LAN_AUTHORITY], lanAccessToken: LAN_CODE }), false, `${path}: the LAN code is valid`);
    assert.equal(policy.status, undefined);
    const owner = ownerProofPort();
    const refused = path.startsWith('/api/model-backends')
      ? await callSuggestionLog(incoming, owner.port, { list: () => assert.fail('a LAN read must not reach the log') })
      : await callJudgment(judgment, incoming, owner.port);
    assert.deepEqual([refused.status, refused.body.code], [403, 'local_user_only'], path);
    assert.equal(JSON.stringify(refused.body).includes(SECRET), false, path);
    assert.deepEqual(owner.sent, [], path);
  }
});

test('pins and policy hold no history and keep their protections; undo stays on its own human-review channel', async t => {
  const { judgment, record } = judgmentWithRecord(t);
  const noProof = { confirmOwner: () => assert.fail('pins and policy confirm no proof') };
  assert.equal((await callJudgment(judgment, request('GET', '/api/agent-pins?personalSpaceId=s'), noProof)).status, 200);
  const policy = await callJudgment(judgment, request('GET', '/api/judgment/policy?personalSpaceId=s'), noProof);
  assert.equal(policy.status, 200);
  assert.equal(JSON.stringify(policy.body).includes(SECRET), false);
  const undo = await callJudgment(judgment, request('POST', '/api/judgment/undo', { personalSpaceId: 's', decisionId: record.id },
    { remoteAddress: '192.168.1.20' }), noProof);
  assert.deepEqual([undo.status, undo.body.code], [403, 'local_user_only']);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const refused = await callJudgment({ scope: () => assert.fail('a write method must not read') }, request(method, '/api/judgment/suggestions?personalSpaceId=s'),
      ownerProofPort().port);
    assert.equal(refused.status, 405, method);
  }
});

function callSuggestionLog(incoming, ownerReads, log) {
  const { sent, response } = recorder();
  return handled(() => handleModelBackendApiRequest({ request: incoming, response, url: new URL(`http://127.0.0.1${incoming.url}`),
    modelBackends: { roles: () => ({}) }, readRoleSuggestions: input => log.list(input), ownerReads, personalSpaceId: 's' }), response, sent);
}

test('the built-in Agents\' suggestion log: no proof, a wrong proof and another device get 403 and nothing; the confirmed proof gets it', async () => {
  const rows = [{ role: 'jefa', status: 'suggested', suggestion: { reason: SECRET } }];
  const log = { reads: 0, list() { this.reads += 1; return rows; } };
  const path = '/api/model-backends/suggestions';
  for (const [label, makePort, code] of REFUSALS) {
    const refused = await callSuggestionLog(request('GET', path, null), makePort().port, log);
    assert.equal(refused.status, 403, label);
    if (code) assert.equal(refused.body.code, code, label);
    assert.equal(JSON.stringify(refused.body).includes(SECRET), false, label);
  }
  const remote = ownerProofPort();
  const fromLan = await callSuggestionLog(request('GET', path, null, { remoteAddress: '192.168.1.20' }), remote.port, log);
  assert.deepEqual([fromLan.status, fromLan.body.code], [403, 'local_user_only']);
  assert.deepEqual(remote.sent, []);
  assert.equal(log.reads, 0);
  const owner = ownerProofPort();
  const read = await callSuggestionLog(request('GET', path, null), owner.port, log);
  assert.equal(read.status, 200);
  assert.equal(read.body.suggestions[0].suggestion.reason, SECRET);
  assert.deepEqual(owner.sent.map(({ proof }) => proof), [OWNER_PROOF_TOKEN]);
});

test('the suggestion log\'s proof is confirmed under the graph runtime lease, which wakes an adaptive runtime', async () => {
  const leases = [];
  const system = { withGraphRuntimeLease: (label, run) => { leases.push(label); return run(); } };
  const owner = ownerProofPort();
  const shared = { ...app, modelBackends: { roles: () => ({}) }, roleSuggestions: {}, readRoleSuggestions: async () => [] };
  const { sent, response } = recorder();
  await handleApiRequest({ request: request('GET', '/api/model-backends/suggestions', null), response, app: shared, system,
    knowledgeOwnerReads: owner.port });
  assert.equal(sent.status, 200);
  assert.deepEqual(leases, ['http:GET:/api/model-backends/suggestions']);
  assert.deepEqual(owner.sent.map(({ proof }) => proof), [OWNER_PROOF_TOKEN]);
});

test('no MCP or Agent tool entry reaches the console\'s judgment routes, the suggestion log route or the proof check', () => {
  for (const module of ['src/judgment/http.js', 'src/model-backends/http.js', 'src/knowledge-owner-reads/owner-proof.js',
    'src/knowledge-owner-reads/console-port.js']) {
    for (const entry of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
      assert.equal(reachableModules(join(ROOT, entry)).has(join(ROOT, module)), false, `${entry} -> ${module}`);
    }
  }
});
