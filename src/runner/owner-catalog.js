import { unfinishedImportError } from '../backup/unfinished-import.js';
import { createNativeGraphServices } from '../native-runtime/runtime.js';
import { holdPreparationLock, readLocalRuntime } from './follower-local-runtime.js';

// An already prepared follower with no local route has no broker. Take its
// preparation lock for this one catalog read, just as for the initial copy.
export async function preparedOwnerCatalog({ paths, spaceId, current, read, hold = holdPreparationLock,
  prepared = readLocalRuntime, services = createNativeGraphServices, unfinished = unfinishedImportError }) {
  const release = hold(paths.dataDir, { waitMs: 0 });
  if (!release) throw new Error('Local project inventory is busy');
  try {
    const state = prepared(paths.dataDir);
    if (!current() || state.state !== 'ready' || !state.createdHere || state.space?.id !== spaceId ||
      state.running || unfinished(paths, 'native')) throw new Error('Local project inventory is unavailable');
    const graph = services({ paths, personalOnly: true });
    if (await graph.ready()) return await read();
    try {
      await graph.start();
      if (!current()) throw new Error('Local project inventory changed');
      return await read();
    } finally { await graph.stopDatabases(); }
  } finally { release(); }
}
