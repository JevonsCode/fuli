import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';
import { knowledgeHardDelete } from '../src/knowledge-hard-delete/console-port.js';
import { hardDeleteLedger } from '../src/knowledge-hard-delete/delete-ledger.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-submission-delete-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let status = 'pending', remoteCalls = 0;
  const reached = Promise.withResolvers(), response = Promise.withResolvers();
  const app = new FederatedGraphApplication({ version: 1,
    personal: { providerUrl: 'https://personal.example', accessToken: 'fixture', principalId: 'person', spaceId: 'space' },
    workspaces: [{ providerUrl: 'https://public.example', accessToken: 'fixture', principalId: 'person' }] },
  { fetchImpl: () => { throw new Error('No real network is allowed'); } });
  app.personal.decidePublicationDraft = async (_space, _id, decision) => {
    if (decision.decision === 'begin_submit_public') {
      if (status !== 'pending') throw new ProviderRequestError('not pending', { status: 409, code: 'publication_draft_not_pending' });
      status = 'submitting';
    } else if (decision.decision === 'submit_public') {
      assert.equal(decision.submission_id, 'attempt');
      status = 'submitted';
    } else throw new Error(`Unexpected decision ${decision.decision}`);
    return draft();
  };
  const draft = () => ({ id: 'draft', status, submission_id: 'attempt', submission_started_at: new Date().toISOString(),
    provider_url: 'https://public.example', target_project_id: 'project',
    episode: { sensitivity: 'normal', idempotency_key: 'source', entities: [], relationships: [] } });
  app.personal.getPublicationDraft = async () => draft();
  app.workspaces.values().next().value.client.createProposal = async () => {
    remoteCalls++;
    reached.resolve();
    await response.promise;
    return { id: 'proposal' };
  };
  const item = { personalSpaceId: 'space', itemKind: 'episode', itemId: 'source', include: [], exclude: [] };
  const port = knowledgeHardDelete(directory, { localStores: [], send: async (path, input) => {
    if (path.endsWith('/preview')) return { ok: true, status: 200, payload: {
      preview_id: status, item_kind: 'episode', item_id: 'source', source_application: 'codex', fuli_session_id: 'session',
      default_items: [], affected_items: [], removed_episodes: [{ episode_id: 'source' }],
      drafts: { pending: Number(status === 'pending'), submitted: Number(status === 'submitted'),
        submitting: Number(status === 'submitting'), unknown: 0 } } };
    assert.ok(path.endsWith('/hard-delete'));
    assert.ok(input.operation_id);
    if (status === 'submitting') return { ok: false, status: 409, payload: { detail: { code: 'hard_delete_draft_submitting' } } };
    status = status === 'pending' ? 'source_deleted' : status;
    return { ok: true, status: 200, payload: { deletion_id: 'deletion', item_kind: 'episode', item_id: 'source',
      source_application: 'codex', fuli_session_id: 'session', deleted_at: '2026-10-23T00:00:00Z', deleted_item_ids: ['source'] } };
  } });
  const confirm = async () => port.confirm({ ...item, previewId: (await port.preview(item)).preview_id, confirmation: '删除' });
  return { app, confirm, reached, response, status: () => status, remoteCalls: () => remoteCalls,
    operations: () => hardDeleteLedger(directory).all() };
}

test('a started public submission refuses concurrent console deletion, then finishes once', async t => {
  const f = fixture(t);
  const submitting = f.app.reviewPersonalDraft({ draftId: 'draft', decision: 'submit_public' });
  try {
    await f.reached.promise;
    await assert.rejects(f.confirm(), { status: 409, code: 'hard_delete_draft_submitting' });
    assert.equal(f.operations()[0].state, 'not_deleted');
    assert.equal(f.status(), 'submitting');
    assert.equal(f.remoteCalls(), 1);
  } finally { f.response.resolve(); }
  assert.equal((await submitting).status, 'submitted');
  assert.equal((await f.confirm()).outcome, 'complete');
  assert.equal(f.remoteCalls(), 1);
});

test('console deletion committed first prevents starting a public request with the source body', async t => {
  const f = fixture(t);
  assert.equal((await f.confirm()).outcome, 'complete');
  assert.equal(f.status(), 'source_deleted');
  await assert.rejects(f.app.reviewPersonalDraft({ draftId: 'draft', decision: 'submit_public' }),
    { status: 409, code: 'publication_draft_not_pending' });
  assert.equal(f.remoteCalls(), 0);
});
