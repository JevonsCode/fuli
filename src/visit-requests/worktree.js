import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { sha256Bytes, sha256File } from '../security/digest.js';

// The isolated copy a visit request is worked on: a Git worktree of the
// project's repository on its own branch, cut from a commit (so the owner's
// uncommitted changes neither leak in nor get touched), under FULI's data
// directory. FULI itself commits what the run changed, as a fixed visit
// identity with no personal data, never runs the repository's hooks, never
// merges or pushes. Every Git call here gets a plain environment and a hooks
// folder that does not exist.
export const VISIT_BRANCH_PREFIX = 'fuli/visit/';
const VISIT_AUTHOR = ['-c', 'user.name=FULI visit', '-c', 'user.email=visit@fuli.invalid', '-c', 'commit.gpgsign=false'];
const OUTPUT_BYTES = 32 * 1024 * 1024;
// The patch the owner reads on the card, never more.
const PATCH_BYTES = 512 * 1024;

export async function createVisitWorktree({ folder, root, id }) {
  const repository = await repositoryRoot({ folder, root });
  const baseCommit = (await git(repository, ['rev-parse', 'HEAD'], root)).trim();
  const branch = `${VISIT_BRANCH_PREFIX}${id}`;
  const path = join(root, id);
  await git(repository, ['worktree', 'add', '-b', branch, path, baseCommit], root);
  return { worktreePath: path, branch, baseCommit };
}

// Commits whatever the run left in the worktree on its branch; false when nothing changed.
export async function commitVisitWorktree({ worktreePath, root, message }) {
  await git(worktreePath, ['add', '-A'], root);
  if (!(await git(worktreePath, ['status', '--porcelain'], root)).trim()) return false;
  await git(worktreePath, [...VISIT_AUTHOR, 'commit', '--no-verify', '-q', '-m', message], root);
  return true;
}

// The branch's changes against its base, as Git reports them (never as the run
// described them): each file with its added and removed lines and whether it
// is executable, binary or a link; the added text for the secret scan; the
// patch for the owner, bounded.
export async function branchChanges({ repository, baseCommit, branch, root }) {
  const range = [baseCommit, `refs/heads/${branch}`];
  const numstat = (await git(repository, ['diff', '--no-renames', '--no-ext-diff', '--numstat', '-z', ...range], root))
    .split('\0').filter(Boolean).map((entry) => entry.split('\t'));
  const raw = (await git(repository, ['diff', '--no-renames', '--no-ext-diff', '--raw', '-z', ...range], root)).split('\0');
  const modes = new Map();
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const [, , newMode] = raw[index].split(' ');
    modes.set(raw[index + 1], newMode);
  }
  const files = numstat.map(([added, removed, path]) => ({ path, added: added === '-' ? 0 : Number(added),
    removed: removed === '-' ? 0 : Number(removed), binary: added === '-',
    executable: modes.get(path) === '100755', symlink: modes.get(path) === '120000' }));
  const patch = await git(repository, ['diff', '--no-renames', '--no-ext-diff', '--no-color', ...range], root);
  const addedText = patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  const bytes = Buffer.byteLength(patch);
  return { files, addedText, diffstat: { files: files.length, added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0) },
  patch: bytes > PATCH_BYTES ? Buffer.from(patch).subarray(0, PATCH_BYTES).toString('utf8') : patch, truncated: bytes > PATCH_BYTES };
}

// A digest of the owner's checkout (its status, the content of every tracked
// change against HEAD and of every untracked file Git does not ignore) and of
// every ref except the visit branches: taken before and after a run, a
// difference means something outside the request's own branch changed while
// it ran. Read without taking Git's optional locks, so the owner's own Git
// commands are never blocked by it.
export async function integritySnapshot({ repository, root }) {
  const read = (args) => git(repository, ['--no-optional-locks', ...args], root);
  const status = await read(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const tracked = sha256Bytes(await read(['diff', '--no-ext-diff', '--no-color', '--binary', 'HEAD']));
  const untracked = await Promise.all((await read(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    .map(async (path) => [path, await sha256File(join(repository, path)).catch(() => null)]));
  const refs = (await read(['for-each-ref', '--format=%(refname) %(objectname)'])).split('\n')
    .filter((line) => line && !line.startsWith(`refs/heads/${VISIT_BRANCH_PREFIX}`));
  const head = (await read(['rev-parse', 'HEAD'])).trim();
  return sha256Bytes(JSON.stringify({ status, tracked, untracked, refs, head }));
}

// keepBranch: the owner kept the result; only the worktree goes.
export async function removeVisitWorktree({ repository, worktreePath, branch, root }, { keepBranch }) {
  if (worktreePath && existsSync(worktreePath)) await git(repository, ['worktree', 'remove', '--force', worktreePath], root);
  else await git(repository, ['worktree', 'prune'], root);
  if (!keepBranch && branch) await git(repository, ['branch', '-D', branch], root).catch(() => null);
}

export async function repositoryRoot({ folder, root }) {
  return (await git(folder, ['rev-parse', '--show-toplevel'], root)).trim();
}

// One Git call: no hooks (core.hooksPath points to a folder that does not
// exist), no pager, no prompts, none of the caller's GIT_ variables.
function git(cwd, args, root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return new Promise((resolve, reject) => execFile('git', ['-C', cwd, '-c', `core.hooksPath=${join(root, '.no-hooks')}`, ...args],
    { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' },
    (error, stdout) => (error ? reject(Object.assign(new Error('A Git step of the visit request failed'),
      { code: 'git_failed', detail: args[0] })) : resolve(stdout))));
}
