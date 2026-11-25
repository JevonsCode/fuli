import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { inventoryDigest } from '../src/runner/owner-inventory.js';
import { configureOwnershipProvider } from '../src/runner/configure-ownership-provider.js';
import { installationComposeFiles } from '../src/runner/installation-compose.js';
import { createRunnerHost } from '../src/runner/host-service.js';
import { enrollInstallation } from '../src/runner/ownership-enrollment.js';
import { projectRegistry } from '../src/runner/project-creation.js';
import { holdInstallation, installationPhase, installationRecord, prepareInstallation } from '../src/runner/project-installation.js';
import { gateDirectory, readProjectGate, holdBackupOwnership, holdProjectWrites, initializeProjectGate, markProjectConflict } from '../src/runner/project-write-gate.js';

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
  const backup = holdBackupOwnership(dataDir, false);
  try {
    assert.equal(backup.digest, undefined);
    assert.throws(() => installationPhase(dataDir, descriptor));
  } finally { backup.release(); }
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


test('the host completes interrupted inventory after restart even when its last peer was revoked', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-recover-inventory-'));
  const device = 'c'.repeat(64), peer = 'd'.repeat(64), spaceId = 'sample';
  const descriptor = { spaceId, device, authority: device };
  const registry = new RunnerHostStore(join(dataDir, 'runner', 'host.sqlite'), { spaceId: () => spaceId });
  registry.invite({ code: 'revoked-sample', name: 'Peer' });
  registry.pair({ code: 'revoked-sample', fingerprint: peer });
  installationPhase(dataDir, descriptor);
  registry.revoke(peer);
  registry.close();
  const host = createRunnerHost({ dataDir, enrollOwnership: true, loadIdentity: async () => ({ fingerprint: device }),
    app: { config: { personal: { spaceId } }, personal: { async ownProjectCatalog() {
      return { count: 1, projects: ['sample'], digest: inventoryDigest(['sample']),
        installation: { ...descriptor, phase: installationRecord(dataDir).phase } };
    } } } });
  t.after(async () => { await host.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await host.start();
  for (let i = 0; i < 50 && installationRecord(dataDir).phase !== 'active'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(installationRecord(dataDir).phase, 'active');
  holdInstallation(dataDir)();
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


test('a competing claim waits for the local writer and leaves the project closed after restart', t => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-duplicate-ownership-'));
  const directory = gateDirectory(root, 'space');
  const store = new RunnerHostStore(join(root, 'runner', 'host.sqlite'), { spaceId: () => 'space',
    onProjectConflict: (_space, project, generation) => markProjectConflict(directory, project, generation) });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const registry = store.ownership(), local = 'a'.repeat(64), other = 'b'.repeat(64);
  registry.verified(local, ['one']);
  initializeProjectGate(directory, 'one', 'owner', 1);
  const writer = holdProjectWrites(directory, ['one']);
  try { assert.throws(() => registry.reported(other, ['one']), { code: 'project_writes_in_flight' }); }
  finally { writer(); }
  assert.equal(registry.owner('one').state, 'owned');
  registry.reported(other, ['one']);
  assert.equal(registry.owner('one').state, 'conflict');
  assert.equal(readProjectGate(directory, 'one').role, 'conflict');
  assert.throws(() => holdProjectWrites(directory, ['one']), { code: 'project_write_blocked' });
});
