import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectCopyStatus, projectCopySync } from '../src/runner/project-copy-sync.js';

test('an unchanged source also needs matching local content, owner, and zero dangling references', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-copy-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const spaceId = 'space', project = 'sample', scope = 'project:sample';
  const record = { project, owner: 'a'.repeat(64), generation: 1, state: 'owned', pairing: 'pair' };
  const digest = 'd'.repeat(64), contentDigest = 'c'.repeat(64);
  const bytes = Buffer.from('{"precise":12345678901234567890,"value":"样本"}');
  const rawDigest = createHash('sha256').update(bytes).digest('hex');
  let imports = 0, dangling = 0, offline = false, holds = 0, applied, lease = null;
  let summary = { scope, owners: [record.owner], contentDigest };
  const sync = projectCopySync({ dataDir, spaceId, ownership: () => record, hold: () => { holds++; return () => { holds--; }; },
    withLease: async (owner, work) => { lease = owner; try { return await work(); } finally { lease = null; } },
    request: async job => {
      assert.equal(job.generation, 1);
      if (offline) return { ok: false, code: 'owner_offline' };
      if (job.action === 'export_digest') return { ok: true, result: { ok: true, digest, rawDigest, bytes: bytes.length } };
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
