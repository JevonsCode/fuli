import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { installedWindowsFixture } from './fixtures/windows-installation.js';
import { readWindowsInstallation } from '../src/desktop/windows-installation-context.js';
import { planWindowsRollback, rollbackWindowsInstallation } from '../src/desktop/windows-rollback.js';
import { planWindowsUpdate, updateWindowsInstallation } from '../src/desktop/windows-update.js';
import { backupWindowsGraph, snapshotWindowsUpdateRuntime } from '../src/desktop/windows-update-runtime.js';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../src/native-runtime/windows-assets.js';

// Synthetic bundles only: the installed fixture bundles Neo4j 5.26.28 and the
// candidate is re-labelled to another version.
const INSTALLED = '5.26.28';

function candidateNeo4j(f, version) {
  const lib = join(f.source, 'runtime', 'neo4j', 'lib');
  for (const name of readdirSync(lib)) renameSync(join(lib, name), join(lib, name.replace(INSTALLED, version)));
  const path = join(f.source, 'tray-files.sha256.json');
  writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path)).map(([name, hash]) => [name.replace(INSTALLED, version), hash])));
}

function fixture(t, candidate = '5.26.29') {
  const f = installedWindowsFixture(t);
  candidateNeo4j(f, candidate);
  const manifestPath = join(f.current.dataDir, 'native-runtime', 'manifest.json');
  const descriptor = JSON.stringify({ version: 1, status: 'ready', mode: 'native', providerVersion: '0.12.4+native.7',
    providerFingerprint: 'a'.repeat(64), ...resolveWindowsNativeBundle(readWindowsNativeBundle(f.current.packageRoot)) });
  mkdirSync(dirname(manifestPath), { recursive: true }); writeFileSync(manifestPath, descriptor);
  const recordPath = join(f.current.installRoot, 'installation.json');
  const backups = [];
  // Records what the switch looked like when the backup ran.
  const backupGraph = async snapshot => {
    backups.push({ dir: snapshot.neo4jUpgrade.backupDir, version: JSON.parse(readFileSync(recordPath)).applicationVersion,
      descriptor: readFileSync(manifestPath, 'utf8'), calls: f.calls.map(({ args }) => args[0]) });
  };
  return { ...f, manifestPath, descriptor, recordPath, backups, deps: { ...f.deps, backupGraph } };
}

test('a newer Neo4j patch is backed up with the installed runtime before the record switches', async t => {
  const f = fixture(t);
  const plan = planWindowsUpdate({ ...f.options, readShortcut: f.deps.readShortcut });
  assert.deepEqual([plan.neo4jUpgrade.from, plan.neo4jUpgrade.to], [INSTALLED, '5.26.29']);
  const next = await updateWindowsInstallation(f.options, f.deps);
  assert.equal(f.backups.length, 1);
  const [backup] = f.backups;
  assert.equal(backup.version, '0.12.4', 'the record still names the installed version');
  assert.equal(backup.descriptor, f.descriptor, 'the installed Neo4j is still selected');
  assert.deepEqual(backup.calls, ['stop'], 'the installed version stopped and the candidate has not started');
  assert.equal(dirname(backup.dir), join(f.current.dataDir, 'backups', 'graph'));
  assert.match(backup.dir, /before-neo4j-5\.26\.29-/);
  assert.equal(next.previousInstallation.graphBackup, backup.dir);
  assert.equal(readWindowsInstallation(next.packageRoot).applicationVersion, '0.12.5');
});

test('the same Neo4j version takes no graph backup', async t => {
  const f = fixture(t, INSTALLED);
  const next = await updateWindowsInstallation(f.options, f.deps);
  assert.equal(f.backups.length, 0);
  assert.equal(next.previousInstallation.graphBackup, undefined);
});

test('a failed graph backup switches nothing and restarts the installed version', async t => {
  const f = fixture(t);
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, backupGraph: async () => { throw new Error('injected dump failure'); } }),
    /graph backup before the Neo4j upgrade failed; nothing was switched.*0\.12\.4 was restored/);
  assert.deepEqual(f.calls.map(({ root, args }) => [root === f.current.packageRoot ? 'old' : 'new', args[0]]),
    [['old', 'stop'], ['old', 'start'], ['old', 'status']]);
  assert.equal(JSON.parse(readFileSync(f.recordPath)).applicationVersion, '0.12.4');
  assert.equal(readFileSync(f.manifestPath, 'utf8'), f.descriptor);
});

test('a failed start on the newer Neo4j names the kept backup when the installed version is restored', async t => {
  const f = fixture(t);
  await assert.rejects(updateWindowsInstallation(f.options, { ...f.deps, runCli: async (root, args) => {
    f.calls.push({ root, args });
    return { code: args[0] === 'start' && root !== f.current.packageRoot ? 1 : 0 };
  } }), error => /0\.12\.4 was restored/.test(error.message) && error.message.includes(`kept at ${f.backups[0].dir}`));
});

// The Windows bundle reader accepts only 5.26 runtimes, so another minor stops there.
test('an older or other-minor Neo4j is refused before any service action', async t => {
  for (const [version, reason] of [['5.26.0', /downgrade/], ['5.27.0', /Community 5\.26 runtime/]]) {
    const f = fixture(t, version);
    assert.throws(() => planWindowsUpdate({ ...f.options, readShortcut: f.deps.readShortcut }), reason);
    await assert.rejects(updateWindowsInstallation(f.options, f.deps), reason);
    assert.equal(f.calls.length, 0);
    assert.equal(f.backups.length, 0);
  }
});

test('an upgrade without an installed runtime record is refused instead of skipping the backup', async t => {
  const f = fixture(t);
  rmSync(f.manifestPath);
  assert.throws(() => planWindowsUpdate({ ...f.options, readShortcut: f.deps.readShortcut }), /runtime record/);
});

test('rollback to the older Neo4j patch is refused, names the backup and changes nothing', async t => {
  const f = fixture(t);
  const next = await updateWindowsInstallation(f.options, f.deps);
  f.calls.length = 0;
  const record = readFileSync(f.recordPath);
  const refused = error => /downgrade/.test(error.message) && error.message.includes(`kept at ${next.previousInstallation.graphBackup}`);
  assert.throws(() => planWindowsRollback({ env: f.env, readShortcut: f.deps.readShortcut }), refused);
  await assert.rejects(rollbackWindowsInstallation({ env: f.env }, f.deps), refused);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(readFileSync(f.recordPath), record);
});

test('the default backup runs `fuli graph export` against the installed data directory in native mode', async t => {
  const f = fixture(t);
  const snapshot = snapshotWindowsUpdateRuntime(f.current, f.source);
  const seen = {};
  await backupWindowsGraph(snapshot, f.current, {
    createAdapter: async ({ mode, paths }) => {
      Object.assign(seen, { mode, dataDir: paths.dataDir });
      return { instances: ['personal'], start: async () => { throw new Error('the export must not restart the installed Neo4j'); } };
    },
    exportGraph: async ({ outputDir, sourceMode, instances, adapter }) => {
      await adapter.start({ resume: true });
      Object.assign(seen, { outputDir, sourceMode, instances });
    }
  });
  assert.deepEqual(seen, { mode: 'native', dataDir: f.current.dataDir, outputDir: snapshot.neo4jUpgrade.backupDir,
    sourceMode: 'native', instances: ['personal'] });
});
