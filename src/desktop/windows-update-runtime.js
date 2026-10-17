import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../native-runtime/windows-assets.js';
import { compareSemanticVersions } from '../semantic-version.js';
import { writeTextFileAtomic } from '../storage/json-file.js';

export function snapshotWindowsUpdateRuntime(current, candidateRoot) {
  const settingsPath = join(current.dataDir, 'runtime-settings.json');
  if (!existsSync(settingsPath) || JSON.parse(readFileSync(settingsPath)).graphRuntimeMode !== 'native') {
    throw new Error('Open the installed Fuli tray and configure native mode before updating. Container data requires a separate migration.');
  }
  const assets = root => resolveWindowsNativeBundle(readWindowsNativeBundle(root));
  const previous = assets(current.packageRoot), next = assets(candidateRoot);
  if (previous.neo4jVersion !== next.neo4jVersion) throw new Error('Automatic update requires the same Neo4j version; database upgrades require a separate migration.');
  const path = join(current.dataDir, 'native-runtime', 'manifest.json');
  const bytes = existsSync(path) ? readFileSync(path) : null;
  if (bytes) requireOwnedDescriptor(bytes, previous, current.applicationVersion);
  return { path, bytes, next };
}

// Restore only the owned runtime descriptor after the new processes have stopped.
// This never restores database contents or schema changes.
export function restoreWindowsUpdateRuntime(snapshot, applicationVersion) {
  const bytes = existsSync(snapshot.path) ? readFileSync(snapshot.path) : null;
  if (bytes === null && snapshot.bytes === null || bytes?.equals(snapshot.bytes ?? Buffer.alloc(0))) return;
  if (!bytes) throw new Error('The runtime descriptor disappeared; rollback needs attention.');
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
