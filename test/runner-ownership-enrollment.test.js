import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { inventoryDigest } from '../src/runner/owner-inventory.js';
import { configureOwnershipProvider } from '../src/runner/configure-ownership-provider.js';
import { installationComposeFiles } from '../src/runner/installation-compose.js';
import { enrollInstallation } from '../src/runner/ownership-enrollment.js';
import { projectRegistry } from '../src/runner/project-creation.js';
import { holdInstallation, installationPhase, installationRecord, prepareInstallation } from '../src/runner/project-installation.js';
import { gateDirectory, readProjectGate } from '../src/runner/project-write-gate.js';

test('enrollment drains prior writers, survives interruption and checks the local catalog', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-enrollment-'));
  const device = 'a'.repeat(64), descriptor = { device, authority: device, spaceId: 'sample' };
  const store = new RunnerHostStore(join(dataDir, 'runner', 'host.sqlite'), { spaceId: () => descriptor.spaceId });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal(holdInstallation(dataDir), null);
  prepareInstallation(dataDir);
  const release = holdInstallation(dataDir);
  assert.throws(() => installationPhase(dataDir, descriptor));
  assert.equal(installationRecord(dataDir), null);
  release();
  let corrupt = true;
  const projects = ['first', 'second'];
  const enroll = () => enrollInstallation({ dataDir, descriptor, registry: store.ownership(), current: () => true,
    personal: { ownProjectCatalog: async () => {
      const row = installationRecord(dataDir);
      return { projects, count: 2, digest: corrupt ? 'wrong' : inventoryDigest(projects),
        installation: row ? { ...descriptor, phase: row.phase } : { phase: 'single' } };
    } } });
  await assert.rejects(enroll(), { code: 'inventory_incomplete' });
  assert.throws(() => holdInstallation(dataDir));
  assert.equal(store.ownership().owner('first'), null);
  corrupt = false;
  await enroll();
  await enroll();
  holdInstallation(dataDir)();
  assert.equal(projectRegistry(dataDir, descriptor.spaceId).device, device);
  for (const project of projects) assert.equal(readProjectGate(gateDirectory(dataDir, 'sample'), project).role, 'owner');
});


test('only a managed personal container is reconciled for first enrollment', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-container-enroll-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const paths = { dataDir };
  assert.deepEqual(installationComposeFiles(paths), []);
  prepareInstallation(dataDir);
  assert.equal(installationComposeFiles(paths)[0], '-f');
  let mode = 'native', managed = ['personal'], calls = 0, blocked = null;
  const configure = () => configureOwnershipProvider(paths, {
    read: () => ({ runtimeSettings: { graphRuntimeMode: mode }, managedProviders: managed }),
    unfinished: () => blocked, services: () => ({ configurePersonal: () => { calls++; } })
  });
  await configure();
  mode = 'container';
  managed = [];
  await configure();
  assert.equal(calls, 0);
  managed = ['personal'];
  blocked = new Error('unfinished import');
  await assert.rejects(configure(), /unfinished import/);
  blocked = null;
  await configure();
  assert.equal(calls, 1);
});
