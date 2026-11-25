import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hostProjectActions } from '../src/runner/host-project-actions.js';
import { projectCopyStatus, projectCopySync } from '../src/runner/project-copy-sync.js';

test('an unchanged source also needs matching local content, owner, and zero dangling references', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-copy-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const spaceId = 'space', project = 'sample', scope = 'project:sample';
  const record = { project, owner: 'a'.repeat(64), generation: 1, state: 'owned', pairing: 'pair' };
  const digest = 'd'.repeat(64), contentDigest = 'c'.repeat(64);
  const bytes = Buffer.from('{"precise":12345678901234567890,"value":"样本"}');
  const rawDigest = createHash('sha256').update(bytes).digest('hex');
  let refusedStatus = 0, chunks = 0;
  let imports = 0, dangling = 0, offline = false, holds = 0, applied, lease = null;
  let summary = { scope, owners: [record.owner], contentDigest };
  const sync = projectCopySync({ dataDir, spaceId, ownership: () => record, hold: () => { holds++; return () => { holds--; }; },
    withLease: async (owner, work) => { lease = owner; try { return await work(); } finally { lease = null; } },
    request: async job => {
      assert.equal(job.generation, 1);
      if (offline) return { ok: false, code: 'owner_offline' };
      if (job.action === 'export_digest') return { ok: true, result: { ok: true, digest, rawDigest, bytes: bytes.length } };
      chunks++;
      return { ok: true, result: { ok: true, offset: 0, rawDigest, data: bytes.toString('base64') } };
    }, personal: {
      verifyProjectExport: async ({ envelope }) => {
        assert.equal(lease, 'runner-project-copy-import');
        assert.equal(holds, 1);
        assert.equal(envelope, bytes.toString());
        return { project, digest, spaceId };
      },
      importScope: async input => {
        assert.equal(holds, 1);
        assert.equal(input.generation, 1);
        assert.equal(input.pairing, 'pair');
        if (refusedStatus) throw Object.assign(new Error(), { status: refusedStatus });
        imports++;
        applied = input.envelope;
        return { digest, contentDigest, scope, owner: record.owner, dangling: { count: dangling } };
      },
      replicaSummary: async () => { assert.equal(lease, 'runner-project-copy-check'); return summary; }
    } });
  assert.equal((await sync(project)).outcome, 'synced');
  assert.equal((await sync(project)).outcome, 'synced');
  assert.equal(imports, 1);
  summary = { ...summary, owners: [] };
  dangling = 1;
  assert.equal((await sync(project)).outcome, 'references_pending');
  summary = { ...summary, owners: [record.owner] };
  dangling = 0;
  assert.equal((await sync(project)).outcome, 'synced');
  assert.equal(imports, 3);
  assert.equal(applied, bytes.toString());
  offline = true;
  const old = projectCopyStatus(dataDir, spaceId, record).read();
  const asleep = await sync(project);
  assert.equal(asleep.outcome, 'offline');
  assert.equal(asleep.syncedAt, old.syncedAt);
  assert.equal(asleep.contentDigest, old.contentDigest);
  assert.equal(holds, 0);
  assert.equal(projectCopyStatus(dataDir, spaceId, { ...record, generation: 2 }).read(), null);
  assert.equal(projectCopyStatus(dataDir, spaceId, { ...record, pairing: 'new-pair' }).read(), null);
  const status = projectCopyStatus(dataDir, spaceId, record);
  const view = hostProjectActions({ dataDir, spaceId, device: 'host', registry: () => ({ remoteOwner: () => record }) });
  assert.equal(view.source(project).readable, true);
  // A previous process exited after the Provider accepted an import and before it recorded the receipt.
  status.write(old, { outcome: 'importing' });
  assert.equal(view.source(project).readable, false);
  assert.equal((await sync(project)).outcome, 'offline');
  assert.equal(view.source(project).readable, false);
  offline = false;
  assert.equal((await sync(project)).outcome, 'synced');
  assert.equal(imports, 4);
  assert.equal(view.source(project).readable, true);
  status.write(status.read(), { outcome: 'unverified_import' });
  offline = true;
  assert.equal((await sync(project)).outcome, 'offline');
  assert.equal(view.source(project).readable, false);
  offline = false;
  summary = { ...summary, owners: [] };
  for (const status of [413, 422]) {
    refusedStatus = status;
    const state = projectCopyStatus(dataDir, spaceId, record);
    state.write(state.read(), { outcome: 'verification_due' });
    assert.equal((await sync(project)).outcome, 'refused');
    const count = chunks;
    assert.equal((await sync(project)).blockedDigest, digest);
    assert.equal(chunks, count);
  }

});

test('search labels copied items by their actual marker and suppresses revoked or unverified bytes', async () => {
  const { labelProjectCopyResults } = await import('../src/runner/project-copy-reads.js');
  const ranked = { entities: [{ id: 'local', scope: 'personal' }, { id: 'received', scope: 'personal' }], facts: [] };
  const info = { readable: true, owner: 'remote', generation: 2, checkedAt: '2026-01-01' };
  const app = { runnerHost: { projectSource: () => info }, personal: {
    projectCopySources: async () => [{ kind: 'entities', id: 'received', owner: 'remote', scopes: ['project:sample'] }]
  } };
  const result = await labelProjectCopyResults(app, 'space', ranked, ['sample']);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.entities[1].projectCopySources, [info]);
  info.readable = false;
  const blocked = await labelProjectCopyResults(app, 'space', ranked, ['sample']);
  assert.deepEqual(blocked.entities, [ranked.entities[0]]);
  assert.equal(blocked.incomplete, true);
});

test('a reconnect advances the next scan and a stable size refusal stays idle until conditions change', async () => {
  const { projectCopyDue } = await import('../src/runner/project-copy-loop.js');
  const time = new Date(10_000).toISOString();
  const receipt = { checkedAt: time, attemptedAt: time, outcome: 'synced' };
  assert.equal(projectCopyDue(receipt, 0, 20_000), false);
  assert.equal(projectCopyDue(receipt, 15_000, 20_000), true);
  assert.equal(projectCopyDue(receipt, 0, 610_000), true);
  const refused = { ...receipt, outcome: 'refused', reason: 'scope_too_large' };
  assert.equal(projectCopyDue(refused, 0, 3_600_000), false);
  assert.equal(projectCopyDue(refused, 30_000, 3_600_000), true);
  assert.equal(projectCopyDue({ ...refused, outcome: 'verification_due' }, 0, 20_000), true);
});

test('the existing owner needs a durable permit and the matching open gate to serve requests', async t => {
  const { RunnerHostStore } = await import('../src/runner/host-store.js');
  const { ownerPermitStore } = await import('../src/runner/owner-permit.js');
  const { gateDirectory, freezeProject } = await import('../src/runner/project-write-gate.js');
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-owner-permit-'));
  const record = { authority: 'a'.repeat(64), device: 'b'.repeat(64), spaceId: 'sample-space' };
  const store = new RunnerHostStore(join(dataDir, 'runner', 'host.sqlite'), { spaceId: () => record.spaceId });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const permits = ownerPermitStore(dataDir, store);
  const permit = { ok: true, state: 'owned', spaceId: record.spaceId, owner: record.device,
    operation: 'inventory', generation: 1, project: 'example' };
  assert.equal(permits.generation(record, 'project:example'), null);
  assert.equal(permits.installPermit(record, { ...permit, owner: record.authority }).ok, false);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(gateDirectory(dataDir, record.spaceId)), false);
  for (let i = 0; i < 2; i++) assert.ok(permits.installPermit(record, permit).ok);
  assert.equal(permits.generation(record, 'project:example'), 1);
  freezeProject(gateDirectory(dataDir, record.spaceId), 'example', { role: 'owner', generation: 1, moveId: 'sample-move' });
  assert.equal(permits.generation(record, 'project:example'), null);
});

test('owner and operation HTTP reads return the owner reply only to the local console', async () => {
  const { handleGraphApiRequest } = await import('../src/http/graph-api-router.js');
  const calls = [];
  async function get(path, reply, headers = {}) {
    let status, body;
    const handled = await handleGraphApiRequest({ app: { runnerHost: { projectCall: job => { calls.push(job); return reply; } } },
      url: new URL('/api/personal-projects/sample/owner' + path, 'http://localhost'),
      request: { method: 'GET', headers }, response: { setHeader() {}, writeHead(value) { status = value; },
        end(text) { body = JSON.parse(text); } } });
    assert.ok(handled);
    return { status, body };
  }
  assert.equal((await get('', { ok: true })).status, 200);
  assert.equal(calls.at(-1).action, 'project_read');
  assert.equal((await get('/operations/id', { ok: false, code: 'owner_offline' })).status, 409);
  assert.equal(calls.at(-1).input.operationId, 'id');
  assert.equal((await get('', null)).status, 404);
  assert.equal((await get('', { ok: true }, { forwarded: 'for=sample' })).status, 403);
  assert.equal(calls.length, 3);
});
