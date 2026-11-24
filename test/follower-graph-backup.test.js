import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceCertificate } from '../packages/roundtable/src/peer/device-identity.js';
import { runGraphDataCommand } from '../src/cli/graph-data-command.js';
import { openRoutes } from '../src/runner/call-routes.js';
import { readGlobalCopyRecord, recordGlobalCopy } from '../src/runner/global-copy-state.js';
import { RunnerStore, RUNNER_FILE } from '../src/runner/runner-store.js';
import { ownIssuer } from '../src/runner/task-issuer.js';

test('the follower exports its identity and accepts only a person’s same-computer, same-space restore', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fuli-follower-backup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folder = join(dir, 'export');
  const store = new RunnerStore(join(dir, RUNNER_FILE));
  const fingerprint = 'a'.repeat(64);
  store.saveHost({ name: 'Synthetic host', fingerprint, certPem: 'synthetic', port: 2730, addresses: ['192.0.2.1'] });
  store.close();
  const routes = openRoutes(dir);
  routes.setLocalProject('project:sample', null);
  routes.close();
  await mkdir(join(dir, 'peer'));
  await writeFile(join(dir, 'peer/device-cert.pem'), (await createDeviceCertificate()).certPem);
  await writeFile(join(dir, 'graph-runtime.json'), JSON.stringify({ personal: { spaceId: 'space' } }));
  const runtime = { consoleRunning: async () => false };
  const adapter = { instances: ['personal'], stop: async () => ({}), start: async () => {},
    selection: async () => ({ personalSpaceId: 'space' }), dump: (_id, file) => writeFile(file, 'synthetic dump') };
  const deps = { createAdapter: async () => adapter, runtime, write: () => {}, env: {}, interactive: false };
  await runGraphDataCommand('export', ['--output', folder, '--data-dir', dir], deps);
  const file = join(folder, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(manifest.computer, ownIssuer(dir));
  assert.equal(manifest.followsHost, fingerprint);
  const args = ['--input', folder, '--yes', '--data-dir', dir];
  for (const mismatch of [{ computer: 'elsewhere' }, { followsHost: 'another' }, { selection: { personalSpaceId: 'old-space' } }]) {
    await writeFile(file, JSON.stringify({ ...manifest, ...mismatch }));
    await assert.rejects(runGraphDataCommand('import', args, deps), { code: 'backup_from_another_computer' });
  }
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(runGraphDataCommand('import', args, deps), { code: 'needs_person' });
  recordGlobalCopy(dir, { digest: 'old', contentDigest: 'old replica', last: { outcome: 'synced' } });
  let confirmed = false;
  await runGraphDataCommand('import', args, { ...deps, interactive: true, confirm: async () => (confirmed = true),
    importData: async ({ validateManifest }) => { validateManifest(manifest); return { status: 'imported' }; } });
  assert.equal(confirmed, true);
  assert.equal(readGlobalCopyRecord(dir).digest, null);
  assert.equal(readGlobalCopyRecord(dir).contentDigest, null);
  assert.ok(readGlobalCopyRecord(dir).dueSoon);
});
