import { installedProviderRefusal } from '../native-runtime/runtime.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { inspectLocalStores } from './local-stores.js';

// Whether a previous FULI can still run on a data directory a newer FULI
// already started on. Nothing is started and every store is opened read-only
// (local-stores.js). Two questions, by which code asks:
// - dataNewerThanThisPackage: the previous version's own code asks (the macOS
//   app update runs on it), so it reads every store with its own formats and
//   compares the recorded Provider with its own.
// - dataFormatMarks / dataUpgradedSince: the new version's code asks (the
//   Windows update runs on it) and cannot know the previous version's formats,
//   so it compares the stores before and after the new version's start.
// Each answers a reason the previous version cannot run, or null. Neither sees
// the graph's own format in Neo4j, which only a running Provider reads.

// The states this code runs on: its own format, nothing yet, an older format
// it upgrades or reads, or a newer one it is declared to read. Anything else
// (newer, half-applied, waiting for the person, unsupported, unreadable or
// unavailable) keeps the previous version away: it never comes back on data
// nobody could read. A folder of records reports its worst record.
const RUNS_ON = new Set(['current', 'empty', 'absent', 'upgrade_on_open', 'unversioned', 'newer_readable']);

export function dataNewerThanThisPackage(dataDir) {
  const stores = inspectLocalStores(dataDir).filter(({ state }) => !RUNS_ON.has(state));
  if (stores.length) return unusableStores(stores);
  return installedProviderRefusal(resolveSetupPaths({ dataDir }).nativeRuntimeManifestPath)?.message.split(':')[0] ?? null;
}

// Each local store's format version, state and (for a folder of records)
// how many records are in each state, before a newer version starts.
export function dataFormatMarks(dataDir) {
  return Object.fromEntries(inspectLocalStores(dataDir).map(({ label, version, state, counts }) =>
    [label, { version, state, counts: counts ?? null }]));
}

// The stores the newer version moved past what was there at dataFormatMarks:
// one that existed and is now at a higher version; a folder with fewer records
// in an older format (some were rewritten in the new one); a migration left
// unfinished; or one that can no longer be read. A store it created is left
// out: the previous version never had it, and one it does not know it never
// opens. Whether the previous version declared it reads a raised version
// (newer_readable) only its own code knows, so every raise counts.
export function dataUpgradedSince(marks, dataDir) {
  const changes = inspectLocalStores(dataDir).map(store => change(marks[store.label], store)).filter(Boolean);
  return changes.length ? `stores the new version changed: ${changes.join(', ')}` : null;
}

const UNREADABLE = new Set(['unavailable', 'unreadable', 'half_applied']);
const OLDER_RECORDS = ['upgrade_on_open', 'unversioned', 'pending_confirmation'];

function change(before, after) {
  if (!before) return null;
  if (UNREADABLE.has(after.state)) return after.state === before.state ? null : `${after.label} ${after.state}`;
  if (Number.isInteger(before.version) && Number.isInteger(after.version)) {
    return after.version > before.version ? `${after.label} ${before.version} → ${after.version}` : null;
  }
  if (!before.counts || !after.counts) return null;
  const older = counts => OLDER_RECORDS.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
  const rewritten = older(before.counts) - older(after.counts);
  if (rewritten > 0) return `${after.label} ${rewritten} records rewritten`;
  return (after.counts.half_applied ?? 0) > (before.counts.half_applied ?? 0) ? `${after.label} half_applied` : null;
}

const unusableStores = stores => `stores it cannot use: ${stores.map(({ label, state }) => `${label} ${state}`).join(', ')}`;
