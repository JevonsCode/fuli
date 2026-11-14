import { installedProviderRefusal } from '../native-runtime/runtime.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { inspectLocalStores } from './local-stores.js';

// Why the FULI this code belongs to cannot run on a data directory a newer
// FULI already used, or null. Nothing is started and every store is opened
// read-only (local-stores.js), so a macOS app update running on the previous
// version's code can tell whether swapping back to that version would work:
// a local store a newer version upgraded (or left half-upgraded), or a native
// Provider newer than this package's, which its start refuses.
const NOT_FOR_THIS_VERSION = new Set(['newer_format', 'half_applied']);

export function dataNewerThanThisPackage(dataDir) {
  const stores = inspectLocalStores(dataDir).filter(({ state }) => NOT_FOR_THIS_VERSION.has(state)).map(({ label }) => label);
  if (stores.length) return `${stores.join(', ')} already use a newer data format`;
  return installedProviderRefusal(resolveSetupPaths({ dataDir }).nativeRuntimeManifestPath)?.message.split(':')[0] ?? null;
}
