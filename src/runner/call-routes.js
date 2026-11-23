import { join } from 'node:path';

import { findRepositoryRoot } from '../graphiti/project-path-context.js';
import { localOriginRemoteKey } from '../graphiti/repository-remote.js';
import { DEFAULT_SCOPE, GLOBAL_SCOPE, hostOwner, LOCAL_OWNER, ROUTES_FILE, RoutesStore } from './routes-store.js';
import { RUNNER_FILE, RunnerStore } from './runner-store.js';

// Which scope a call belongs to, and therefore which computer answers it
// (docs/runner-roles-design.md §4). Decided here, on this computer, before
// anything is sent:
//
//   no folder (global tools, the roundtable, a listing)  →  `global`
//   a folder                                             →  `project:<id>`
//
// A project's id is the same thing the owner's resolver matches a folder on:
// the normalised key of the repository's origin remote, or, for a repository
// with no origin (and for a folder that is not in one), the repository root's
// own path on this computer. It is read from the folder itself, so a computer
// that holds none of the person's knowledge can still tell which scope a call
// belongs to.
const PATH_ID = 'path:';

export function callScope(projectPath, { repositoryRoot = findRepositoryRoot, remoteKey = localOriginRemoteKey } = {}) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return GLOBAL_SCOPE;
  let root = null;
  try { root = repositoryRoot(projectPath); } catch { root = null; }
  if (!root) return `project:${PATH_ID}${projectPath}`;
  let key = null;
  try { key = remoteKey(root); } catch { key = null; }
  return `project:${key || `${PATH_ID}${root}`}`;
}


// A data directory's routes, created from an earlier version's pairing when it
// has none (docs/runner-roles-design.md §10): a computer that was a runner
// before this version becomes one with `global → host` and `default → host`,
// so it behaves exactly as it did and the person does nothing. The caller
// closes both stores.
export function openRoutes(dataDir) {
  const routes = new RoutesStore(join(dataDir, ROUTES_FILE));
  const runner = new RunnerStore(join(dataDir, RUNNER_FILE));
  try {
    const host = runner.host();
    if (host) routes.followEverything(hostOwner(host.fingerprint));
    return routes;
  } catch (error) {
    routes.close();
    throw error;
  } finally {
    runner.close();
  }
}


// Where one call goes, decided before anything is sent. A task token names the
// computer that entered that task, so its checkpoint goes back there whatever
// the routes became meanwhile; everything else goes by the folder's scope.
// Answers { scope, owner }.
export function routeOfCall(routes, { projectPath = null, taskContextToken = null } = {}, options) {
  const scope = callScope(projectPath, options);
  const entered = routes.taskOwner(taskContextToken);
  return { scope, owner: entered ?? routes.owner(scope), byTask: Boolean(entered) };
}

// What `fuli routes list` prints, and what the console shows.
export function describeRoutes(routes, { hostName = null, hostFingerprint = null } = {}) {
  const listed = routes.all();
  const rows = listed.length ? listed
    : [{ scope: GLOBAL_SCOPE, owner: LOCAL_OWNER, replica: false, replicaSyncedAt: null, updatedAt: null },
      { scope: DEFAULT_SCOPE, owner: LOCAL_OWNER, replica: false, replicaSyncedAt: null, updatedAt: null }];
  return rows.map((row) => ({ ...row,
    ownerName: row.owner === LOCAL_OWNER ? 'this computer'
      : hostFingerprint && row.owner === hostOwner(hostFingerprint) ? (hostName ?? 'the paired host')
        : `a host this computer is no longer paired with (${row.owner})` }));
}
