import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { exportGraphData } from '../backup/graph-backup.js';
import { createGraphBackupAdapter } from '../backup/runtime-adapters.js';
import { neo4jPatchUpgrade, neo4jUpgradeBackupPath } from '../native-runtime/neo4j-version-policy.js';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../native-runtime/windows-assets.js';
import { compareSemanticVersions } from '../semantic-version.js';
import { graphBackupDirectory, resolveSetupPaths } from '../setup/paths.js';
import { writeTextFileAtomic } from '../storage/json-file.js';

// downgrade: an older package refuses a newer runtime descriptor, so the switch
// clears it and the older version records its own bundled runtime on start.
// A newer Neo4j patch in the candidate is an upgrade: the graph is backed up
// before the newer Neo4j first opens the store (backupWindowsGraph). An older
// one is refused, whichever way the application version goes.
export function snapshotWindowsUpdateRuntime(current, candidateRoot, { downgrade = false, now = () => new Date() } = {}) {
  const settingsPath = join(current.dataDir, 'runtime-settings.json');
  if (!existsSync(settingsPath) || JSON.parse(readFileSync(settingsPath)).graphRuntimeMode !== 'native') {
    throw new Error('Open the installed Fuli tray and configure native mode before updating. Container data requires a separate migration.');
  }
  const assets = root => resolveWindowsNativeBundle(readWindowsNativeBundle(root));
  const previous = assets(current.packageRoot), next = assets(candidateRoot);
  const upgrade = neo4jPatchUpgrade(previous.neo4jVersion, next.neo4jVersion, { backup: current.previousInstallation?.graphBackup });
  const path = join(current.dataDir, 'native-runtime', 'manifest.json');
  const bytes = existsSync(path) ? readFileSync(path) : null;
  if (bytes) requireOwnedDescriptor(bytes, previous, current.applicationVersion);
  else if (upgrade) throw new Error(`Upgrading Neo4j ${previous.neo4jVersion} → ${next.neo4jVersion} backs up the graph first, which needs the installed runtime record. Start Fuli ${current.applicationVersion} once, then update again.`);
  const neo4jUpgrade = upgrade ? { from: previous.neo4jVersion, to: next.neo4jVersion,
    backupDir: neo4jUpgradeBackupPath(graphBackupDirectory(current.dataDir), next.neo4jVersion, now()) } : null;
  return { path, bytes, next, downgrade, neo4jUpgrade };
}

// Runs inside the switch, after the installed version stopped and before the
// record changes. The runtime descriptor still selects the installed Neo4j, so
// `fuli graph export`'s mechanism dumps the store with the version that wrote it.
// It runs in this process: the candidate's CLI cannot resolve its paths until
// the record names it. The switch decides what starts afterwards, never the export.
export async function backupWindowsGraph(snapshot, current, {
  exportGraph = exportGraphData, createAdapter = createGraphBackupAdapter
} = {}) {
  if (!snapshot.neo4jUpgrade) return;
  const paths = resolveSetupPaths({ dataDir: current.dataDir, packageRoot: current.packageRoot, platform: 'win32' });
  const adapter = await createAdapter({ mode: 'native', paths });
  await exportGraph({ outputDir: snapshot.neo4jUpgrade.backupDir, sourceMode: 'native', instances: adapter.instances,
    adapter: { ...adapter, start: async () => {} } });
}

// Runs inside the switch, after the current version stopped and before the record changes.
export function prepareWindowsUpdateRuntime(snapshot) {
  if (!snapshot.downgrade || snapshot.bytes === null) return;
  if (!existsSync(snapshot.path) || !readFileSync(snapshot.path).equals(snapshot.bytes)) {
    throw new Error('The runtime descriptor changed before rollback; nothing was switched.');
  }
  unlinkSync(snapshot.path);
}

// Restore only the owned runtime descriptor after the new processes have stopped.
// This never restores database contents or schema changes.
export function restoreWindowsUpdateRuntime(snapshot, applicationVersion) {
  const bytes = existsSync(snapshot.path) ? readFileSync(snapshot.path) : null;
  if (bytes === null && snapshot.bytes === null || bytes?.equals(snapshot.bytes ?? Buffer.alloc(0))) return;
  if (!bytes) {
    if (!snapshot.downgrade) throw new Error('The runtime descriptor disappeared; rollback needs attention.');
    writeTextFileAtomic(snapshot.path, snapshot.bytes);
    return;
  }
  requireOwnedDescriptor(bytes, snapshot.next, applicationVersion);
  if (!readFileSync(snapshot.path).equals(bytes)) throw new Error('The runtime descriptor changed during rollback.');
  if (snapshot.bytes) writeTextFileAtomic(snapshot.path, snapshot.bytes);
  else unlinkSync(snapshot.path);
}

function requireOwnedDescriptor(bytes, assets, applicationVersion) {
  const value = JSON.parse(bytes);
  if (value.version !== 1 || value.status !== 'ready' || value.mode !== 'native'
      || !/^[a-f0-9]{64}$/.test(value.providerFingerprint ?? '')
      || !/\+native\.\d+$/.test(value.providerVersion ?? '')
      || compareSemanticVersions(value.providerVersion, applicationVersion) !== 0
      || Object.entries(assets).some(([key, expected]) => value[key] !== expected)) {
    throw new Error('The runtime descriptor does not belong to this installation; rollback needs attention.');
  }
}
