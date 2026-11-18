import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// The Git branch a session's folder is on, for where its conversation was
// written. Read from the files, never by starting Git, so a task entry stays
// fast: the nearest .git up from the folder (a directory, or a worktree's
// `gitdir:` file), then its HEAD. A detached HEAD, a folder outside Git or
// anything unreadable is unknown (null), never a guess.
const MAX_LEVELS = 12;

export async function workingBranch(folder) {
  if (typeof folder !== 'string' || !folder.trim()) return null;
  try {
    let current = resolve(folder);
    for (let level = 0; level < MAX_LEVELS; level += 1) {
      const gitDir = await gitDirectory(join(current, '.git'));
      if (gitDir) return branchOf(await readFile(join(gitDir, 'HEAD'), 'utf8'));
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  } catch {
    // Ignore: an unreadable repository leaves the branch unknown.
  }
  return null;
}

async function gitDirectory(path) {
  let info;
  try { info = await stat(path); } catch { return null; }
  if (info.isDirectory()) return path;
  const pointer = /^gitdir:\s*(.+)\s*$/m.exec(await readFile(path, 'utf8'))?.[1]?.trim();
  if (!pointer) return null;
  return isAbsolute(pointer) ? pointer : resolve(dirname(path), pointer);
}

function branchOf(head) {
  const ref = /^ref:\s*refs\/heads\/(.+)\s*$/.exec(head.trim())?.[1];
  return ref && ref.length <= 255 ? ref : null;
}
