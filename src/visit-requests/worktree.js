import { execFile } from 'node:child_process';
import { closeSync, existsSync, ftruncateSync, lstatSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { sha256Bytes, sha256File } from '../security/digest.js';
import { fileIdentity } from '../system/file-identity.js';
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
// A step of the integrity snapshot (a status of a large checkout) waits no longer than this.
const SNAPSHOT_STEP_MS = 60_000;

// Where a request's worktree and branch will be, recorded before they are made
// so a restart in between still finds and tidies both.
export const plannedVisitWorktree = ({ root, id }) => ({ worktreePath: join(root, id), branch: `${VISIT_BRANCH_PREFIX}${id}` });

// rootIdentity: the identity (dev:ino) of root as the worktree is made in it,
// recorded with the request so a removal can tell root was not replaced since.
// root must be a plain folder, never a link or junction.
export async function createVisitWorktree({ folder, root, id }) {
  const repository = await repositoryRoot({ folder, root });
  await mkdir(root, { recursive: true });
  const rootIdentity = await plainFolderIdentity(root, 'worktree_root_unexpected');
  const baseCommit = (await git(repository, ['rev-parse', 'HEAD'], root)).trim();
  const { worktreePath, branch } = plannedVisitWorktree({ root, id });
  await git(repository, ['worktree', 'add', '-b', branch, worktreePath, baseCommit], root);
  const { gitDir } = await location({ repository, root, id });
  // Git named the worktree's administrative folder by its last path segment;
  // anything else (a name already taken) is refused rather than guessed.
  if (!existsSync(join(gitDir, 'HEAD'))) throw coded('worktree_unexpected');
  writePointer(join(worktreePath, '.git'), pointerText(gitDir));
  return { worktreePath, branch, baseCommit, rootIdentity };
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
  for await (const { path, link } of walk(worktreePath)) {
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
// Each Git step of it has SNAPSHOT_STEP_MS; past that it throws and the
// caller holds the result as integrity_unknown instead of waiting.
export async function integritySnapshot({ repository, root, ownBranch, id }) {
  const read = (args) => gitCall(['-C', repository, '--no-optional-locks', ...args], { cwd: repository, root, timeoutMs: SNAPSHOT_STEP_MS });
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
  // Entry names are folder names Git made, ours being exactly the request id (the last
  // segment of the path FULI gave it), so a name compares as text.
  const worktrees = existsSync(worktreesFolder) ? readdirSync(worktreesFolder).filter((name) => name !== id).sort() : [];
  return sha256Bytes(JSON.stringify({ status, ignored, tracked, untracked, refs, head, files, hooks, worktrees }));
}

// keepBranch: the owner kept the result (or it expired unreviewed); only the
// worktree goes. Never `git worktree remove --force`, which follows a junction
// planted inside, and never `git worktree prune`, which would also drop the
// owner's other worktrees whose folders are missing (one on an unplugged
// drive): links, junctions and other reparse points are unlinked themselves,
// never followed, then the plain tree is deleted by Node, then only this
// request's own entry in Git's worktrees folder goes, once its gitdir file
// names this worktree. Nothing outside root (<dataDir>/visit-worktrees) or
// that folder is ever removed, and nothing at all once root is not the folder
// the worktree was made in (worktree_root_changed): root itself a link or
// junction now, or, by the rootIdentity recorded at creation, another folder,
// for example because a folder above it now leads elsewhere. A request
// recorded without rootIdentity gets the link check only. Answers what could
// not be done, so the owner sees it: entryKept (Git's entry for the worktree
// did not name it, so it and the branch stay) and branchKept (Git refused to
// delete the branch).
export async function removeVisitWorktree({ repository, worktreePath, branch, root, rootIdentity = null }, { keepBranch }) {
  let entryKept = false;
  if (worktreePath) {
    const current = await plainFolderIdentity(root, 'worktree_root_changed');
    if (current && rootIdentity && current !== rootIdentity) throw coded('worktree_root_changed');
    // Matched before the folder goes: the folder's identity is part of the match.
    const entry = await ownAdminEntry({ repository, worktreePath, root });
    await removeTreeUnder(worktreePath, root, rootIdentity);
    if (entry.matched) await removeTreeUnder(entry.path, entry.entries);
    entryKept = entry.exists && !entry.matched;
  }
  let branchKept = false;
  if (!keepBranch && branch) {
    // While Git still lists the worktree, it would refuse anyway: the branch stays, said once.
    branchKept = entryKept || await git(repository, ['branch', '-D', branch], root).then(() => false, () => true);
  }
  return { entryKept, branchKept };
}

// Git's administrative entry for this worktree, and whether it is ours: the
// folder its gitdir file names is the same place as this request's worktree,
// compared by the identity of the actual folder (so 8.3 short names, letter
// case, slash direction and symlinked temp folders such as /var ->
// /private/var all agree), never by the text of the two paths.
async function ownAdminEntry({ repository, worktreePath, root }) {
  const common = (await git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'], root)).trim();
  const entries = join(common, 'worktrees');
  const path = join(entries, basename(worktreePath));
  const named = await readFile(join(path, 'gitdir'), 'utf8').catch(() => null);
  if (named === null) return { exists: existsSync(path), matched: false, path, entries };
  return { exists: true, matched: await sameLocation(dirname(named.trim()), worktreePath), path, entries };
}

// Two paths name the same place: their parents are the same folder (by
// dev:ino, whatever the volume's case rules) and their last names are the
// same text (the request id FULI gave Git). The parent is compared, not the
// folder itself, so the comparison still holds once the folder is gone.
async function sameLocation(left, right) {
  const parents = await Promise.all([left, right].map((path) => identityOf(dirname(resolve(path)))));
  return parents[0] !== null && parents[0] === parents[1] && basename(resolve(left)) === basename(resolve(right));
}

// The identity of the folder a path leads to (links followed), or null when there is none or it is unknown.
const identityOf = (path) => stat(path, { bigint: true }).then(knownIdentity, () => null);

// A file ID of 0 (some network shares report it for every file) names no folder in particular: unknown.
const knownIdentity = (stats) => (stats.ino === 0n ? null : fileIdentity(stats));

// The identity of a folder that must be a plain folder, not a link, junction
// or other reparse point, with a known identity (refused with code); null
// when it does not exist.
async function plainFolderIdentity(path, code) {
  const stats = await lstat(path, { bigint: true }).catch(() => null);
  if (!stats) return null;
  const identity = isLinkStats(stats) || !stats.isDirectory() ? null : knownIdentity(stats);
  if (!identity) throw coded(code);
  return identity;
}

// Removes path, which must sit directly in root, a plain folder; compared by
// folder identity (expected: root's identity recorded at creation, if any).
// Root is read again right before each unlink and before the delete, so it
// cannot be swapped for another folder while the tree is walked.
async function removeTreeUnder(path, root, expected = null) {
  const stats = await lstat(path).catch(() => null);
  if (!stats) return;
  const folder = await plainFolderIdentity(root, 'worktree_outside_root');
  if (expected && folder !== expected) throw coded('worktree_root_changed');
  const parent = await identityOf(dirname(resolve(path)));
  if (!parent || parent !== folder) throw coded('worktree_outside_root');
  const unchanged = async () => {
    if (await plainFolderIdentity(root, 'worktree_root_changed') !== folder) throw coded('worktree_root_changed');
  };
  if (isLinkStats(stats)) { await unchanged(); await unlinkLink(path); return; }
  const links = [];
  for await (const { path: inner, link } of walk(path)) if (link) links.push(join(path, inner));
  for (const link of links) { await unchanged(); await unlinkLink(link); }
  await unchanged();
  // Only plain folders and files are left; rm does not follow links (and none is left to follow).
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
}

// A symbolic link, junction or other reparse point as lstat sees it.
const isLinkStats = (stats) => stats.isSymbolicLink() || !(stats.isFile() || stats.isDirectory());

// Removes the link itself: a file link with unlink, a folder link or junction
// with rmdir on the link (Windows), neither ever touching its target.
async function unlinkLink(path) {
  try { await unlink(path); } catch { await rmdir(path); }
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
// Compared as text on purpose: FULI writes it and later rebuilds it from the same
// source (Git's common directory, read the same way), so any other spelling of the
// same place was written by someone else.
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
// never descended into. Asynchronous, so a large tree never blocks the
// console's event loop.
async function* walk(top, folder = top) {
  for (const name of await readdir(folder)) {
    const path = join(folder, name);
    const stats = await lstat(path);
    const link = isLinkStats(stats);
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
// timeoutMs: optional; past it the call is stopped and throws.
function gitCall(args, { cwd, root, timeoutMs = 0 }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const hardened = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'submodule.recurse=false',
    '-c', `core.hooksPath=${NO_FILE}`, '-c', 'protocol.file.allow=never', '-c', 'diff.external=',
    '-c', 'core.editor=false', '-c', 'safe.directory=*'];
  return new Promise((done, reject) => execFile('git', [...hardened, ...args],
    { cwd: existsSync(cwd) ? cwd : root, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NO_FILE,
      GIT_PAGER: 'cat', GIT_EDITOR: 'false' }, maxBuffer: OUTPUT_BYTES, windowsHide: true, encoding: 'utf8', timeout: timeoutMs },
    (error, stdout, stderr) => (error ? reject(Object.assign(new Error('A Git step of the visit request failed'),
      { code: 'git_failed', stderr: String(stderr).slice(-2000) })) : done(stdout))));
}

const coded = (code) => Object.assign(new Error(code), { code });
