// Where one import stands with each graph it loads: recorded in the lock of
// every load it runs (its own rollback's and a recovery's restore included),
// written there before that graph is written (graph-backup.js,
// native-runtime/recovery-services.js). Abandoning the import reads only this
// to tell which graph may be half written (native-runtime/load-recovery.js).
// The lock goes when the import (or its recovery) is over, and this with it.
export const GRAPH_STATE = Object.freeze({
  // Not written by this import: the data from before it.
  untouched: 'untouched',
  // This import is writing its new data.
  writing: 'writing',
  // This import wrote all of its new data.
  imported: 'imported',
  // Writing the new data failed part way.
  importFailed: 'importFailed',
  // Being brought back from the copy the import took before it.
  restoring: 'restoring',
  // Brought back from that copy: the data from before the import.
  restored: 'restored',
  // Bringing it back from that copy failed part way.
  restoreFailed: 'restoreFailed'
});

const STATES = new Set(Object.values(GRAPH_STATE));

// What a graph in [state] holds: 'partial' (may be half written), 'new' (this
// import's data) or 'before' (the data from before the import); null for a
// state FULI does not know.
export function graphStateHolds(state) {
  switch (state) {
    case GRAPH_STATE.writing: case GRAPH_STATE.importFailed: case GRAPH_STATE.restoring: case GRAPH_STATE.restoreFailed: return 'partial';
    case GRAPH_STATE.imported: return 'new';
    case GRAPH_STATE.untouched: case GRAPH_STATE.restored: return 'before';
    default: return null;
  }
}

// The states a lock recorded, keeping only known states; null when it recorded none.
export function recordedGraphStates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const known = Object.entries(value).filter(([, state]) => STATES.has(state));
  return known.length ? Object.fromEntries(known) : null;
}
