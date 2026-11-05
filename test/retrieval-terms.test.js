// rec#92: retrieval terms for old knowledge. The self-test measures with real
// searches how many more items are found, the fill writes terms batch by
// batch, and nothing runs without a model or for a project not approved.
// Synthetic data and a fake model only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { advice, fillTerms, termsStats, trialTerms } from '../src/retrieval-terms/fill.js';
import { createTermsRunner } from '../src/retrieval-terms/runner.js';
import { termsReadiness } from '../src/retrieval-terms/terms-model.js';

const SPACE = 'space-synthetic';
const PROJECT = 'alpha';

// Item n is about "topic n"; a person asks for it as "how to n-thing".
function knowledge(count) {
  return Array.from({ length: count }, (_, index) => ({ item_kind: 'entity', item_id: `e-${index + 1}`,
    personal_project_id: PROJECT, title: `Topic ${index + 1}`, text: `Topic ${index + 1}\nDetails ${index + 1}`,
    has_terms: false, hash: String(index + 1).padStart(64, '0'), terms: null }));
}

function app({ model = true, allowed = true, approved = [PROJECT], items = knowledge(5), termsFail = false,
  failAfterBatches = Infinity } = {}) {
  const calls = { decide: [], written: [], searches: [] };
  let termBatches = 0;
  const application = {
    config: { personal: { spaceId: SPACE } },
    modelBackends: {
      roles: () => ({ roles: model ? [{ role: 'assistant', state: 'enabled' }] : [] }),
      operationSettings: (role, operation) => (model && allowed && role === 'assistant' && operation === 'retrieval_terms'
        ? { egress: { approvedProjects: approved.map(projectId => ({ personalSpaceId: SPACE, personalProjectId: projectId })) } }
        : null),
      decide: async (request) => {
        calls.decide.push(request);
        const asksQuestions = request.instructions.includes('one question');
        if (!asksQuestions && (termsFail || termBatches++ >= failAfterBatches)) {
          return { envelope: null, modelReceipt: { reason: 'network', usage: { totalTokens: 0 } } };
        }
        const rows = request.evidence.map((item) => {
          const number = item.text.match(/Topic (\d+)/)[1];
          return asksQuestions
            ? { id: item.id, question: `how to ${number}-thing` }
            : { id: item.id, terms: [`${number}-thing`, ` ${number}-thing `, `alias ${number}`], context: `Explains topic ${number}` };
        });
        return { envelope: { decision: 'propose', payload: { items: rows } },
          modelReceipt: { status: 'completed', usage: { totalTokens: 100 * request.evidence.length } } };
      }
    },
    personal: {
      retrievalStats: async () => ({ items: items.length, with_terms: items.filter(item => item.terms).length,
        chars: 400, missing_chars: 300 }),
      retrievalCandidates: async ({ limit, after, missingOnly }) => {
        const start = after ? items.findIndex(item => `entity:${item.item_id}` === after) + 1 : 0;
        const rows = items.slice(start).filter(item => !missingOnly || !item.terms);
        const page = rows.slice(0, limit).map(({ terms, ...row }) => row);
        return { items: page, next: rows.length > limit ? `entity:${page.at(-1).item_id}` : null };
      },
      writeRetrievalTerms: async ({ items: written }) => {
        calls.written.push(written);
        for (const row of written) items.find(item => item.item_id === row.item_id).terms = row.terms;
        return { written: written.length, skipped: [] };
      },
      // Words only: an item is found when its text or terms contain a word of the query.
      search: async (body) => {
        calls.searches.push(body);
        const words = body.query.split(' ');
        const hits = items.filter(item => words.some(word => `${item.text} ${(item.terms ?? []).join(' ')}`.includes(word)
          && word.length > 3));
        return { entities: hits.slice(0, body.limit).map(item => ({ id: item.item_id })), facts: [] };
      }
    }
  };
  return { application, calls, items };
}

test('without a model or an approved project nothing is read or sent', async () => {
  const off = app({ model: false });
  assert.equal(termsReadiness(off.application, PROJECT), 'needs_model');
  assert.deepEqual(await trialTerms(off.application, { personalProjectId: PROJECT }), { status: 'needs_model' });
  assert.equal(termsReadiness(app({ allowed: false }).application, PROJECT), 'not_allowed');
  const other = app({ approved: ['beta'] });
  assert.equal(termsReadiness(other.application, PROJECT), 'project_not_approved');
  assert.equal((await fillTerms(other.application, { personalProjectId: PROJECT })).status, 'superseded');
  assert.deepEqual([...off.calls.decide, ...other.calls.decide], []);
});

test('counting what lacks terms costs no model call and gives a rough estimate', async () => {
  const { application, calls } = app();
  const stats = await termsStats(application, PROJECT);
  assert.deepEqual(stats, { items: 5, with_terms: 0, chars: 400, missing_chars: 300, missing: 5, roughTokens: 550 });
  assert.deepEqual(calls.decide, []);
});

test('the self-test measures found items before and after, writes the sample and projects the cost', async () => {
  const { application, calls, items } = app({ items: knowledge(30) });
  const result = await trialTerms(application, { personalProjectId: PROJECT, now: () => new Date('2026-11-06T00:00:00Z') });
  assert.equal(result.status, 'tested');
  assert.equal(result.sample, 20);
  assert.equal(result.before, 0, 'the questions use other words than the items');
  assert.equal(result.after, 20);
  assert.equal(result.written, 20);
  assert.equal(result.remaining, 10);
  assert.deepEqual(result.tokens, { trial: 4000, perItem: 100, projected: 1000 });
  assert.equal(result.advice, 'fill');
  // Questions first, then terms; every search stays in the project.
  assert.ok(calls.decide[0].instructions.includes('one question'));
  assert.ok(calls.decide.every(request => request.scope.personalProjectId === PROJECT && request.evidence.length === 20));
  assert.ok(calls.searches.every(body => body.personal_project_ids[0] === PROJECT && body.limit === 5));
  // Terms are trimmed and de-duplicated, with the hash the item was listed with.
  assert.deepEqual(calls.written[0][0], { item_kind: 'entity', item_id: 'e-1', hash: items[0].hash,
    terms: ['1-thing', 'alias 1'], context: 'Explains topic 1' });
});

test('the fill writes every missing item batch by batch and stops when the model fails', async () => {
  const done = app({ items: knowledge(40) });
  const progress = [];
  const result = await fillTerms(done.application, { personalProjectId: PROJECT, onProgress: counts => progress.push(counts.written) });
  assert.deepEqual(result, { status: 'done', written: 40, skipped: 0, tokens: 4000 });
  assert.deepEqual(progress, [16, 32, 40]);
  assert.ok(done.items.every(item => item.terms));

  const failing = app({ items: knowledge(40), failAfterBatches: 1 });
  const stopped = await fillTerms(failing.application, { personalProjectId: PROJECT });
  assert.equal(stopped.status, 'model_failed');
  assert.equal(stopped.reason, 'network');
  assert.equal(stopped.written, 16);
});

test('advice follows the measured gain', () => {
  assert.equal(advice(0.95, 1), 'not_needed');
  assert.equal(advice(0.4, 0.7), 'fill');
  assert.equal(advice(0.4, 0.45), 'optional');
  assert.equal(advice(0.4, 0.4), 'not_worth');
});

test('the runner runs one job at a time, keeps the last self-test and stops a fill', async () => {
  const { application } = app({ items: knowledge(40) });
  const runner = createTermsRunner({ app: application });
  const trial = await runner.trial(PROJECT);
  assert.equal(trial.status, 'tested');
  const run = runner.fill(PROJECT);
  assert.equal(run.status, 'running');
  assert.equal(runner.fill(PROJECT).status, 'busy');
  assert.equal((await runner.trial(PROJECT)).status, 'busy');
  await runner.stop();
  const status = await runner.status(PROJECT);
  assert.equal(status.trial.status, 'tested');
  assert.ok(['stopped', 'done'].includes(status.run.status));
  assert.equal(status.busy, null);
});

function fakeExchange(method, path, body = null, address = '127.0.0.1') {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const request = { method, url: path, socket: { remoteAddress: address }, headers: {},
    async *[Symbol.asyncIterator]() { yield* chunks; } };
  const response = { headers: {}, status: null, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); } };
  return { request, response, url: new URL(path, 'http://127.0.0.1') };
}

test('the console routes run only on this computer and start a fill only when ready', async () => {
  const { handleRetrievalTermsRequest } = await import('../src/http/retrieval-terms-api-router.js');
  const { application } = app({ items: knowledge(3) });
  const runner = createTermsRunner({ app: application });
  const call = async (method, path, body, address) => {
    const exchange = fakeExchange(method, path, body, address);
    assert.equal(await handleRetrievalTermsRequest({ ...exchange, app: application, runner }), true);
    return exchange.response;
  };
  assert.equal((await call('POST', '/api/retrieval-terms/fill', { personalProjectId: PROJECT }, '192.0.2.8')).status, 403);
  const state = await call('GET', `/api/retrieval-terms?projectId=${PROJECT}`);
  assert.equal(state.status, 200);
  assert.equal(state.body.readiness, 'ready');
  assert.equal(state.body.stats.missing, 3);
  assert.equal((await call('POST', '/api/retrieval-terms/fill', { personalProjectId: 'beta' })).status, 409);
  const started = await call('POST', '/api/retrieval-terms/fill', { personalProjectId: PROJECT });
  assert.equal(started.status, 202);
  await runner.stop();
  assert.equal((await call('POST', '/api/retrieval-terms/stop')).body.stopped, true);
  assert.equal(await handleRetrievalTermsRequest({ ...fakeExchange('GET', '/api/other'), app: application, runner }), false);
});
