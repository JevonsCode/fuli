import { closeSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Read-only helpers for locating a client's JSONL session log on disk.

const WINDOW_BYTES = 256 * 1024;

export function listDirectory(directory) {
  try { return readdirSync(directory); } catch { return []; }
}

// Newest-first search for a file ending in `suffix`, at most `depth` levels down.
export function findFile(directory, suffix, depth) {
  for (const entry of listDirectory(directory).sort().reverse()) {
    const path = join(directory, entry);
    if (entry.endsWith(suffix)) return path;
    if (depth > 0 && !entry.includes('.')) {
      const found = findFile(path, suffix, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

// The first non-empty string `pick` returns for a JSON line near the start of the log.
export function firstField(file, pick) {
  for (const line of readWindow(file, 'start').lines) {
    try { const value = pick(JSON.parse(line)); if (typeof value === 'string' && value) return value; } catch { /* partial line */ }
  }
  return null;
}

// The JSON lines near the end of the log, oldest first, and whether they are the whole log.
export function lastEntries(file) {
  const { lines, whole } = readWindow(file, 'end');
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return { entries, whole };
}

function readWindow(file, edge) {
  const handle = openSync(file, 'r');
  try {
    const { size } = fstatSync(handle);
    const buffer = Buffer.alloc(Math.min(WINDOW_BYTES, size));
    const length = readSync(handle, buffer, 0, buffer.length, edge === 'end' ? size - buffer.length : 0);
    return { lines: buffer.subarray(0, length).toString('utf8').split('\n'), whole: length === size };
  } finally { closeSync(handle); }
}
