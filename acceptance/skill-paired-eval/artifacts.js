// Writes the scenario's baseline files and the artifacts a live client returned
// as JSON. Every path is validated first, stays inside the temporary workspace,
// and is refused if it would travel through a symbolic link. All writes are
// bounded so one run cannot fill the result directory or the disk.
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { safeRelativePath } from './scenario.js';

export const MAX_ARTIFACT_FILES = 100;
export const MAX_ARTIFACT_BYTES = 512 * 1024;

function inside(workspace, absolute) {
  const root = resolve(workspace);
  return absolute === root || absolute.startsWith(`${root}${sep}`);
}

function refuseLinks(workspace, path) {
  const target = resolve(workspace, path);
  let current = workspace;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing to write through a symbolic link: ${path}`);
    if (current !== target && !stat.isDirectory()) throw new Error(`Refusing to write under a non-directory: ${path}`);
  }
  try {
    const stat = lstatSync(target);
    if (!stat.isFile()) throw new Error(`Refusing to replace a non-regular file: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Returns the written paths and bytes. Throws before writing a later file when
// the map itself is outside the bounds; earlier files may already exist.
export function writeArtifactFiles(workspace, files, { label = 'artifacts',
  maxFiles = MAX_ARTIFACT_FILES, maxBytes = MAX_ARTIFACT_BYTES, platform = process.platform } = {}) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new TypeError(`${label} must be an object of relative path to text`);
  }
  const entries = Object.entries(files);
  if (entries.length > maxFiles) throw new TypeError(`${label} lists more than ${maxFiles} files`);
  let bytes = 0;
  const written = [];
  for (const [raw, content] of entries) {
    const path = safeRelativePath(raw, `${label} path`, { platform });
    if (typeof content !== 'string') throw new TypeError(`${label}.${path} must be text`);
    bytes += Buffer.byteLength(content, 'utf8');
    if (bytes > maxBytes) throw new TypeError(`${label} is larger than ${maxBytes} bytes`);
    const absolute = resolve(workspace, path);
    if (!inside(workspace, absolute)) throw new TypeError(`${label}.${path} leaves the workspace`);
    refuseLinks(workspace, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    written.push(path);
  }
  return { written, bytes };
}
