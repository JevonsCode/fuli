import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs';
import path from 'node:path';
import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { hostPathOfCallerPath } from '../system/platform-path.js';
import { originRemoteKey, projectsWithRemote } from './repository-remote.js';

// Says what to pass, never the path the caller sent.
const INVALID_PATH_MESSAGE = 'projectPath must be an existing absolute directory. '
  + 'Pass the absolute path of the current working directory.';

const UNSUPPORTED_PATH_MESSAGE = 'projectPath is a WSL or POSIX path this Windows FULI cannot open. '
  + 'Pass the Windows path of the current working directory, such as C:\\Users\\name\\project; '
  + '/mnt/<drive>/ paths are translated.';

const CHILD_PROJECT_MARKERS = Object.freeze([
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod'
]);

export function resolvePersonalProjectPath(projectPath, projects, {
  fileExists = existsSync,
  isDirectory = defaultIsDirectory,
  realPath = defaultRealPath,
  readText = defaultReadText,
  pathApi = path
} = {}) {
  if (projectPath === undefined || projectPath === null) {
    return unresolved('not_provided');
  }
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new InvalidInputError(INVALID_PATH_MESSAGE);
  }
  const hostPath = hostProjectPath(projectPath, pathApi);
  if (!pathApi.isAbsolute(hostPath)) {
    throw new InvalidInputError(INVALID_PATH_MESSAGE);
  }

  const currentPath = realPath(pathApi.resolve(hostPath));
  if (!fileExists(currentPath) || !isDirectory(currentPath)) {
    throw new InvalidInputError(INVALID_PATH_MESSAGE);
  }

  const registered = projects
    .filter(project => project.scope_type !== 'temporary' && project.scopeType !== 'temporary')
    .filter(({ project_id: projectId }) => safeProjectId(projectId, pathApi));
  const projectIds = new Set(registered.map(({ project_id: projectId }) => projectId));
  const repositoryRoot = findRepositoryRoot(currentPath, {
    fileExists,
    pathApi
  });
  // A checkout's basename is not a repository identity. Unknown remotes stay
  // unresolved instead of registering a new project for each clone directory.
  if (repositoryRoot) return remoteProject(repositoryRoot, registered, { readText, pathApi });

  const childMatches = [...projectIds].filter((projectId) => (
    CHILD_PROJECT_MARKERS.some((marker) =>
      fileExists(pathApi.join(currentPath, projectId, marker))
    )
  ));
  if (childMatches.length === 1) {
    return unresolved('unmatched', { reason: 'workspace_requires_repository_path' });
  }
  if (childMatches.length > 1) {
    return unresolved('ambiguous', { candidateCount: childMatches.length });
  }
  return unresolved('unmatched', { reason: 'no_git_repository' });
}

export function findRepositoryRoot(projectPath, {
  fileExists = existsSync,
  pathApi = path
} = {}) {
  let current = pathApi.resolve(hostProjectPath(projectPath, pathApi));
  const filesystemRoot = pathApi.parse(current).root;
  while (true) {
    if (fileExists(pathApi.join(current, '.git'))) return current;
    if (current === filesystemRoot) return null;
    const parent = pathApi.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// The caller's directory as this host opens it (rec#48), before any existence
// check or project match, so a translated WSL path is checked exactly like the
// native path it names. A path this host cannot open says what to pass instead.
function hostProjectPath(projectPath, pathApi) {
  const hostPath = hostPathOfCallerPath(projectPath, pathApi);
  if (hostPath === null) throw new ApplicationError('project_path_unsupported', UNSUPPORTED_PATH_MESSAGE);
  return hostPath;
}

// A clone under another folder name: its origin URL equals exactly one
// project's recorded repository URL.
function remoteProject(repositoryRoot, projects, { readText, pathApi }) {
  const remote = originRemoteKey(repositoryRoot, { readText, pathApi });
  if (!remote) return unresolved('unmatched', { reason: 'repository_remote_unavailable' });
  const matches = projectsWithRemote(projects, remote);
  if (matches.length === 1) return matched(matches[0].project_id, 'git_remote');
  if (matches.length > 1) return unresolved('ambiguous', {
    reason: 'repository_remote_ambiguous', candidateCount: matches.length
  });
  return unresolved('unmatched', { reason: 'repository_remote_unregistered' });
}

function safeProjectId(projectId, pathApi) {
  return typeof projectId === 'string'
    && projectId.length > 0
    && projectId !== '.'
    && projectId !== '..'
    && pathApi.basename(projectId) === projectId;
}

function matched(personalProjectId, basis) {
  return {
    status: 'matched',
    basis,
    personalProjectId
  };
}

function unresolved(status, extra = {}) {
  return {
    status,
    basis: null,
    personalProjectId: null,
    ...extra
  };
}

function defaultReadText(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function defaultIsDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function defaultRealPath(filePath) {
  try {
    return realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}
