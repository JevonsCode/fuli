// A repository's identity by its origin remote, read from Git's own files as
// text: a separate clone under another folder name is still the same project.

const REPOSITORY_SOURCE_KINDS = new Set(['repository', 'frontend_repository', 'backend_repository']);
const SECTION = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/;
const URL_ENTRY = /^\s*url\s*=\s*(.*)$/i;
const URL_FORM = /^(?:[a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)(?::\d*)?(\/.*)$/i;
// scp-like ssh, host:path. A one-letter host is a Windows drive, not a remote.
const SCP_FORM = /^(?:[^@/]+@)?([^/:]{2,}):(?!\/\/)(.+)$/;

// The gitdir a .git file points to (a worktree, a submodule); null for a .git directory.
export function linkedGitDirectory(gitMarkerPath, { readText, pathApi }) {
  const gitDirectory = /^gitdir:\s*(.+)$/im.exec(readText(gitMarkerPath))?.[1]?.trim();
  if (!gitDirectory) return null;
  return pathApi.isAbsolute(gitDirectory)
    ? pathApi.normalize(gitDirectory)
    : pathApi.resolve(pathApi.dirname(gitMarkerPath), gitDirectory);
}

// The normalised origin URL of the repository rooted at repositoryRoot, or null.
// A worktree's remotes live in the common directory its commondir names.
export function originRemoteKey(repositoryRoot, { readText, pathApi }) {
  const gitMarker = pathApi.join(repositoryRoot, '.git');
  const gitDirectory = linkedGitDirectory(gitMarker, { readText, pathApi }) ?? gitMarker;
  const commonDirectory = readText(pathApi.join(gitDirectory, 'commondir')).trim();
  const configDirectory = commonDirectory ? pathApi.resolve(gitDirectory, commonDirectory) : gitDirectory;
  const url = originUrl(readText(pathApi.join(configDirectory, 'config')));
  return url ? remoteKey(url) : null;
}

// The registered projects whose profile records a repository source at remote.
export function projectsWithRemote(projects, remote) {
  return projects.filter(project => (project.profile?.sources ?? []).some(source =>
    REPOSITORY_SOURCE_KINDS.has(source.kind) && typeof source.uri === 'string' && remoteKey(source.uri) === remote));
}

// host/path with scheme, user, port, trailing slashes and .git removed and the
// host lowercased, so ssh and https forms of one repository are equal. Local
// paths and file URLs name no shared repository and give null.
function remoteKey(url) {
  const value = url.trim();
  if (/^file:/i.test(value)) return null;
  const parts = URL_FORM.exec(value) ?? SCP_FORM.exec(value);
  if (!parts) return null;
  const repositoryPath = parts[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  return repositoryPath ? `${parts[1].toLowerCase()}/${repositoryPath}` : null;
}

// The first url of [remote "origin"] in a Git config file's text.
function originUrl(config) {
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    const section = SECTION.exec(line);
    let entry = line;
    if (section) {
      inOrigin = section[1].toLowerCase() === 'remote' && section[2] === 'origin';
      entry = section[3];
    }
    const url = inOrigin && URL_ENTRY.exec(entry)?.[1];
    if (url) return configValue(url);
  }
  return null;
}

function configValue(raw) {
  let value = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '\\' && index + 1 < raw.length) value += raw[++index];
    else if (character === '"') quoted = !quoted;
    else if (!quoted && (character === '#' || character === ';')) break;
    else value += character;
  }
  return value.trim();
}
