import { join } from 'node:path';

import { readGraphBackupManifest } from './graph-backup.js';
import { containerAsideFolder } from './runtime-adapters.js';
import { latestImportCopy, readUnfinishedImport, unfinishedImportError, unfinishedImportWayBack } from './unfinished-import.js';
import { diskSize } from '../native-runtime/recovered-dir.js';
import { planned, refused } from '../native-runtime/recovery-plan.js';

// The desktop window's way out of an unfinished import on a runtime with no
// lifecycle lock (unfinished-import.js: containers, native outside macOS), in
// the shape of a recovery plan (recovery-plan.js) so the window confirms it
// the way it confirms a recovery: what it does, then its digest.
//
// - import_back: the copy from before the import goes back (or, for a marker
//   that cannot be read, the newest such copy): every graph in it returns to
//   how it was before the import, and what that import wrote is not kept.
// - import_again: the import's own input runs again (no copy holds a graph
//   that may be half written; it was empty before).
// - abandon_import: each graph that may be half written moves aside, not
//   deleted, and the record goes (abandon-import.js).
//
// Each is the same command the terminal runs (`fuli graph import --input …`,
// `fuli graph abandon-import`); the plan only fixes which input and which
// graphs the person saw. A refusal carries the marker's own facts, with the
// commands for a terminal, for the window to keep offering them.

export async function planUnfinishedImport({ paths, mode, abandon = false }) {
  const marker = readUnfinishedImport(paths, mode);
  if (!marker) return planned('nothing', []);
  const facts = { mode, since: marker.startedAt, graphs: marker.partial, readable: marker.readable };
  // The facts a refused start carries, under the refusal's own code.
  const marked = { ...unfinishedImportError(paths, mode).startupFailure };
  delete marked.code;
  const refuse = reason => refused(reason, { ...marked, ...facts });
  if (abandon) {
    if (!marker.readable) return refuse('marker_unreadable');
    return planned('abandon_import', [{ do: 'abandon-import', mode, graphs: marker.partial }],
      { ...facts, copy: marker.copy, asideTo: asideTo(paths, mode, marker) });
  }
  const latest = marker.readable ? null : latestImportCopy(paths);
  const way = marker.readable ? unfinishedImportWayBack(marker) : latest && { kind: 'copy', path: latest };
  if (!way) return refuse('no_way_back');
  let backup;
  try { backup = await readGraphBackupManifest(way.path); }
  catch { return refuse(way.kind === 'input' ? 'import_input_missing' : 'import_copy_missing'); }
  return planned(way.kind === 'copy' ? 'import_back' : 'import_again', [{ do: 'import', from: way.path, mode }],
    { ...facts, from: way.path, createdAt: backup.createdAt ?? null, instances: backup.instances.map(({ id }) => id),
      bytes: diskSize(way.path) });
}

// Where abandoning moves a graph: the native runtime's recovered folder, or a
// folder named for when the import began inside each container's own volume.
function asideTo(paths, mode, marker) {
  return mode === 'native'
    ? { folder: join(paths.nativeRuntimeDir, 'recovered'), volume: false }
    : { folder: containerAsideFolder(marker.startedAt), volume: true };
}
