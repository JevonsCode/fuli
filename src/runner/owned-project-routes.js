import { join } from 'node:path';

import { writeTextFileAtomic } from '../storage/json-file.js';
import { LOCAL_OWNER, PROJECT_PREFIX, ROUTES_FILE, RoutesStore } from './routes-store.js';

export function localProjectIds(dataDir) {
  const routes = new RoutesStore(join(dataDir, ROUTES_FILE));
  try {
    return routes.all().filter(row => row.owner === LOCAL_OWNER && row.scope.startsWith(PROJECT_PREFIX))
      .map(row => row.scope.slice(PROJECT_PREFIX.length));
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
