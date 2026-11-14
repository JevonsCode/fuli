import { execFile } from 'node:child_process';
import { closeSync, existsSync, ftruncateSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync,
  unlinkSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { sha256Bytes, sha256File } from '../security/digest.js';
import { gitDirectoryName, gitModulesName } from './git-names.js';

// The isolated copy a visit request is worked on: a Git worktree of the
// project's repository on its own branch, cut from a commit (so the owner's
// uncommitted changes neither leak in nor get touched), under FULI's data
// directory. FULI itself commits what the run changed, as a fixed visit
// identity with no personal data, never merges or pushes.
//
// What the run wrote is untrusted, so no Git call ever lets it decide
// anything: a call on the worktree names its Git directory and work tree
// explicitly, both computed from the owner's repository (never discovered
// from files in the worktree), and every call runs with the hardened options
// below, without the system and global configuration (GIT_CONFIG_NOSYSTEM,
// GIT_CONFIG_GLOBAL = /dev/null: the commit's identity comes from -c,
// so nothing of the person's own Git setup is needed). Before anything is
// staged, the worktree is checked for content that would make Git act on its
// own (inspectVisitWorktree).
export const VISIT_BRANCH_PREFIX = 'fuli/visit/';
const VISIT_AUTHOR = ['-c', 'user.name=FULI visit', '-c', 'user.email=visit@fuli.invalid', '-c', 'commit.gpgsign=false'];
const OUTPUT_BYTES = 32 * 1024 * 1024;
// The patch the owner reads on the card, never more.
const PATCH_BYTES = 512 * 1024;
// A run past these is held as too_large before anything reaches the object store.
const MAX_CHANGED_FILES = 2000;
const MAX_CHANGED_BYTES = 50 * 1024 * 1024;
const GITLINK_MODE = '160000';
// Git's own name for nothing, on every platform (Git for Windows maps it too;
// Node's '\\.\nul' is refused there): no global configuration and no hooks
// folder, and no file a run could plant under FULI's data directory instead.
const NO_FILE = '/dev/null';

// Where a request's worktree and branch will be, recorded before they are made
// so a restart in between still finds and tidies both.
export const plannedVisitWorktree = ({ root, id }) => ({ worktreePath: join(root, id), branch: `${VISIT_BRANCH_PREFIX}${id}` });

export async function createVisitWorktree({ folder, root, id }) {
  const repository = await repositoryRoot({ folder, root });
  const baseCommit = (await git(repository, ['rev-parse', 'HEAD'], root)).trim();
  const { worktreePath, branch } = plannedVisitWorktree({ root, id });
  await git(repository, ['worktree', 'add', '-b', branch, worktreePath, baseCommit], root);
  const { gitDir } = await location({ repository, root, id });
  // Git named the worktree's administrative folder by its last path segment;
  // anything else (a name already taken) is refused rather than guessed.
  if (!existsSync(join(gitDir, 'HEAD'))) throw coded('worktree_unexpected');
  writePointer(join(worktreePath, '.git'), pointerText(gitDir));
  return { worktreePath, branch, baseCommit };
}

// What would let the run's content act through Git or through FULI's own
// clean-up, or fill the owner's object store: the worktree's own .git pointer
// changed, any symbolic link, junction or other link (removing a worktree
// must never reach past it), another .git (file or folder, under any name Git
// or the file system treats as .git) anywhere, a .gitmodules added or changed,
// a file inside a submodule path, or more than MAX_CHANGED_FILES /
// MAX_CHANGED_BYTES changed.
// Answers the hold reason (unsafe_content, too_large) or null. Nothing is
// staged here; status runs only once the content checks passed.
export async function inspectVisitWorktree({ folder, root, id, worktreePath, baseCommit }) {
  const repository = await repositoryRoot({ folder, root });
  const { gitDir } = await location({ repository, root, id });
  const pointer = join(worktreePath, '.git');
  if (!existsSync(pointer) || !lstatSync(pointer).isFile() || readFileSync(pointer, 'utf8') !== pointerText(gitDir)) return 'unsafe_content';
  const gitlinks = (await git(repository, ['ls-tree', '-r', '-z', '--full-tree', baseCommit], root)).split('\0').filter(Boolean)
    .filter((entry) => entry.startsWith(`${GITLINK_MODE} `)).map((entry) => entry.split('\t')[1]);
  for (const { path, link } of walk(worktreePath)) {
    const name = path.split('/').at(-1);
    if (link) return 'unsafe_content';
    if (path !== '.git' && gitDirectoryName(name)) return 'unsafe_content';
    if (gitlinks.some((gitlink) => path.toLowerCase().startsWith(`${gitlink.toLowerCase()}/`))) return 'unsafe_content';
    if (gitModulesName(name)) {
      const before = await git(repository, ['cat-file', 'blob', `${baseCommit}:${path}`], root).catch(() => null);
      if (before === null || readFileSync(join(worktreePath, path), 'utf8') !== before) return 'unsafe_content';
    }
  }
  const changed = (await worktreeGit({ gitDir, worktreePath, root },
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames']))
    .split('\0').filter(Boolean).map((entry) => entry.slice(3));
  if (changed.length > MAX_CHANGED_FILES) return 'too_large';
  let bytes = 0;
  for (const path of changed) {
    const file = join(worktreePath, path);
    if (existsSync(file)) bytes += lstatSync(file).size;
    if (bytes > MAX_CHANGED_BYTES) return 'too_large';
  }
  return null;
}

// Commits whatever the run left in the worktree on its branch; false when
// nothing changed. Call only after inspectVisitWorktree answered null. A
// commit that fails after add leaves its blobs as unreachable loose objects,
// which Git's own gc prunes after its expiry; FULI does not prune the owner's
// object store itself.
export async function commitVisitWorktree({ folder, root, id, worktreePath, message }) {
  const repository = await repositoryRoot({ folder, root });
  const { gitDir } = await location({ repository, root, id });
  const run = (args) => worktreeGit({ gitDir, worktreePath, root }, args);
  await run(['add', '-A', '--ignore-errors']);
  if (!(await run(['status', '--porcelain=v1', '--ignore-submodules=all'])).trim()) return false;
  await run([...VISIT_AUTHOR, 'commit', '--no-verify', '-q', '-m', message]);
  return true;
}

// The branch's changes against its base, as Git reports them (never as the run
// described them): each file with its added and removed lines and whether it
// is executable, binary or a link; the added text for the secret scan; the
// patch for the owner, bounded.
export async function branchChanges({ repository, baseCommit, branch, root }) {
  const range = [baseCommit, `refs/heads/${branch}`];
  const diff = (args) => git(repository, ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', ...args, ...range], root);
  const numstat = (await diff(['--numstat', '-z'])).split('\0').filter(Boolean).map((entry) => entry.split('\t'));
  const raw = (await diff(['--raw', '-z'])).split('\0');
  const modes = new Map();
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const [, , newMode] = raw[index].split(' ');
    modes.set(raw[index + 1], newMode);
  }
  const files = numstat.map(([added, removed, path]) => ({ path, added: added === '-' ? 0 : Number(added),
    removed: removed === '-' ? 0 : Number(removed), binary: added === '-',
    executable: modes.get(path) === '100755', symlink: modes.get(path) === '120000' }));
  const patch = await diff(['--no-color']);
  const addedText = patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  const bytes = Buffer.byteLength(patch);
  return { files, addedText, diffstat: { files: files.length, added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0) },
  patch: bytes > PATCH_BYTES ? Buffer.from(patch).subarray(0, PATCH_BYTES).toString('utf8') : patch, truncated: bytes > PATCH_BYTES };
}

// A digest of what a run must not change outside its own branch: the owner's
// checkout (its status, the content of every tracked change against HEAD and
// of every untracked file Git does not ignore, and the names Git ignores, so a
// new self-ignoring folder shows), the repository's config, config.worktree,
// info/exclude, info/attributes, objects/info/alternates, its hooks folder
// (names and contents), the other worktrees Git knows (names; this request's
// own excepted) and every ref except this request's own branch (other visit
// branches included). Taken before and after a run, a difference is detected
// and the result held; nothing is restored. Read without taking Git's
// optional locks, so the owner's own Git commands are never blocked by it.
export async function integritySnapshot({ repository, root, ownBranch, id }) {
  const read = (args) => git(repository, ['--no-optional-locks', ...args], root);
  const status = await read(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']);
  const ignored = (await read(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal', '--ignore-submodules=all']))
    .split('\0').filter((entry) => entry.startsWith('!! '));
  const tracked = sha256Bytes(await read(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', '--ignore-submodules=all', 'HEAD']));
  const untracked = await Promise.all((await read(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    .map(async (path) => [path, await sha256File(join(repository, path)).catch(() => null)]));
  const refs = (await read(['for-each-ref', '--format=%(refname) %(objectname)'])).split('\n')
    .filter((line) => line && !line.startsWith(`refs/heads/${ownBranch} `));
  const head = (await read(['rev-parse', 'HEAD'])).trim();
  const common = (await read(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  const files = await Promise.all(['config', 'config.worktree', join('info', 'exclude'), join('info', 'attributes'),
    join('objects', 'info', 'alternates')].map(async (name) => [name, await sha256File(join(common, name)).catch(() => null)]));
  const hooksFolder = join(common, 'hooks');
  const hooks = existsSync(hooksFolder) ? await Promise.all(readdirSync(hooksFolder).sort()
    .map(async (name) => [name, await sha256File(join(hooksFolder, name)).catch(() => 'folder')])) : [];
  const worktreesFolder = join(common, 'worktrees');
  const worktrees = existsSync(worktreesFolder) ? readdirSync(worktreesFolder).filter((name) => name !== id).sort() : [];
  return sha256Bytes(JSON.stringify({ status, ignored, tracked, untracked, refs, head, files, hooks, worktrees }));
}

// keepBranch: the owner kept the result (or it expired unreviewed); only the
// worktree goes. Never `git worktree remove --force`, which follows a junction
// planted inside: links, junctions and other reparse points are unlinked
// themselves, never followed, then the plain tree is deleted by Node, then Git
// forgets the worktree. Nothing outside root (<dataDir>/visit-worktrees) is
// ever removed.
export async function removeVisitWorktree({ repository, worktreePath, branch, root }, { keepBranch }) {
  if (worktreePath) removeTreeUnder(worktreePath, root);
  await git(repository, ['worktree', 'prune'], root);
  if (!keepBranch && branch) await git(repository, ['branch', '-D', branch], root).catch(() => null);
}

function removeTreeUnder(path, root) {
  if (!existsSync(path) && !isLink(path)) return;
  const parent = realpathSync(dirname(resolve(path)));
  if (parent !== realpathSync(resolve(root))) throw coded('worktree_outside_root');
  if (isLink(path)) { unlinkLink(path); return; }
  for (const { path: inner, link } of walk(path)) if (link) unlinkLink(join(path, inner));
  // Only plain folders and files are left; rmSync does not follow links (and none is left to follow).
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

// A symbolic link, junction or other reparse point as lstat sees it.
function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

// Removes the link itself: a file link with unlink, a folder link or junction
// with rmdir on the link (Windows), neither ever touching its target.
function unlinkLink(path) {
  try { unlinkSync(path); } catch { rmdirSync(path); }
}

export async function repositoryRoot({ folder, root }) {
  return (await git(folder, ['rev-parse', '--show-toplevel'], root)).trim();
}

// The worktree's Git directory, from the owner's repository's common directory.
async function location({ repository, root, id }) {
  const common = (await git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'], root)).trim();
  return { gitDir: resolve(common, 'worktrees', id) };
}

// The pointer FULI writes into the worktree; anything else there is the run's doing.
const pointerText = (gitDir) => `gitdir: ${gitDir.split(sep).join('/')}\n`;

// Rewritten in place: Git for Windows marks the file hidden, which a plain write refuses.
function writePointer(path, text) {
  const descriptor = openSync(path, 'r+');
  try {
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, text, 0);
  } finally { closeSync(descriptor); }
}

// Every file and folder under the worktree, relative with forward slashes, by
// lstat: a link, junction or other reparse point is reported (link: true) and
// never descended into.
function* walk(top, folder = top) {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    const stats = lstatSync(path);
    const link = stats.isSymbolicLink() || !(stats.isFile() || stats.isDirectory());
    yield { path: relative(top, path).split(sep).join('/'), link };
    if (!link && stats.isDirectory()) yield* walk(top, path);
  }
}

// One Git call on the visit worktree: its Git directory and work tree named, never discovered.
function worktreeGit({ gitDir, worktreePath, root }, args) {
  return gitCall([`--git-dir=${gitDir}`, `--work-tree=${worktreePath}`, ...args], { cwd: worktreePath, root });
}

// One Git call on the owner's repository (trusted to locate itself).
function git(cwd, args, root) {
  return gitCall(['-C', cwd, ...args], { cwd, root });
}

// Every call: no fsmonitor, untracked cache, submodule recursion, hooks
// (a folder that does not exist), file-protocol transport, external diff,
// pager or editor; no system or global configuration; none of the caller's
// GIT_ variables; never a prompt.
function gitCall(args, { cwd, root }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const hardened = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'submodule.recurse=false',
    '-c', `core.hooksPath=${NO_FILE}`, '-c', 'protocol.file.allow=never', '-c', 'diff.external=',
    '-c', 'core.editor=false', '-c', 'safe.directory=*'];
  return new Promise((done, reject) => execFile('git', [...hardened, ...args],
    { cwd: existsSync(cwd) ? cwd : root, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NO_FILE,
      GIT_PAGER: 'cat', GIT_EDITOR: 'false' }, maxBuffer: OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' },
    (error, stdout, stderr) => (error ? reject(Object.assign(new Error('A Git step of the visit request failed'),
      { code: 'git_failed', stderr: String(stderr).slice(-2000) })) : done(stdout))));
}

const coded = (code) => Object.assign(new Error(code), { code });
