import { statSync } from 'node:fs';
import { join } from 'node:path';

import { writeTextFileAtomic } from '../storage/json-file.js';
import { LOCAL_OWNER, PROJECT_PREFIX, ROUTES_FILE, RoutesStore, routesAsTheyAre } from './routes-store.js';

// Read again only when the routes file or its write-ahead log changed: the
// follower console asks on every request, and a follower that routes nothing
// here pays one stat for it (none opens the store while it does not exist).
const read = new Map();

export function localProjectIds(dataDir) {
  const path = join(dataDir, ROUTES_FILE);
  const seen = [path, `${path}-wal`].map(file => {
    const stat = statSync(file, { throwIfNoEntry: false });
    return stat ? `${stat.mtimeMs}:${stat.size}` : '-';
  }).join('|');
  if (seen.startsWith('-|')) return [];
  const kept = read.get(dataDir);
  if (kept?.seen === seen) return kept.ids;
  // Read-only, so reading changes neither file and what was seen stays the key; a store that
  // needs its migration (or is held right now) is opened as before and not kept.
  let asTheyAre = null;
  try { asTheyAre = routesAsTheyAre(path); } catch { asTheyAre = null; }
  const routes = asTheyAre ?? new RoutesStore(path);
  try {
    const ids = routes.all().filter(row => row.owner === LOCAL_OWNER && row.scope.startsWith(PROJECT_PREFIX))
      .map(row => row.scope.slice(PROJECT_PREFIX.length));
    if (asTheyAre) read.set(dataDir, { seen, ids });
    return ids;
  } finally { routes.close(); }
}

export function ownsLocalProjects(dataDir) {
  return localProjectIds(dataDir).length > 0;
}

export const OWNED_PROJECT_MARKER = join('runner', 'owned-project');

// The console watches this file. It also records that an earlier local route
// may have written data even after the project is routed elsewhere.
export function recordOwnedProject(dataDir, scope) {
  writeTextFileAtomic(join(dataDir, OWNED_PROJECT_MARKER), scope, { durable: true });
}
