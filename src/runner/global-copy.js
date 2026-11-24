import { openRoutes } from './call-routes.js';
import { GLOBAL_SCOPE, ownerFingerprint } from './routes-store.js';

// Whether this computer's `global` is a read-only copy of another computer's
// (docs/runner-roles-design.md D1, §12): its routes store sends `global` to a
// paired host. What a Provider started here is told as FULI_GLOBAL_REPLICA
// (graph-provider config.global_replica), so it writes no default record of
// `global`. Every path that starts a Provider on a follower must take the value
// from here at that start, never pass a fixed one: today the preparation
// (follower-runtime-prepare.js); later the start that keeps a Provider running
// for a scope this computer owns. A computer that follows no one answers false.
export function globalIsCopyHere(dataDir, { open = openRoutes } = {}) {
  const routes = open(dataDir);
  try { return ownerFingerprint(routes.owner(GLOBAL_SCOPE)) !== null; } finally { routes.close(); }
}
