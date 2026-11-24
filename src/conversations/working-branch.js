import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// The Git branch a session's folder is on, for where its conversation was
// written. Read from the files, never by starting Git, so a task entry stays
// fast: the nearest .git up from the folder (a directory, or a worktree's
// `gitdir:` file), then its HEAD. A detached HEAD, a folder outside Git or
// anything unreadable is unknown (null), never a guess.
const MAX_LEVELS = 12;
// A slow or offline drive never holds up a task entry: past this the branch is unknown.
const TIME_LIMIT_MS = 250;

export async function workingBranch(folder, options = {}) {
  return (await workingRepository(folder, options))?.branch ?? null;
}

// The branch and the repository folder it belongs to ({ branch, root }), so two
// repositories of one project on a same-named branch are told apart (rec issue
// 147). null when the folder is outside Git, unreadable or too slow; a detached
// HEAD keeps its root with branch null.
export function workingRepository(folder, { timeLimitMs = TIME_LIMIT_MS } = {}) {
  if (typeof folder !== 'string' || !folder.trim()) return Promise.resolve(null);
  return withinTimeLimit(readRepository(folder), timeLimitMs);
}

// The answer, or null once the time limit passes first.
export function withinTimeLimit(answer, timeLimitMs) {
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeLimitMs); timer.unref?.(); });
  return Promise.race([answer, late]).finally(() => clearTimeout(timer));
}

async function readRepository(folder) {
  try {
    let current = resolve(folder);
    for (let level = 0; level < MAX_LEVELS; level += 1) {
      const gitDir = await gitDirectory(join(current, '.git'));
      if (gitDir === BROKEN) return null;
      if (gitDir) return { branch: branchOf(await readFile(join(gitDir, 'HEAD'), 'utf8')), root: current };
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  } catch {
    // Ignore: an unreadable repository leaves the branch unknown.
  }
  return null;
}

const BROKEN = Symbol('broken .git file');

async function gitDirectory(path) {
  let info;
  try { info = await stat(path); } catch { return null; }
  if (info.isDirectory()) return path;
  const pointer = /^gitdir:\s*(.+)\s*$/m.exec(await readFile(path, 'utf8'))?.[1]?.trim();
  // A .git file that points nowhere ends the walk: a parent repository's branch is not this folder's.
  if (!pointer) return BROKEN;
  return isAbsolute(pointer) ? pointer : resolve(dirname(path), pointer);
}

function branchOf(head) {
  const ref = /^ref:\s*refs\/heads\/(.+)\s*$/.exec(head.trim())?.[1];
  return ref && ref.length <= 255 ? ref : null;
}
