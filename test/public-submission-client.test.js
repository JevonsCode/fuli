import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

test('submission lookup encodes the exact idempotency key and metadata list requests no bodies', async () => {
  const calls = [];
  const client = new GraphitiProviderClient({ baseUrl: 'https://synthetic.example', accessToken: 'synthetic',
    fetchImpl: async (url, options) => { calls.push({ url: new URL(url), options }); return Response.json(null); } });
  await client.lookupProposal('project/one', 'session/key?=a&b', { timeoutMs: 100 });
  await client.listPublicationDrafts('space', 'all', { metadataOnly: true, timeoutMs: 100 });
  assert.equal(calls[0].url.pathname, '/v1/projects/project%2Fone/proposals/lookup');
  assert.equal(calls[0].url.searchParams.get('idempotency_key'), 'session/key?=a&b');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[1].url.searchParams.get('metadata_only'), 'true');
  assert.equal(calls[1].url.searchParams.get('status'), 'all');
});

test('a publication send uses its strict timeout even when ingestion has a 120-second timeout', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const decisions = [];
  const app = new FederatedGraphApplication({ personal: { providerUrl: 'https://personal.example', accessToken: 'synthetic',
    principalId: 'p', spaceId: 'space' }, workspaces: [{ providerUrl: 'https://public.example', accessToken: 'synthetic' }] }, {
    providerRequestTimeoutMs: 120_000, fetchImpl: async (url, options) => {
      if (url.startsWith('https://personal.example')) {
        const decision = JSON.parse(options.body); decisions.push(decision.decision);
        return Response.json({ id: 'draft', status: 'submitting', submission_id: 'attempt',
          submission_started_at: new Date().toISOString(), provider_url: 'https://public.example', target_project_id: 'project',
          episode: { sensitivity: 'normal', idempotency_key: 'source', entities: [], relationships: [] } });
      }
      signal = options.signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  });
  const result = app.reviewPersonalDraft({ draftId: 'draft', decision: 'submit_public' });
  const rejection = assert.rejects(result, error => error.code === 'provider_timeout');
  while (!signal) await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(29_999);
  assert.equal(signal.aborted, false);
  context.mock.timers.tick(1);
  await rejection;
  assert.equal(signal.aborted, true);
  assert.equal(decisions.at(-1), 'mark_submission_unknown');
});
