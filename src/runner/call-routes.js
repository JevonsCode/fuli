import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import { findRepositoryRoot, resolvePersonalProjectPath } from '../graphiti/project-path-context.js';
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
// for this folder (the project a task entry there named, kept on this computer,
// which covers the origin-remote rules that need the host's project records);
// then, for a folder the host never answered, the host's resolver itself
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
  // The host resolves a folder by its repository: another folder of the same repository is the same project.
  const root = repositoryOf(asked);
  const byHost = known.find((project) => {
    const folder = project.folder && realPath(project.folder);
    return folder && (folder === asked || (root && repositoryOf(folder) === root));
  });
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

function repositoryOf(folder) {
  try { return findRepositoryRoot(folder); } catch { return null; }
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

function resultValue(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  try { return JSON.parse(result?.content?.find((item) => item.type === 'text')?.text ?? 'null'); } catch { return null; }
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
