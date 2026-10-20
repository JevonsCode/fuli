import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { appConflict, appNotFound } from './errors.js';

// Each app's own data directory. FULI creates, measures, exports and finally
// deletes it, but never writes inside it: versions come and go around the data.

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

export function exportData(directory, destination) {
  if (!existsSync(directory)) throw appNotFound('app_data_not_found', 'This app has no data directory to export');
  if (existsSync(destination)) throw appConflict('export_destination_exists', 'Export into a new directory; FULI never overwrites one');
  cpSync(directory, destination, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  return dataUsage(destination);
}

export function removeDataDirectory(directory) {
  rmSync(directory, { recursive: true, force: true });
}
