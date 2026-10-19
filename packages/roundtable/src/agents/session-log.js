import { closeSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Read-only helpers for locating a client's JSONL session log on disk.

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
  const handle = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const length = readSync(handle, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, length).toString('utf8').split('\n')) {
      try { const value = pick(JSON.parse(line)); if (typeof value === 'string' && value) return value; } catch { /* partial line */ }
    }
    return null;
  } finally { closeSync(handle); }
}
