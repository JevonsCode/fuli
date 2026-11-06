// Builds the repo a session starts from: the base project, then the reference solutions of every earlier session,
// then the session's own start overlay, committed as one synthetic base commit.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSIONS } from './sessions.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function git(args, cwd) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Bench', '-c', 'user.email=bench@example.invalid', ...args],
    { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

// Overlays in order for the session at `index` (0-based); `solved` also applies that session's own solution.
export function overlays(index, { solved = false } = {}) {
  const dirs = [join(HERE, 'project')];
  for (const session of SESSIONS.slice(0, index)) dirs.push(join(HERE, 'solutions', session.id));
  const own = SESSIONS[index].id;
  if (existsSync(join(HERE, 'start', own))) dirs.push(join(HERE, 'start', own));
  if (solved) dirs.push(join(HERE, 'solutions', own));
  return dirs.filter((dir) => existsSync(dir));
}

export function buildRepo(index, dir, { solved = false, commit = true } = {}) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const overlay of overlays(index, { solved })) cpSync(overlay, dir, { recursive: true });
  renameSync(join(dir, 'gitignore.txt'), join(dir, '.gitignore'));
  if (!commit) return dir;
  git(['init', '--quiet', '--initial-branch=main'], dir);
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', 'Tidewater (synthetic)'], dir);
  return dir;
}
