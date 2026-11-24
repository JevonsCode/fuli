import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { lifecycleRecordsLeft } from '../native-runtime/neo4j-lifecycle-lock.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { moveCommand, quoteTerminalArgument } from '../text/terminal-command.js';
import { GRAPH_STATE, graphStateHolds, recordedGraphStates } from './graph-import-states.js';

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
// null when every graph was empty then), when it began, what the latest
// import was loading (`inputDir`), and each graph's state. An import that
// starts while a marker is there keeps the first import's copy and time: the
// data from before that one is what a person goes back to. Its own input
// replaces the earlier one: it holds every graph the marker says may be half
// written (graph-backup.js refuses one that does not), and running it again
// never overwrites what it already wrote with older data. It keeps the graphs the
// marker says may be half written that way too, until it writes them whole
// (imported): a new import that fails before it gets to one never makes it
// look whole, so the marker stays and the start stays refused.
//
// When even the way back does not work (the backup cannot be read, a file is
// held), giving the import up is the last way out (abandon-import.js): the
// graphs that may be half written move aside, not deleted, and the marker goes.
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
  return { mode, path, startedAt: text(marker?.startedAt), copy: text(marker?.copy), inputDir: text(marker?.inputDir),
    graphStates: states, partial, readable: Boolean(marker) };
}

// Which way out of an unfinished operation comes first for [mode], for a
// start (graph-runtime.js) and the desktop window (desktop-controller.js)
// alike. A marker counts on every platform and in every mode: a graph may be
// half written. A native runtime's lifecycle lock or switch journal (macOS)
// is dealt with first, by its recovery; once it is gone, a marker still
// there is the way out. 'lock', 'marker', or null.
export function unfinishedWayOut(paths, mode, platform = process.platform) {
  if (mode === 'native' && lifecycleRecordsLeft(paths?.nativeRuntimeDir, platform)) return 'lock';
  return readUnfinishedImport(paths, mode) ? 'marker' : null;
}

// A start's refusal while a marker is the way out (unfinishedWayOut), or null.
export function unfinishedImportFirst(paths, mode, platform = process.platform) {
  return unfinishedWayOut(paths, mode, platform) === 'marker' ? unfinishedImportError(paths, mode) : null;
}

export function clearUnfinishedImport(paths, mode) {
  rmSync(markerPath(paths, mode), { force: true });
}

// Writes the marker for an import into [mode] and answers a lease shaped like
// the lifecycle lock's (graph-backup.js): record rewrites it with each
// graph's state, release removes it.
export function markUnfinishedImport(paths, mode, { restorePoint, graphStates, inputDir }, now = () => new Date()) {
  const path = markerPath(paths, mode);
  const earlier = readUnfinishedImport(paths, mode);
  const first = earlier?.readable
    ? { startedAt: earlier.startedAt, copy: earlier.copy, inputDir: inputDir ?? earlier.inputDir }
    : { startedAt: now().toISOString(), copy: restorePoint?.path ?? null, inputDir: inputDir ?? null };
  // A graph the earlier marker says may be half written stays so until this import writes it whole.
  const halfWritten = earlier?.partial ?? [];
  const carried = next => {
    const out = { ...next };
    for (const id of halfWritten) {
      if (out[id] === undefined || graphStateHolds(out[id]) === 'before') out[id] = earlier.graphStates[id] ?? GRAPH_STATE.importFailed;
    }
    return out;
  };
  let states = carried(graphStates);
  const write = () => writeJsonFileAtomic(path, { mode, ...first, graphStates: states }, { durable: true });
  write();
  return {
    locked: false,
    marked: true,
    async record(patch) {
      if (!patch?.graphStates) return;
      states = carried(patch.graphStates);
      write();
    },
    async release() { rmSync(path, { force: true }); }
  };
}

// The import that takes [mode]'s graph from [path], for a POSIX shell or
// PowerShell on Windows (terminal-command.js).
export function graphImportCommand(path, mode, platform = process.platform) {
  return `fuli graph import --input ${quoteTerminalArgument(path, platform)} --target-mode ${mode} --yes`;
}

// Giving up the unfinished import into [mode] (abandon-import.js); it asks before it does anything.
export const abandonImportCommand = mode => `fuli graph abandon-import --target-mode ${mode}`;

// The last way out when FULI cannot give the import up itself: the person
// moves the marker away by hand, to beside it, never deleting it.
export function markerMoveCommand(marker, platform = process.platform) {
  return moveCommand(marker.path, `${marker.path}.abandoned`, platform);
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

// The newest copy an import took before it (backups/graph/before-import-*)
// that names its graphs, or null: the way back when the marker cannot be read.
// One that holds every graph comes first, since a marker that cannot be read
// counts every graph as maybe half written and an import of a copy that lacks
// one is refused (graph-backup.js).
export function latestImportCopy(paths) {
  let names = [];
  try { names = readdirSync(paths.graphBackupDir).filter(name => name.startsWith('before-import-')).sort().reverse(); } catch { /* none */ }
  const copies = names.map(name => join(paths.graphBackupDir, name)).filter(copy => copyInstances(copy));
  return copies.find(copy => INSTANCES.every(id => copyInstances(copy).includes(id))) ?? copies[0] ?? null;
}

// Why a start into [mode] is refused, with the facts a person needs: the
// way back and its command, giving the import up, and for a marker that
// cannot be read, where it is and how to move it away by hand
// (src/local-runtime/startup-failure.js, and the desktop window's words);
// null when no marker is there. The commands are written for this platform.
export function unfinishedImportError(paths, mode) {
  const marker = readUnfinishedImport(paths, mode);
  if (!marker) return null;
  const back = marker.readable ? unfinishedImportWayBack(marker) : null;
  const latest = marker.readable ? null : latestImportCopy(paths);
  const facts = { code: 'graph_import_unfinished', mode, since: marker.startedAt, graphs: marker.partial,
    way: back?.kind ?? null, copyName: marker.copy ? basename(marker.copy) : null,
    copyPath: marker.copy, wayPath: back?.path ?? null,
    // The way back names a folder that is no longer there: importing it cannot work, so giving up comes first.
    wayGone: Boolean(back) && !existsSync(back.path),
    command: back ? graphImportCommand(back.path, mode) : latest ? graphImportCommand(latest, mode) : null,
    abandonCommand: marker.readable ? abandonImportCommand(mode) : null,
    readable: marker.readable, markerPath: marker.path, latestCopy: latest,
    moveMarkerCommand: marker.readable ? null : markerMoveCommand(marker) };
  return Object.assign(new Error(`An earlier graph import into the ${mode} runtime did not finish; nothing was started.`),
    { code: 'graph_import_unfinished', startupFailure: facts });
}

const text = value => typeof value === 'string' && value ? value : null;
