import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';

import { ApplicationError } from '../app/application-error.js';

// The person's own AI reads an old-data item read-only (rec#80 group B): the
// files it holds, then one text or JSON file. A path is never resolved from
// what the caller sent: it must be one of the files listed for that item, so
// nothing outside the backup can be named, links are not followed and a
// directory is not read. A file with a NUL byte in what is read, or a known
// binary extension (SQLite, Neo4j dump), is refused instead of shown.

const MAX_LISTED_FILES = 200;
const MAX_READ_BYTES = 32 * 1024;
const BINARY_EXTENSIONS = /\.(sqlite|sqlite-wal|sqlite-shm|db|dump|gz|zip)$/i;

// item: an inventory item (targets: its absolute files or directories).
export function listBackupFiles(item) {
  const files = itemFiles(item);
  return { files: files.slice(0, MAX_LISTED_FILES).map(({ path, bytes }) => ({ path, bytes })),
    truncated: files.length > MAX_LISTED_FILES };
}

export function readBackupFile(item, path) {
  const file = itemFiles(item).find((entry) => entry.path === path);
  if (!file) {
    throw new ApplicationError('old_data_file_not_found', `${item.id} holds no file ${path}; list its files first`,
      { status: 404 });
  }
  if (BINARY_EXTENSIONS.test(path)) throw binary(item, path);
  const buffer = readPrefix(file.absolute, Math.min(file.bytes, MAX_READ_BYTES));
  if (buffer.includes(0)) throw binary(item, path);
  const truncated = file.bytes > buffer.length;
  // A streaming decode holds back a character the cut split instead of showing half of it.
  return { id: item.id, path, bytes: file.bytes, truncated,
    content: new TextDecoder().decode(buffer, { stream: truncated }) };
}

function binary(item, path) {
  return new ApplicationError('old_data_binary', `${item.id}: ${path} is not a text file and is not shown`,
    { status: 415 });
}

// A single directory's files are named inside it; a file, or one of several, by its name.
function itemFiles(item) {
  const inside = item.targets.length === 1 && isDirectory(item.targets[0]);
  return item.targets.flatMap((target) => walk(target, inside ? '' : basename(target)));
}

// Files only, depth first, in name order; links and anything that is not a
// regular file or directory are skipped.
function walk(absolute, path) {
  let stats;
  try { stats = lstatSync(absolute); } catch { return []; }
  if (stats.isFile()) return [{ absolute, path, bytes: stats.size }];
  if (!stats.isDirectory()) return [];
  return readdirSync(absolute).sort().flatMap((name) => walk(join(absolute, name), path ? `${path}/${name}` : name));
}

function isDirectory(path) {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function readPrefix(path, length) {
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(path, 'r');
  try {
    return buffer.subarray(0, readSync(descriptor, buffer, 0, length, 0));
  } finally {
    closeSync(descriptor);
  }
}
