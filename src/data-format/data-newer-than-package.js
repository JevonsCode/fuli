import { installedProviderRefusal } from '../native-runtime/runtime.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { inspectLocalStores } from './local-stores.js';

// Whether a previous FULI can still run on a data directory a newer FULI
// already started on. Nothing is started and every store is opened read-only
// (local-stores.js). Two questions, by which code asks:
// - dataNewerThanThisPackage: the previous version's own code asks (the macOS
//   app update runs on it), so it compares with its own formats and Provider.
// - dataFormatMarks / dataUpgradedSince: the new version's code asks (the
//   Windows update runs on it) and cannot know the previous version's formats,
//   so it compares the stores before and after the new version's start.
// Each answers a reason the previous version cannot run, or null.
const NOT_FOR_THIS_VERSION = new Set(['newer_format', 'half_applied']);

export function dataNewerThanThisPackage(dataDir) {
  const stores = inspectLocalStores(dataDir).filter(({ state }) => NOT_FOR_THIS_VERSION.has(state)).map(({ label }) => label);
  if (stores.length) return newerStores(stores);
  return installedProviderRefusal(resolveSetupPaths({ dataDir }).nativeRuntimeManifestPath)?.message.split(':')[0] ?? null;
}

// Each local store's format version and state before a newer version starts.
export function dataFormatMarks(dataDir) {
  return Object.fromEntries(inspectLocalStores(dataDir).map(({ label, version, state }) => [label, { version, state }]));
}

// The stores the newer version moved past what was there at dataFormatMarks:
// a store that existed and is now at a higher version, or a migration it left
// unfinished. A store it created is left out: the previous version never had
// it, and one it does not know it never opens.
export function dataUpgradedSince(marks, dataDir) {
  const stores = inspectLocalStores(dataDir).filter(({ label, version, state }) => {
    const before = marks[label];
    if (state === 'half_applied') return before?.state !== 'half_applied';
    return Number.isInteger(before?.version) && Number.isInteger(version) && version > before.version;
  }).map(({ label }) => label);
  return stores.length ? newerStores(stores) : null;
}

const newerStores = labels => `${labels.join(', ')} already use a newer data format`;
