import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { InvalidInputError } from '../app/application-error.js';
import { repositoryProjectDraft } from './project-brief.js';
import { CHILD_PROJECT_MARKERS, findRepositoryRoot } from './project-path-context.js';
import { linkedGitDirectory, localOriginRemoteKey, originRemoteSource } from './repository-remote.js';

// A folder on another computer (a runner, docs/runner.md) as the facts the
// project path resolver reads: which paths exist and are folders, and the few
// Git files it reads as text. describeWorkspace collects them where the folder
// is; workspaceFileSystem answers the resolver from them where the folder is
// not, so a remote folder is matched by exactly the rules of a local one.
// The origin remote travels as its normalised key only: never a credential.
const MAX_CHILDREN = 500;
const MAX_FACTS_BYTES = 48 * 1024;
const FACTS_VERSION = 1;

export function describeWorkspace(projectPath, {
  realPath = (value) => realpathSync.native(value),
  isDirectory = defaultIsDirectory,
  fileExists = existsSync,
  readText = readTextOrEmpty,
  listChildren = defaultListChildren,
  remoteKey = localOriginRemoteKey,
  draftOf = repositoryProjectDraft,
  sourceOf = originRemoteSource,
  platform = process.platform
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return (async () => {
    if (typeof projectPath !== 'string' || !pathApi.isAbsolute(projectPath)) {
      throw new InvalidInputError('projectPath must be an existing absolute directory');
    }
    let current;
    try { current = realPath(pathApi.resolve(projectPath)); } catch { current = null; }
    if (!current || !isDirectory(current)) {
      throw new InvalidInputError('projectPath must be an existing absolute directory');
    }
    const entries = { [current]: 'dir' };
    const texts = {};
    const root = findRepositoryRoot(current, { fileExists, pathApi });
    if (root) {
      const marker = pathApi.join(root, '.git');
      entries[marker] = isDirectory(marker) ? 'dir' : 'file';
      const gitDirectory = linkedGitDirectory(marker, { readText, pathApi });
      if (gitDirectory) texts[marker] = `gitdir: ${gitDirectory}\n`;
      const key = remoteKey(root);
      if (key) {
        // The resolver reads the config the common directory names; the facts
        // hold only an origin it normalises back to the same key.
        const configDirectory = gitDirectory ?? marker;
        const commonDirectory = readText(pathApi.join(configDirectory, 'commondir')).trim();
        if (commonDirectory) texts[pathApi.join(configDirectory, 'commondir')] = `${commonDirectory}\n`;
        const configPath = pathApi.join(commonDirectory ? pathApi.resolve(configDirectory, commonDirectory) : configDirectory, 'config');
        texts[configPath] = `[remote "origin"]\n\turl = https://${key}\n`;
      }
    }
    const children = {};
    for (const child of listChildren(current).slice(0, MAX_CHILDREN)) {
      for (const name of CHILD_PROJECT_MARKERS) {
        const candidate = pathApi.join(current, child, name);
        if (fileExists(candidate)) children[candidate] = 'file';
      }
    }
    const draft = root ? await draftOf({ projectPath: current }) : null;
    const facts = { version: FACTS_VERSION, platform, requestedPath: projectPath, path: current,
      entries: { ...entries, ...children }, texts, draft: draft ?? null, originSource: (root && sourceOf(root)) || null };
    // A folder with very many child projects keeps only itself and its repository.
    return Buffer.byteLength(JSON.stringify(facts)) > MAX_FACTS_BYTES ? { ...facts, entries } : facts;
  })();
}

// The facts a runner sent, checked once at the boundary.
export function parseWorkspaceFacts(value) {
  const object = (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate);
  if (!object(value) || value.version !== FACTS_VERSION || !['darwin', 'linux', 'win32'].includes(value.platform)
    || typeof value.path !== 'string' || typeof value.requestedPath !== 'string'
    || !object(value.entries) || !object(value.texts)
    || Buffer.byteLength(JSON.stringify(value)) > MAX_FACTS_BYTES) {
    throw new InvalidInputError('workspace facts are not in the runner format');
  }
  const pathApi = value.platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(value.path) || !pathApi.isAbsolute(value.requestedPath)
    || Object.values(value.entries).some((kind) => kind !== 'dir' && kind !== 'file')
    || Object.values(value.texts).some((text) => typeof text !== 'string')) {
    throw new InvalidInputError('workspace facts are not in the runner format');
  }
  return value;
}

// The resolver's file reads, answered from facts.
export function workspaceFileSystem(facts) {
  const pathApi = facts.platform === 'win32' ? path.win32 : path.posix;
  const resolvedRequest = pathApi.resolve(facts.requestedPath);
  return {
    pathApi,
    realPath: (value) => (value === resolvedRequest || value === facts.requestedPath ? facts.path : value),
    fileExists: (value) => Object.hasOwn(facts.entries, value),
    isDirectory: (value) => facts.entries[value] === 'dir',
    readText: (value) => facts.texts[value] ?? ''
  };
}

function defaultIsDirectory(value) {
  try { return statSync(value).isDirectory(); } catch { return false; }
}

function defaultListChildren(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  } catch { return []; }
}

function readTextOrEmpty(value) {
  try { return readFileSync(value, 'utf8'); } catch { return ''; }
}
