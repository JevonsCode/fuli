import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OwnerOperationStore } from '../src/runner/owner-operation-store.js';
import { ownerProjectActions } from '../src/runner/owner-project-actions.js';
import { hostProjectActions } from '../src/runner/host-project-actions.js';

test('a lost result, changed input and stale revision never repeat a profile write', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-owner-action-'));
  const file = join(root, 'receipts.sqlite');
  let receipts = new OwnerOperationStore(file);
  t.after(() => { receipts.close(); rmSync(root, { recursive: true, force: true }); });
  let revision = '2026-01-01T00:00:00Z', attempts = 0, crash = false;
  const app = { personal: { getPersonalProject: async () => ({ updated_at: revision }) }, async upsertPersonalProject(input) {
    attempts++;
    if (input.expectedUpdatedAt !== revision) throw Object.assign(new Error(), { code: 'project_revision_changed' });
    assert.equal(input.projectId, 'sample');
    revision = '2026-01-02T00:00:00Z';
    if (crash) throw new Error();
    return { updated_at: revision };
  } };
  const make = () => ownerProjectActions({ receipts, authority: () => 'authority', withApplication: op => op(app) });
  const context = { owns: () => true };
  let dispatch = make();
  const job = { requestId: '1', spaceId: 'space', scope: 'project:sample', owner: 'owner', generation: 1, action: 'project_update',
    input: { profile: { name: 'Sample' }, writer: { kind: 'person' }, expectedUpdatedAt: revision } };
  const saved = await dispatch(job, context);
  assert.equal(saved.ok, true);
  receipts.close(); receipts = new OwnerOperationStore(file); dispatch = make();
  assert.deepEqual(await dispatch(job, context), saved);
  assert.equal(attempts, 1);
  assert.equal((await dispatch({ ...job, input: { ...job.input, profile: { name: 'Other' } } }, context)).code, 'operation_content_changed');
  assert.equal((await dispatch({ ...job, requestId: '2' }, context)).code, 'project_revision_changed');
  crash = true;
  const uncertain = { ...job, requestId: '3', input: { ...job.input, expectedUpdatedAt: revision } };
  assert.equal((await dispatch(uncertain, context)).code, 'owner_result_unknown');
  assert.equal((await dispatch(uncertain, context)).code, 'owner_result_unknown');
  assert.equal(attempts, 3);
  const query = { ...job, action: 'project_operation', input: { operationId: '1' } };
  assert.deepEqual(await dispatch(query, context), saved);
  assert.equal((await dispatch({ ...query, scope: 'project:other' }, context)).code, 'owner_operation_not_found');
});

test('the host declines transitive and unversioned updates before dispatch and labels uncertain delivery', async () => {
  const row = { state: 'owned', owner: 'remote', generation: 1, pairing: 'pair' };
  let calls = 0;
  const port = hostProjectActions({ spaceId: 'space', device: 'here', registry: () => ({ owner: () => row, remoteOwner: () => row }),
    request: async () => { calls++; return { ok: false, code: 'owner_result_unknown', dispatched: true }; } });
  const input = { project: 'sample', action: 'project_update', operationId: 'stable' };
  assert.equal((await port.call(input)).code, 'project_revision_required');
  assert.equal((await port.call({ ...input, relayed: true })).code, 'owner_request_refused');
  assert.equal(calls, 0);
  const result = await port.call({ ...input, input: { expectedUpdatedAt: '2026-01-01T00:00:00Z' } });
  assert.deepEqual(result, { ok: false, code: 'owner_result_unknown', dispatched: true, operationId: 'stable' });
});
