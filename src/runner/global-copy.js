import { openRoutes } from './call-routes.js';
import { GLOBAL_SCOPE, ownerFingerprint } from './routes-store.js';
import { isRunnerDataDirectory } from './runner-mode.js';

// Whether this computer's `global` is a read-only copy of another computer's
// (docs/runner-roles-design.md D1, §12): its routes store sends `global` to a
// paired host. What a Provider started here is told as FULI_GLOBAL_REPLICA
// (graph-provider config.global_replica), so it writes no default record of
// `global`. Every path that starts a Provider on a follower takes the value
// from here at that start, never a fixed one: the preparation asks it itself
// (follower-runtime-prepare.js), and any other start that does not say asks
// providerGlobalReplica (native-runtime/runtime.js, setup/graph-runtime.js).
// A computer that follows no one answers false.
export function globalIsCopyHere(dataDir, { open = openRoutes } = {}) {
  const routes = open(dataDir);
  try { return ownerFingerprint(routes.owner(GLOBAL_SCOPE)) !== null; } finally { routes.close(); }
}

// The same for a start whose caller did not say: only a data directory that follows a host is
// asked (nothing is opened or made on any other computer, which answers false).
export function providerGlobalReplica(dataDir, { isRunner = isRunnerDataDirectory, copyHere = globalIsCopyHere } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || !isRunner(dataDir)) return false;
  return copyHere(dataDir);
}
