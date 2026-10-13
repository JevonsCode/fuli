import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE_PATTERN = /^task-(guidance-[0-9a-f]{16}|preferences-[0-9a-f]{12})\.md$/;
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

// Content-addressed so identical guidance keeps one stable path across turns,
// sessions and Agents; a changed rule set produces a new file.
export function writeGuidanceFile(directory, markdown, { now = Date.now() } = {}) {
  const digest = createHash('sha256').update(markdown).digest('hex').slice(0, 16);
  return { path: writeVerifiedFile(directory, `task-guidance-${digest}.md`, markdown, { now }), digest };
}

// The caller names the file by the digest it already uses for the content. A
// path is returned only after the file on disk matches the expected content.
export function writeVerifiedFile(directory, fileName, markdown, { now = Date.now() } = {}) {
  if (!FILE_PATTERN.test(fileName)) throw new TypeError('Unsupported task context file name');
  const path = join(directory, fileName);
  if (readMatching(path, markdown)) {
    touch(path, now);
    pruneStale(directory, path, now);
    return path;
  }
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, markdown, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    // A concurrent hook may have written the same content first.
    rmSync(temporary, { force: true });
    if (!readMatching(path, markdown)) throw error;
  }
  if (!readMatching(path, markdown)) throw new Error('Task context file does not match its content');
  pruneStale(directory, path, now);
  return path;
}

function readMatching(path, markdown) {
  try {
    return statSync(path).isFile() && readFileSync(path, 'utf8') === markdown;
  } catch {
    return false;
  }
}

function touch(path, now) {
  try { utimesSync(path, new Date(now), new Date(now)); } catch { /* best effort */ }
}

// Older versions stay readable for open sessions for a bounded period.
function pruneStale(directory, current, now) {
  let names;
  try { names = readdirSync(directory); } catch { return; }
  for (const name of names) {
    const path = join(directory, name);
    if (path === current || !FILE_PATTERN.test(name)) continue;
    try {
      if (now - statSync(path).mtimeMs > RETAIN_MS) rmSync(path, { force: true });
    } catch { /* another hook may have removed it */ }
  }
}
