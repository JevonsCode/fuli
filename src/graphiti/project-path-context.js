import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs';
import path from 'node:path';

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
  if (
    typeof projectPath !== 'string'
    || !projectPath.trim()
    || !pathApi.isAbsolute(projectPath)
  ) {
    throw new TypeError('projectPath must be an existing absolute directory');
  }

  const currentPath = realPath(pathApi.resolve(projectPath));
  if (!fileExists(currentPath) || !isDirectory(currentPath)) {
    throw new TypeError('projectPath must be an existing absolute directory');
  }

  const projectIds = new Set(
    projects
      .map(({ project_id: projectId }) => projectId)
      .filter((projectId) => safeProjectId(projectId, pathApi))
  );
  const repositoryRoot = findRepositoryRoot(currentPath, {
    fileExists,
    pathApi
  });
  if (repositoryRoot) {
    const repositoryId = pathApi.basename(repositoryRoot);
    if (projectIds.has(repositoryId)) {
      return matched(repositoryId, 'repository_root');
    }
    const worktreeId = worktreeOriginProjectId(
      pathApi.join(repositoryRoot, '.git'),
      { readText, pathApi }
    );
    if (worktreeId && projectIds.has(worktreeId)) {
      return matched(worktreeId, 'git_worktree_origin');
    }
  }

  const directoryId = pathApi.basename(currentPath);
  if (projectIds.has(directoryId)) {
    return matched(directoryId, 'directory_name');
  }

  const childMatches = [...projectIds].filter((projectId) => (
    CHILD_PROJECT_MARKERS.some((marker) =>
      fileExists(pathApi.join(currentPath, projectId, marker))
    )
  ));
  if (childMatches.length === 1) {
    return matched(childMatches[0], 'workspace_child');
  }
  if (childMatches.length > 1) {
    return unresolved('ambiguous', { candidateCount: childMatches.length });
  }
  return unresolved('unmatched');
}

export function findRepositoryRoot(projectPath, {
  fileExists = existsSync,
  pathApi = path
} = {}) {
  let current = pathApi.resolve(projectPath);
  const filesystemRoot = pathApi.parse(current).root;
  while (true) {
    if (fileExists(pathApi.join(current, '.git'))) return current;
    if (current === filesystemRoot) return null;
    const parent = pathApi.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function worktreeOriginProjectId(gitMarkerPath, {
  readText,
  pathApi
}) {
  const source = readText(gitMarkerPath);
  const gitDirectory = /^gitdir:\s*(.+)$/im.exec(source)?.[1]?.trim();
  if (!gitDirectory) return null;
  const resolved = pathApi.isAbsolute(gitDirectory)
    ? pathApi.normalize(gitDirectory)
    : pathApi.resolve(pathApi.dirname(gitMarkerPath), gitDirectory);
  const marker = /[\\/]\.git[\\/]worktrees[\\/]/i.exec(resolved);
  if (!marker) return null;
  return pathApi.basename(resolved.slice(0, marker.index));
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
