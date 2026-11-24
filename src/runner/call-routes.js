import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import { resolvePersonalProjectPath } from '../graphiti/project-path-context.js';
import { resultValue } from './offline-calls.js';
import { DEFAULT_SCOPE, GLOBAL_SCOPE, hostOwner, LOCAL_OWNER, PROJECT_PREFIX, ROUTES_FILE, RoutesStore } from './routes-store.js';
import { RUNNER_FILE, RunnerStore } from './runner-store.js';

// Which scope a call belongs to, and therefore which computer answers it
// (docs/runner-roles-design.md §4.1). Decided here, on this computer, before
// anything is sent:
//
//   no folder (global tools, the roundtable, a listing)  →  `global`
//   a folder of a project                                →  `project:<id>`
//   any other folder                                     →  `default`
//
// Which project a folder is, is the host's answer, by the host's own rules,
// never a second set of them here: first what the host itself last resolved
// for this very folder (the project a task entry there named, kept on this
// computer, which covers the origin-remote rules that need the host's project
// records); then, for any other folder, the host's resolver itself
// (project-path-context.js resolvePersonalProjectPath: the repository root,
// a worktree's original repository, the folder's name, a child project's
// marker), asked about the projects this computer knows of. A path the
// resolver refuses (relative, not a folder) belongs to no project.
//
// known: [{ id, folder }], the projects this computer knows of, and a folder
// the host resolved to each (null when it knows the project only by a route).
export function callScope(projectPath, { known = [], resolve = resolvePersonalProjectPath, realPath = realFolder } = {}) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return GLOBAL_SCOPE;
  const asked = realPath(projectPath);
  if (!asked) return DEFAULT_SCOPE;
  // What the host itself answered for this very folder; any other folder is the resolver's to answer.
  const byHost = known.find((project) => project.folder && realPath(project.folder) === asked);
  if (byHost) return `project:${byHost.id}`;
  let resolution;
  try { resolution = resolve(projectPath, [...new Set(known.map((project) => project.id))].map((id) => ({ project_id: id }))); }
  catch { return DEFAULT_SCOPE; }
  return resolution?.status === 'matched' && resolution.personalProjectId ? `project:${resolution.personalProjectId}` : DEFAULT_SCOPE;
}

// The projects this computer knows of: each folder a task entry was answered
// for, with the project the host named there, and each project with a route.
export function knownProjects(store, routes) {
  const known = [];
  for (const { key, body } of store.taskEntries()) {
    const value = resultValue(body);
    const id = value?.context?.personal_project_id;
    const folder = /^entry:[^:]+:(.+)$/.exec(key)?.[1] ?? null;
    if (typeof id === 'string' && id && folder) known.push({ id, folder });
  }
  for (const { scope } of routes.all()) {
    if (scope.startsWith(PROJECT_PREFIX)) known.push({ id: scope.slice(PROJECT_PREFIX.length), folder: null });
  }
  return known;
}


// A folder as the host's resolver opens it: absolute, existing, its real path. Anything else is no folder.
function realFolder(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  try {
    const real = realpathSync.native(resolvePath(path));
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
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
// Answers { scope, owner, issuer, byTask }.
// issuer: the start of the fingerprint of the FULI that issued the call's task
// token, read off the token itself (task-issuer.js); else the token's owner as
// remembered here, for a token passed without it.
export function routeOfCall(routes, { projectPath = null, taskContextToken = null } = {}, { issuer = null, ...options } = {}) {
  const scope = callScope(projectPath, options);
  if (issuer) return { scope, owner: null, issuer, byTask: true };
  const entered = routes.taskOwner(taskContextToken);
  return { scope, owner: entered ?? routes.owner(scope), issuer: null, byTask: Boolean(entered) };
}

// What `fuli routes list` prints, and what the console shows.
export function describeRoutes(routes, { hostName = null, hostFingerprint = null } = {}) {
  const listed = routes.all();
  const rows = listed.length ? listed
    : [{ scope: GLOBAL_SCOPE, owner: LOCAL_OWNER, replica: false, replicaSyncedAt: null, updatedAt: null },
      { scope: DEFAULT_SCOPE, owner: LOCAL_OWNER, replica: false, replicaSyncedAt: null, updatedAt: null }];
  return rows.map((row) => ({ ...row, ...whoOwns(row.owner, { hostName, hostFingerprint }) }));
}

// Each project this computer knows of, and which computer it belongs to now:
// its own route, else `default`'s. byDefault: no route of its own names it, so
// it goes wherever new folders go. What `fuli routes list`, `fuli status` and
// the console show as 「本机 / 主机 …」 per project.
export function projectOwners(routes, store, { hostName = null, hostFingerprint = null } = {}) {
  const routed = new Set(routes.all().map((row) => row.scope));
  const ids = [...new Set(knownProjects(store, routes).map((project) => project.id))].sort();
  return ids.map((id) => {
    const scope = `${PROJECT_PREFIX}${id}`;
    return { id, scope, byDefault: !routed.has(scope), ...whoOwns(routes.owner(scope), { hostName, hostFingerprint }) };
  });
}

// Whose a scope is, as people read it. where: `local`, `host` (the paired
// host) or `unpaired` (a host this computer is no longer paired with).
function whoOwns(owner, { hostName, hostFingerprint }) {
  if (owner === LOCAL_OWNER) return { where: 'local', ownerName: 'this computer' };
  if (hostFingerprint && owner === hostOwner(hostFingerprint)) return { where: 'host', ownerName: hostName ?? 'the paired host' };
  return { where: 'unpaired', ownerName: `a host this computer is no longer paired with (${owner})` };
}
