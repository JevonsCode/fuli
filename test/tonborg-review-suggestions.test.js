import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { personalHumanReviewChannel } from '../src/graphiti/human-review-channel.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { handleJudgmentApiRequest } from '../src/judgment/http.js';
import { tonborgReviewSuggestions } from '../src/judgment/review-suggestions.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { knowledgeReferences } from '../src/knowledge-hard-delete/forget-references.js';
import { knowledgeOwnerReads } from '../src/knowledge-owner-reads/console-port.js';
import { reachableModules } from '../test-support/module-graph.js';

// rec#8: the console lists the knowledge review verdicts Tonborg left to the
// person (ai_suggested) beside Astro's, Bole's and Jefa's suggestions. It is
// an owner read: only the local console with its confirmed human-review proof
// gets it, in full. Synthetic judgment records and a synthetic Provider only.

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TOKEN = 'synthetic-human-review-token';
const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => [{ project_id: 'p' }] };
const gate = (reason = 'not_configured') => ({ status: 'not_passed', reason, modelId: null });
const review = (target, aiReview, extra = {}) => ({ personalProjectId: 'p', kind: 'review', target, title: `Item ${target}`,
  summary: `Tonborg on ${target}`, evidence: [`evidence for ${target}`], confidence: 0.6, outcome: 'escalate', aiReview,
  model: 'qwen-test', client: null, judgedBy: { mode: 'model_api', independent: true }, ...extra });
const suggested = (outcome = 'approve', interceptions = ['gate_not_passed']) =>
  ({ state: 'ai_suggested', modelOutcome: outcome, interceptions, gate: gate() });

function service(t, options = {}) {
  const judgment = createJudgmentService({ app, ...options });
  t.after(() => judgment.close());
  return judgment;
}

// The console's real port over the real channel, against a synthetic Provider
// that, like the graph provider, accepts only its own human-review token.
// envToken: what the data directory's provider env holds (null: none).
function ownerReads(envToken = TOKEN) {
  const sent = [];
  const files = { 'graph-runtime.json': JSON.stringify({ personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'agent-token' } }),
    'graph-provider.env': envToken ? `FULI_PERSONAL_HUMAN_REVIEW_TOKEN=${envToken}\n` : '' };
  const fetchImpl = async (url, { headers }) => {
    const proof = headers['x-fuli-human-review-token'];
    sent.push({ url, proof });
    const status = proof === TOKEN ? 200 : 403;
    return new Response(JSON.stringify(status === 200 ? { nodes: [], edges: [] } : { detail: 'independent human review proof required' }), { status });
  };
  const send = personalHumanReviewChannel('synthetic-data-dir', { fetchImpl, readText: path => files[path.split(/[\\/]/).pop()] });
  return { port: knowledgeOwnerReads('synthetic-data-dir', { send }), sent };
}

test('with the console\'s confirmed proof: only the verdicts left to the person, newest first, an older one for the same item as newer', async t => {
  const judgment = service(t);
  const store = judgment.store();
  const { port, sent } = ownerReads();
  store.record('s', review('entity:a', suggested()), 'r1:entity:a');
  store.record('s', review('entity:b', { ...suggested(), state: 'ai_reviewed', interceptions: [], gate: { status: 'passed', reason: null, modelId: 'qwen-test' } }), 'r1:entity:b');
  // Before rec#10 D-24 a review had no aiReview; routing and acceptance are not knowledge reviews.
  store.record('s', review('entity:c', undefined), 'r1:entity:c');
  store.record('s', { personalProjectId: 'p', kind: 'routing', target: 'task-1', outcome: 'recommend', summary: 'Route', evidence: [],
    aiReview: suggested() }, 'routing-1');
  store.record('s', review('entity:a', suggested('escalate', []), { summary: 'Newer look' }), 'r2:entity:a');
  store.record('s', review('relationship:d', suggested('approve', ['below_confidence', 'gate_not_passed']),
    { personalProjectId: null, model: null, client: 'claude_code', judgedBy: { mode: 'current_session', independent: false } }), 'r2:relationship:d');

  const listed = await tonborgReviewSuggestions({ judgment, ownerReads: port, input: { personalSpaceId: 's' } });
  assert.deepEqual(sent.map(({ url, proof }) => [new URL(url).pathname, new URL(url).searchParams.get('limit'), proof]),
    [['/v1/spaces/s/graph', '1', TOKEN]]);
  assert.deepEqual(listed.map(entry => [entry.target, entry.personalProjectId, entry.stale ?? null]),
    [['relationship:d', null, null], ['entity:a', 'p', null], ['entity:a', 'p', 'newer']]);
  assert.deepEqual(Object.keys(listed[1]).sort(), ['aiReview', 'client', 'confidence', 'createdAt', 'id', 'judgedBy', 'model',
    'personalProjectId', 'personalSpaceId', 'summary', 'target', 'title']);
  assert.equal(listed[1].summary, 'Newer look');
  assert.deepEqual(listed[0].aiReview.interceptions, ['below_confidence', 'gate_not_passed']);
  assert.deepEqual(listed[0].judgedBy, { mode: 'current_session', independent: false });
  // The same item in another project is another subject.
  store.record('s', review('entity:a', suggested(), { personalProjectId: null }), 'r3:entity:a');
  const again = await tonborgReviewSuggestions({ judgment, ownerReads: port, input: { personalSpaceId: 's' } });
  assert.deepEqual(again.slice(0, 3).map(entry => entry.stale ?? null), [null, null, null]);
});

test('an item made one FLA\'s own after the verdict: no proof and a wrong proof get nothing, the confirmed proof gets it in full', async t => {
  const judgment = service(t);
  judgment.store().record('s', review('entity:pref', suggested(), { title: 'Use tabs', summary: 'Quotes the private rule' }), 'r1:entity:pref');
  // The person then gives that preference to one FLA (scope agent). Nothing changes the local verdict.
  const refusedWith = async (ownerReadsPort, status, code) => {
    const error = await tonborgReviewSuggestions({ judgment, ownerReads: ownerReadsPort, input: { personalSpaceId: 's' } })
      .then(() => assert.fail('must be refused'), cause => cause);
    const mapped = mapHttpError(error);
    assert.equal(mapped.status, status);
    if (code) assert.equal(mapped.body.code, code);
    assert.equal(JSON.stringify(mapped.body).match(/Use tabs|private rule|entity:pref/), null);
  };
  await refusedWith(null, 403, 'human_review_proof_required');
  const missing = ownerReads(null);
  await refusedWith(missing.port, 403, 'human_review_proof_required');
  assert.deepEqual(missing.sent, []);
  const wrong = ownerReads('another-token');
  await refusedWith(wrong.port, 403);
  assert.equal(wrong.sent.length, 1);

  const [entry] = await tonborgReviewSuggestions({ judgment, ownerReads: ownerReads().port, input: { personalSpaceId: 's' } });
  assert.deepEqual([entry.target, entry.title, entry.summary], ['entity:pref', 'Use tabs', 'Quotes the private rule']);
});

test('a permanently deleted item keeps its place without any of its words', async t => {
  const judgment = service(t);
  judgment.store().record('s', review('entity:gone', suggested()), 'r1:entity:gone');
  judgment.store().forgetKnowledgeItems('s', knowledgeReferences({ candidateKeys: ['entity:gone'] }));
  const [entry] = await tonborgReviewSuggestions({ judgment, ownerReads: ownerReads().port, input: { personalSpaceId: 's' } });
  assert.equal(entry.hard_deleted, true);
  assert.equal(entry.title, null);
  assert.equal(entry.summary, null);
  assert.equal(JSON.stringify(entry).includes('Tonborg on'), false);
});

test('reads only the active space, and waits while a permanent delete is not confirmed', async t => {
  const judgment = service(t);
  const { port, sent } = ownerReads();
  await assert.rejects(tonborgReviewSuggestions({ judgment, ownerReads: port, input: { personalSpaceId: 'other' } }), { status: 403, code: 'scope_mismatch' });
  await assert.rejects(tonborgReviewSuggestions({ judgment, ownerReads: port, input: { personalSpaceId: 's', personalProjectId: 'p' } }), TypeError);
  await assert.rejects(tonborgReviewSuggestions({ judgment, ownerReads: port, input: {} }), TypeError);
  assert.deepEqual(sent, []);

  const dir = mkdtempSync(join(tmpdir(), 'fuli-tonborg-suggestions-'));
  let state = 'open';
  const fenced = service(t, { openStore: () => new JudgmentStore(join(dir, 'judgment.sqlite'), { recoveryGate: { state: () => ({ state }) } }) });
  // After hooks run in order: the store closes before its directory goes.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  fenced.store().record('s', review('entity:a', suggested()), 'r1:entity:a');
  state = 'pending';
  await assert.rejects(tonborgReviewSuggestions({ judgment: fenced, ownerReads: port, input: { personalSpaceId: 's' } }), { code: 'knowledge_recovery_pending' });
});

async function call(judgment, method, path, { remoteAddress = '127.0.0.1', ownerReads: port = null } = {}) {
  const sent = { headers: {} };
  const request = { method, headers: {}, socket: { remoteAddress } };
  const response = { setHeader(name, value) { sent.headers[name.toLowerCase()] = value; },
    writeHead(status) { sent.status = status; }, end(text) { sent.body = JSON.parse(text); } };
  try {
    await handleJudgmentApiRequest({ request, response, url: new URL(`http://127.0.0.1${path}`), app: { judgment }, ownerReads: port });
  } catch (error) {
    const mapped = mapHttpError(error);
    sent.status = mapped.status;
    sent.body = mapped.body;
  }
  return sent;
}

test('the console route: loopback GET only, not cached, refused without the proof; no Agent tool or MCP entry reaches it', async t => {
  const judgment = service(t);
  judgment.store().record('s', review('entity:a', suggested()), 'r1:entity:a');
  const path = '/api/judgment/suggestions?personalSpaceId=s';
  const read = await call(judgment, 'GET', path, { ownerReads: ownerReads().port });
  assert.equal(read.status, 200);
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.deepEqual(read.body.suggestions.map(entry => entry.target), ['entity:a']);

  for (const [label, options] of [['no port', {}], ['no token', { ownerReads: ownerReads(null).port }], ['wrong token', { ownerReads: ownerReads('another-token').port }]]) {
    const refused = await call(judgment, 'GET', path, options);
    assert.equal(refused.status, 403, label);
    assert.equal(refused.body.suggestions, undefined, label);
    assert.equal(JSON.stringify(refused.body).includes('entity:a'), false, label);
  }
  const remote = ownerReads();
  const fromLan = await call(judgment, 'GET', path, { remoteAddress: '192.168.1.20', ownerReads: remote.port });
  assert.deepEqual([fromLan.status, fromLan.body.code, fromLan.body.suggestions], [403, 'local_user_only', undefined]);
  assert.deepEqual(remote.sent, []);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const refused = await call({ scope: () => assert.fail('a write method must not read') }, method, path, { ownerReads: ownerReads().port });
    assert.equal(refused.status, 405, method);
  }
  const port = join(ROOT, 'src/judgment/review-suggestions.js');
  for (const entry of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    assert.equal(reachableModules(join(ROOT, entry)).has(port), false, entry);
  }
});
