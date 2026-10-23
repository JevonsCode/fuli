import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { sha256Bytes, sha256File } from '../security/digest.js';
import { appConflict, appNotFound } from './errors.js';

const DELETING = '.deleting-';

// Each app's own data directory. FULI creates it when an instance first starts,
// measures, exports and finally deletes it; the app writes inside it.
// Every caller holds the app's write gate and owner lease (rec#7 D-28.17,
// D-28.21) and checks its fence right before each of these operations.

export function ensureDataDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

// Counts regular files without following links, so a link never makes another
// directory look like this app's data.
export function dataUsage(directory) {
  let bytes = 0;
  let files = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        bytes += lstatSync(child).size;
        files += 1;
      }
    }
  };
  try {
    walk(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { bytes, files };
}

// The content revision a data deletion ticket binds (rec#7 D-28.14): one line
// per entry, sorted by path, `path\0size\0sha256(content)` for a file and
// `path\0link\0target` for a link, which is never followed. Sizes and times
// alone would miss a same-size rewrite; this does not.
export async function dataDigest(directory) {
  const lines = [];
  let bytes = 0;
  let files = 0;
  const walk = async (path, prefix) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) lines.push(`${relative}\0link\0${await readlink(child)}`);
      else if (entry.isDirectory()) await walk(child, relative);
      else if (entry.isFile()) {
        const { size } = await lstat(child);
        lines.push(`${relative}\0${size}\0${await sha256File(child)}`);
        bytes += size;
        files += 1;
      }
    }
  };
  try {
    await walk(directory, '');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  lines.sort();
  return { files, bytes, dataDigest: sha256Bytes(lines.join('\n')) };
}

export function exportData(directory, destination) {
  if (!existsSync(directory)) throw appNotFound('app_data_not_found', 'This app has no data directory to export');
  if (existsSync(destination)) throw appConflict('export_destination_exists', 'Export into a new directory; FULI never overwrites one');
  cpSync(directory, destination, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  return dataUsage(destination);
}

// The directory a data deletion moves the data to before removing it.
export function deletingDirectoryOf(directory, deletionId) {
  return `${directory}${DELETING}${deletionId}`;
}

// Directories an interrupted deletion left beside the data directory.
export function deletingDirectories(directory) {
  const prefix = `${basename(directory)}${DELETING}`;
  try {
    return readdirSync(dirname(directory)).filter((name) => name.startsWith(prefix)).sort()
      .map((name) => join(dirname(directory), name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

// One atomic rename; false when there was no data directory to move.
export function moveDataAside(directory, deleting) {
  try {
    renameSync(directory, deleting);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function removeDataDirectory(directory) {
  rmSync(directory, { recursive: true, force: true });
}
