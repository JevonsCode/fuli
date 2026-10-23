import assert from 'node:assert/strict';
import test from 'node:test';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';
import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { submitPersonalDraft } from '../src/graphiti/public-submission.js';

const config = { version: 1, personal: { providerUrl: 'https://personal.example', accessToken: 'synthetic',
  principalId: 'person', spaceId: 'space' }, workspaces: [{ providerUrl: 'https://public.example',
  accessToken: 'synthetic', principalId: 'person' }] };

function fixture({ deleted = false, remoteError = null, sensitivity = 'normal' } = {}) {
  const calls = [];
  let status = deleted ? 'source_deleted' : 'pending';
  const app = new FederatedGraphApplication(config, { providerRequestTimeoutMs: 120_000,
    fetchImpl: () => { throw Error('unexpected network'); } });
  const draft = () => ({ id: 'draft', status, submission_id: 'attempt', submission_started_at: new Date().toISOString(),
    provider_url: 'https://public.example', target_project_id: 'project',
    source_identity: { idempotency_key: 'source' }, episode: { sensitivity, entities: [], relationships: [], idempotency_key: 'source' } });
  app.personal.getPublicationDraft = async () => { calls.push('get'); return draft(); };
  app.personal.decidePublicationDraft = async (space, id, input) => {
    calls.push(input);
    if (input.decision === 'begin_submit_public') {
      if (status !== 'pending') throw new ProviderRequestError('not pending', { status: 409 });
      status = 'submitting';
    } else {
      assert.equal(input.submission_id, 'attempt');
      if (input.decision === 'submit_public') status = 'submitted';
      if (input.decision === 'release_submit_public') status = 'pending';
      if (input.decision === 'mark_submission_unknown') status = 'submission_unknown';
    }
    return draft();
  };
  app.workspaces.values().next().value.client.createProposal = async (project, body, options) => {
    calls.push('remote');
    assert.equal(status, 'submitting', 'source delete must be blocked before remote send');
    assert.ok(options.timeoutMs < 120_000);
    assert.equal(body.episode.idempotency_key, 'source');
    if (remoteError) throw remoteError;
    return { id: 'proposal', status: 'pending' };
  };
  return { app, calls, status: () => status };
}

test('submission reserves before remote send and finishes the same attempt', async () => {
  const f = fixture();
  const result = await f.app.reviewPersonalDraft({ draftId: 'draft', decision: 'submit_public' });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(f.calls.map(call => typeof call === 'string' ? call : call.decision),
    ['begin_submit_public', 'remote', 'submit_public']);
  assert.equal(f.calls[2].shared_proposal_id, 'proposal');
});

test('a deleted source refuses begin before any remote body leaves', async () => {
  const f = fixture({ deleted: true });
  await assert.rejects(f.app.reviewPersonalDraft({ draftId: 'draft', decision: 'submit_public' }), { status: 409 });
  assert.ok(!f.calls.includes('remote'));
});

test('eligibility refusal releases the reservation without remote send', async () => {
  const f = fixture({ sensitivity: 'private' });
  await assert.rejects(f.app.reviewPersonalDraft({ draftId: 'draft', decision: 'submit_public' }), /Private or restricted/);
  assert.equal(f.status(), 'pending');
  assert.ok(!f.calls.includes('remote'));
  assert.equal(f.calls.at(-1).decision, 'release_submit_public');
});

test('an unsupported workspace releases its reservation before any remote request', async () => {
  const decisions = [];
  let status = 'pending';
  let remoteCalls = 0;
  const app = new FederatedGraphApplication({ ...config,
    workspaces: [{ ...config.workspaces[0], protocol: 'fuli-workspace-v1' }] }, {
    fetchImpl: async (url, options) => {
      if (new URL(url).origin !== config.personal.providerUrl) {
        remoteCalls++;
        throw new Error('unexpected remote request');
      }
      const input = JSON.parse(options.body);
      decisions.push(input.decision);
      status = { begin_submit_public: 'submitting', release_submit_public: 'pending',
        mark_submission_unknown: 'submission_unknown' }[input.decision];
      return Response.json({ id: 'draft', status, submission_id: 'attempt',
        submission_started_at: new Date().toISOString(), provider_url: 'https://public.example',
        target_project_id: 'project', episode: { sensitivity: 'normal', entities: [], relationships: [], idempotency_key: 'source' } });
    }
  });
  await assert.rejects(app.reviewPersonalDraft({ draftId: 'draft', decision: 'submit_public' }),
    /Operation is not supported by fuli-workspace-v1/);
  assert.equal(remoteCalls, 0);
  assert.equal(status, 'pending');
  assert.deepEqual(decisions, ['begin_submit_public', 'release_submit_public']);
});

test('definite remote 4xx releases once with a code, without retrying', async () => {
  const failure = new ProviderRequestError('private diagnostic must not persist', { status: 422, code: 'provider_error' });
  const f = fixture({ remoteError: failure });
  await assert.rejects(f.app.reviewPersonalDraft({ draftId: 'draft', decision: 'submit_public' }), error => error === failure);
  assert.equal(f.status(), 'pending');
  assert.equal(f.calls.filter(call => call === 'remote').length, 1);
  assert.equal(f.calls.at(-1).last_submission_error.code, 'provider_error');
  assert.ok(!JSON.stringify(f.calls).includes('private diagnostic'));
});

for (const status of [0, 408, 500, 504]) test(`uncertain remote ${status} immediately marks unknown`, async () => {
  const failure = new ProviderRequestError('unknown', { status });
  const f = fixture({ remoteError: failure });
  await assert.rejects(f.app.reviewPersonalDraft({ draftId: 'draft', decision: 'submit_public' }), error => error === failure);
  assert.equal(f.status(), 'submission_unknown');
  assert.equal(f.calls.filter(call => call === 'remote').length, 1);
});

function reconciliationFixture({ status = 'submission_unknown', age = 130_000, lookup = { id: 'proposal', status: 'pending' } } = {}) {
  const f = fixture();
  const draft = { id: 'draft', status, submission_id: 'attempt', submission_started_at: new Date(Date.now() - age).toISOString(),
    submission_outcome: status === 'source_deleted' ? 'unknown' : null,
    provider_url: 'https://public.example', target_project_id: 'project', episode: null,
    source_identity: { idempotency_key: 'source' } };
  f.app.personal.listPublicationDrafts = async (space, status, options) => {
    f.calls.push({ list: status });
    if (status === 'all') { assert.equal(options.metadataOnly, true); assert.ok(options.timeoutMs <= 5000); return [draft]; }
    return [];
  };
  f.app.workspaces.values().next().value.client.lookupProposal = async (project, key, options) => {
    f.calls.push('lookup'); assert.equal(key, 'source'); assert.ok(options.timeoutMs <= 5000);
    if (lookup instanceof Error) throw lookup;
    return lookup;
  };
  return f;
}

test('queue reconciles metadata before listing pending drafts without another proposal send', async () => {
  const f = reconciliationFixture();
  await f.app.listPersonalReviewQueue();
  assert.deepEqual(f.calls, [{ list: 'all' }, 'lookup',
    { decision: 'reconcile_submit_public', submission_id: 'attempt', lookup_result: { id: 'proposal', status: 'pending' } }, { list: 'pending' }]);
});

for (const status of ['submitting', 'submission_unknown', 'source_deleted']) test(`lookup can settle ${status} without its erased body`, async () => {
  const f = reconciliationFixture({ status });
  await f.app.reconcilePersonalSubmissions();
  assert.equal(f.calls.at(-1).decision, 'reconcile_submit_public');
  assert.ok(!f.calls.includes('remote'));
});

for (const lookup of [null, new Error('network')]) test(`recent unknown remains unknown when lookup is ${lookup ? 'unavailable' : 'empty'}`, async () => {
  const f = reconciliationFixture({ age: 1000, lookup });
  await f.app.reconcilePersonalSubmissions();
  assert.deepEqual(f.calls, [{ list: 'all' }, 'lookup', ...(lookup === null ? [{ decision: 'reconcile_submit_public',
    submission_id: 'attempt', lookup_result: null }] : [])]);
});

test('expired unknown with definite lookup absence is released for retry', async () => {
  const f = reconciliationFixture({ lookup: null });
  await f.app.reconcilePersonalSubmissions();
  assert.deepEqual(f.calls.at(-1), { decision: 'reconcile_submit_public', submission_id: 'attempt', lookup_result: null });
});

test('a deleted draft never becomes pending after an empty lookup', async () => {
  const f = reconciliationFixture({ status: 'source_deleted', lookup: null });
  await f.app.reconcilePersonalSubmissions();
  assert.deepEqual(f.calls, [{ list: 'all' }, 'lookup']);
});

test('reconciliation deadline returns without a late mutation from a signal-ignoring transport', async () => {
  const f = reconciliationFixture();
  let resolve;
  f.app.workspaces.values().next().value.client.lookupProposal = () => new Promise(done => { resolve = done; });
  const before = Date.now();
  await f.app.reconcilePersonalSubmissions({ timeoutMs: 15 });
  assert.ok(Date.now() - before < 500);
  resolve({ id: 'too-late', status: 'pending' });
  await new Promise(done => setImmediate(done));
  assert.deepEqual(f.calls, [{ list: 'all' }]);
});

test('internal reservation decisions are unavailable through the public Agent/application decision surface', async () => {
  const schema = listAgentTools().find(tool => tool.name === 'review_personal_draft').inputSchema;
  assert.deepEqual(schema.properties.decision.enum, ['submit_public', 'keep_personal', 'ignore']);
  const f = fixture();
  for (const decision of ['begin_submit_public', 'release_submit_public', 'mark_submission_unknown', 'reconcile_submit_public']) {
    await assert.rejects(f.app.reviewPersonalDraft({ draftId: 'draft', decision }), /Unknown personal draft decision/);
    await assert.rejects(callAgentTool(f.app, 'review_personal_draft', { draftId: 'draft', decision }), /Unknown personal draft decision/);
  }
  assert.deepEqual(f.calls, []);
});

test('a delayed begin response cannot start a new remote request beyond the reservation window', async () => {
  const f = fixture();
  const decide = f.app.personal.decidePublicationDraft;
  f.app.personal.decidePublicationDraft = async (...args) => {
    const draft = await decide(...args);
    return { ...draft, submission_started_at: new Date(Date.now() - 120_000).toISOString() };
  };
  await assert.rejects(f.app.reviewPersonalDraft({ draftId: 'draft', decision: 'submit_public' }),
    error => error.code === 'publication_submission_expired');
  assert.ok(!f.calls.includes('remote'));
});

test('a successful remote send followed by a lost local finish stays unknown and is never released', async () => {
  const f = fixture();
  const decide = f.app.personal.decidePublicationDraft;
  f.app.personal.decidePublicationDraft = async (...args) => {
    if (args[2].decision === 'submit_public') throw new ProviderRequestError('finish lost', { status: 504 });
    return decide(...args);
  };
  await assert.rejects(f.app.reviewPersonalDraft({ draftId: 'draft', decision: 'submit_public' }), { status: 504 });
  assert.equal(f.status(), 'submission_unknown');
  assert.ok(!f.calls.some(call => call.decision === 'release_submit_public'));
});

test('provider clock ahead cannot authorize a send after host suspension or a delayed begin response', async () => {
  for (const elapsed of [90_000, 120_001]) {
    const f = fixture();
    const decide = f.app.personal.decidePublicationDraft;
    f.app.personal.decidePublicationDraft = async (...args) => ({ ...await decide(...args),
      submission_started_at: new Date(Date.now() + 3_600_000).toISOString() });
    let ticks = 0;
    await assert.rejects(submitPersonalDraft({ personal: f.app.personal,
      workspaceFor: () => f.app.workspaces.values().next().value, spaceId: 'space', draftId: 'draft'
    }, { monotonicNow: () => ticks++ === 0 ? 100 : 100 + elapsed }),
    error => error.code === 'publication_submission_expired');
    assert.ok(!f.calls.includes('remote'));
    assert.equal(f.calls.at(-1).decision, 'release_submit_public');
  }
});
