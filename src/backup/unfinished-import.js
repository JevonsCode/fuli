import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { graphStateHolds, recordedGraphStates } from './graph-import-states.js';

// A runtime with no lifecycle lock (containers anywhere, native outside
// macOS) must still never start on a graph an import left half written. While
// an import can leave one, a marker in the data directory says so for that
// runtime mode: written before the import writes its first graph, rewritten
// before each change of a graph's state (graph-import-states.js), and removed
// only once every graph is whole again: imported, or back. A start in that
// mode is refused while it is there (unfinishedImportError); an import is
// not, since importing the copy back is the way out, and its success clears it.
//
// It records the copy the first unfinished import took before it (`copy`,
// null when every graph was empty then), what that import was loading
// (`inputDir`), when it began, and each graph's state. An import that starts
// while a marker is there keeps the first import's copy and input: the data
// from before that one is what a person goes back to.
//
// This is not the macOS recovery: nothing is brought back by itself. It only
// keeps a start from running and says how to get back to before the import.

const INSTANCES = ['personal', 'workspace'];

const markerPath = (paths, mode) => join(paths.dataDir, `graph-import-unfinished-${mode}.json`);

// The marker for [mode], or null. One that cannot be read still counts: every
// graph in it may be half written, and nothing is known of its copy.
export function readUnfinishedImport(paths, mode) {
  if (!paths?.dataDir) return null;
  const path = markerPath(paths, mode);
  if (!existsSync(path)) return null;
  let marker = null;
  try { marker = readJsonFile(path, null); } catch { /* unreadable: still unfinished */ }
  const states = recordedGraphStates(marker?.graphStates) ?? {};
  const partial = marker ? INSTANCES.filter(id => graphStateHolds(states[id]) === 'partial') : INSTANCES;
  return { mode, startedAt: text(marker?.startedAt), copy: text(marker?.copy), inputDir: text(marker?.inputDir),
    graphStates: states, partial, readable: Boolean(marker) };
}

// Writes the marker for an import into [mode] and answers a lease shaped like
// the lifecycle lock's (graph-backup.js): record rewrites it with each
// graph's state, release removes it.
export function markUnfinishedImport(paths, mode, { restorePoint, graphStates, inputDir }, now = () => new Date()) {
  const path = markerPath(paths, mode);
  const earlier = readUnfinishedImport(paths, mode);
  const first = earlier?.readable
    ? { startedAt: earlier.startedAt, copy: earlier.copy, inputDir: earlier.inputDir }
    : { startedAt: now().toISOString(), copy: restorePoint?.path ?? null, inputDir: inputDir ?? null };
  let states = { ...graphStates };
  const write = () => writeJsonFileAtomic(path, { mode, ...first, graphStates: states }, { durable: true });
  write();
  return {
    locked: false,
    marked: true,
    async record(patch) {
      if (!patch?.graphStates) return;
      states = { ...patch.graphStates };
      write();
    },
    async release() { rmSync(path, { force: true }); }
  };
}

// The import that takes [mode]'s graph from [path]: a POSIX shell's quoting,
// or PowerShell's on Windows, where a double-quoted path would expand `$`.
export function graphImportCommand(path, mode, platform = process.platform) {
  const quoted = platform === 'win32' ? `'${path.replaceAll("'", "''")}'` : `"${path}"`;
  return `fuli graph import --input ${quoted} --target-mode ${mode} --yes`;
}

// The way back from an unfinished import: the copy from before it, when that
// copy holds every graph that may be half written; otherwise the import's own
// input again (a graph empty before it is in no copy, and only a whole import
// makes it whole); null when the marker names neither.
export function unfinishedImportWayBack(marker) {
  // Every graph already holds its new data (the import stopped while reconciling): finishing it is the way on.
  if (!marker.partial.length && marker.inputDir) return { kind: 'input', path: marker.inputDir };
  const copyHolds = marker.copy ? copyInstances(marker.copy) : null;
  if (copyHolds && marker.partial.every(id => copyHolds.includes(id))) return { kind: 'copy', path: marker.copy };
  if (marker.inputDir) return { kind: 'input', path: marker.inputDir };
  return null;
}

function copyInstances(copy) {
  try {
    const manifest = readJsonFile(join(copy, 'manifest.json'), null);
    return Array.isArray(manifest?.instances) ? manifest.instances.map(({ id }) => id) : null;
  } catch { return null; }
}

// Why a start into [mode] is refused, with the facts a person needs
// (src/local-runtime/startup-failure.js); null when no marker is there.
export function unfinishedImportError(paths, mode) {
  const marker = readUnfinishedImport(paths, mode);
  if (!marker) return null;
  const back = unfinishedImportWayBack(marker);
  const facts = { code: 'graph_import_unfinished', mode, since: marker.startedAt, graphs: marker.partial,
    way: back?.kind ?? null, copyName: marker.copy ? basename(marker.copy) : null,
    copyPath: marker.copy, wayPath: back?.path ?? null };
  return Object.assign(new Error(`An earlier graph import into the ${mode} runtime did not finish; nothing was started.`),
    { code: 'graph_import_unfinished', startupFailure: facts });
}

const text = value => typeof value === 'string' && value ? value : null;
