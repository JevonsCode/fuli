import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, join, sep } from 'node:path';

import { processState } from '../local-runtime/processes.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { processCommand, processMatchesCommand, processStartTime } from './process-identity.js';
import { NATIVE_DOWNLOAD_TIMEOUT_MS } from './resumable-download.js';

// The one lifecycle lease of a native runtime directory: starts, stops and the
// Neo4j asset operations (update, rollback, uninstall) take it in turn.
//
// The lock records who took it (holder.json: PID, that process's start time and
// command, and the operation). A later start takes over a lock whose holder has
// ended — or whose PID now belongs to another program — but only when that
// holder was a start or stop and no switch journal waits for recovery. Anything
// else stays for a person, and the error says which case it is.

const LOCK = '.neo4j-lifecycle.lock';
const TAKEOVER = '.neo4j-lifecycle.takeover';
const JOURNAL = 'neo4j-transaction.json';
// Operations that change no Neo4j assets: an interrupted one leaves nothing half done.
const SERVICE_OPERATIONS = new Set(['start', 'stop']);
// A lock older than this many of the longest operation's timeouts (an asset
// download) is old enough for a person to release after the other checks.
const RELEASE_AFTER_MS = 3 * NATIVE_DOWNLOAD_TIMEOUT_MS;

const lockPath = root => join(root, LOCK);
const journalPath = root => join(root, JOURNAL);

// The holder is written beside the token before the lock appears: a directory
// is prepared under a unique name and renamed into place, so a lock is never
// seen without its owner and holder, and two takers cannot both succeed.
// [details]: what else a later recovery needs to know about this operation
// (a load records the copy its import took first: neo4j-recovery.js).
export async function acquireNeo4jLifecycleLock(root, { operation, identify = ownIdentity, details = {} } = {}) {
  const path = lockPath(root), token = randomUUID();
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error('Neo4j runtime must not be a symbolic link.');
  const prepared = join(root, `${LOCK}.new-${token}`);
  await mkdir(prepared, { mode: 0o700 });
  try {
    await writeFile(join(prepared, 'owner'), token, { flag: 'wx', mode: 0o600 });
    await writeFile(join(prepared, 'holder.json'), JSON.stringify({ ...details, ...await identify(), operation, at: new Date().toISOString() }),
      { flag: 'wx', mode: 0o600 });
    try { await rename(prepared, path); }
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) {
        throw new Error('A Neo4j lifecycle lock exists. Inspect an interrupted operation before retrying.');
      }
      throw error;
    }
  } finally {
    await rm(prepared, { recursive: true, force: true });
  }
  await removeLeftovers(root);
  const owner = join(path, 'owner');
  async function assertHeld() { if (await readFile(owner, 'utf8') !== token) throw new Error('Neo4j lifecycle lock ownership changed.'); }
  return { token, assertHeld, async release() { await assertHeld(); await rm(path, { recursive: true }); },
    // Adds [patch] to what the lock records (holder.json, replaced whole or not
    // at all); throws when it could not be recorded.
    async record(patch) { if (!await claimLock(root, token, { identify, patch })) throw new Error('Neo4j lifecycle lock ownership changed.'); } };
}

// This process as `ps` shows it, so a later reader can tell it from a stranger with its PID.
export async function ownIdentity() {
  const [command, startedAt] = await Promise.all([processCommand(process.pid), processStartTime(process.pid)]);
  return { pid: process.pid, command, startedAt };
}

// The lock as it stands, or null when there is none: since when, its token and
// what it recorded about its holder. [holder] is null for a lock taken before
// FULI recorded its holder.
export function readLock(root) {
  const path = lockPath(root);
  let since;
  try { since = statSync(path).mtime; } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let owner = null, holder = null;
  try { owner = readFileSync(join(path, 'owner'), 'utf8'); } catch { /* an incomplete older lock */ }
  try { holder = JSON.parse(readFileSync(join(path, 'holder.json'), 'utf8')); } catch { /* an older lock names no holder */ }
  return { path, since, owner, holder: Number.isInteger(holder?.pid) && holder.pid > 0 ? holder : null };
}

// When the operation that holds [lock] took it (ms): what its holder recorded,
// which stays when a recovery claims the lock, or else when the lock appeared.
export function lockStartedAt(lock) {
  const at = Date.parse(lock?.holder?.at ?? '');
  return Number.isFinite(at) ? at : lock?.since?.getTime() ?? Number.NaN;
}

// Makes this process the lock's recorded holder — a recovery about to work
// under the lock's own token [owner] — keeping what the holder recorded about
// its operation (and when it took the lock) and adding [patch]. Done under the
// take-over directory, so two recoveries never both claim it: answers false
// when the lock changed, or its holder is another process that still runs.
export async function claimLock(root, owner, { identity = IDENTITY, identify = ownIdentity, patch = {} } = {}) {
  const me = await identify();
  return withTakeover(root, identity, async () => {
    const lock = readLock(root);
    if (!lock || lock.owner !== owner) return false;
    let recorded = {};
    try { recorded = JSON.parse(readFileSync(join(lock.path, 'holder.json'), 'utf8')) ?? {}; } catch { /* an older lock names no holder */ }
    const self = lock.holder && lock.holder.pid === me.pid && lock.holder.startedAt === me.startedAt;
    if (lock.holder && !self && await holderState(lock.holder, identity) === 'running') return false;
    writeJsonFileAtomic(join(lock.path, 'holder.json'), { ...recorded, at: recorded.at ?? lock.since.toISOString(), ...me, ...patch });
    return true;
  });
}

// 'running', 'gone' (ended, or its PID is now another program) or 'unknown' (no holder recorded).
// A holder `ps` cannot read counts as running: nothing is taken over on a guess.
async function holderState(holder, identity) {
  if (!holder) return 'unknown';
  if (identity.state(holder.pid) === 'gone') return 'gone';
  if (typeof holder.startedAt === 'string' && typeof holder.command === 'string') {
    const [startedAt, sameCommand] = await Promise.all([identity.startTime(holder.pid), identity.matches(holder.pid, holder.command)]);
    if (startedAt !== null && (startedAt !== holder.startedAt || !sameCommand)) return 'gone';
  }
  return 'running';
}

const IDENTITY = { state: processState, startTime: processStartTime, matches: processMatchesCommand };

// A process killed while preparing a lock or taking one over leaves its
// directory behind (`.new-*`, `.stale-*`); a later lock clears those old
// enough that no live process can still be using them.
const LEFTOVER_AGE_MS = 10 * 60_000;

async function removeLeftovers(root, now = Date.now()) {
  let names;
  try { names = await readdir(root); } catch { return; }
  for (const name of names.filter(name => name.startsWith(`${LOCK}.new-`) || name.startsWith(`${LOCK}.stale-`))) {
    try {
      if (now - (await lstat(join(root, name))).mtimeMs >= LEFTOVER_AGE_MS) await rm(join(root, name), { recursive: true, force: true });
    } catch { /* gone already, or kept for the next lock */ }
  }
}

// One taker at a time: a directory of its own, made before the lock is judged
// again and moved, so a lock replaced since it was judged is never moved aside.
// One a killed taker left is cleared when its process has ended. Answers false
// while another take-over runs.
async function withTakeover(root, identity, action) {
  const path = join(root, TAKEOVER);
  for (let attempt = 0; ; attempt += 1) {
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt > 0) {
        if (error.code === 'EEXIST') return false;
        throw error;
      }
      let pid = null, age = 0;
      try { pid = Number(readFileSync(join(path, 'pid'), 'utf8')); age = Date.now() - statSync(path).mtimeMs; } catch { /* just made */ }
      const ended = Number.isInteger(pid) && pid > 0 ? identity.state(pid) === 'gone' : age >= LEFTOVER_AGE_MS;
      if (!ended) return false;
      await rm(path, { recursive: true, force: true });
    }
  }
  try {
    await writeFile(join(path, 'pid'), String(process.pid), { mode: 0o600 });
    return await action();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// Moves the lock aside under a unique name, checks it is the one judged, then
// removes it. Under the take-over directory the lock is read once more right
// before it is moved: one replaced since it was judged is left where it is.
// Answers whether it was removed. A recovery releases a lock it dealt with this way.
export async function takeOver(root, owner, identity = IDENTITY) {
  return withTakeover(root, identity, () => moveAside(root, owner));
}

async function moveAside(root, owner) {
  const path = lockPath(root), aside = join(root, `${LOCK}.stale-${randomUUID()}`);
  let current = null;
  try { current = readFileSync(join(path, 'owner'), 'utf8'); } catch (error) { if (error.code === 'ENOENT' && !existsSync(path)) return false; }
  if (current !== owner) return false;
  try { await rename(path, aside); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let moved = null;
  try { moved = await readFile(join(aside, 'owner'), 'utf8'); } catch { /* an older lock without an owner file */ }
  if (moved === owner) {
    await rm(aside, { recursive: true, force: true });
    return true;
  }
  try { await rename(aside, path); }
  catch { throw new Error(`The Neo4j lifecycle lock changed while it was being taken over; it was kept at ${aside} and nothing was started.`); }
  return false;
}

// A start or stop that ended without releasing its lock (it was killed) leaves
// nothing half done, so the next one takes the lock over. Answers whether it did.
export async function releaseAbandonedNeo4jLifecycleLock(root, identity = IDENTITY) {
  const lock = readLock(root);
  if (!lock?.holder || existsSync(journalPath(root)) || !SERVICE_OPERATIONS.has(lock.holder.operation)) return false;
  if (await holderState(lock.holder, identity) !== 'gone') return false;
  return takeOver(root, lock.owner, identity);
}

// Why the lock, or a switch journal, keeps a start from running: the facts a
// person needs (src/local-runtime/startup-failure.js), as one error.
export async function neo4jLifecycleLockError(root, identity = IDENTITY) {
  const lock = readLock(root);
  const facts = { since: lock?.since.toISOString() ?? null, operation: lock?.holder?.operation ?? null,
    pid: lock?.holder?.pid ?? null, lockPath: lockPath(root),
    // An import that finished and stopped only before releasing its lock (graph-backup.js).
    ...(lock?.holder?.completed === true ? { completed: true } : {}) };
  if (existsSync(journalPath(root))) {
    // Which switch it was and how far it got (neo4j-lifecycle.js writes it before
    // changing anything): 'switching' an update or rollback, 'removing-assets' an uninstall.
    const journal = readJsonFile(journalPath(root), null) ?? {};
    const fromVersion = text(journal.previous?.neo4jVersion), toVersion = text(journal.next?.neo4jVersion);
    // The backup an upgrade takes before it writes the journal (neo4j-lifecycle.js).
    const backupPath = text(journal.next?.previousNeo4jAsset?.graphBackup);
    return Object.assign(new Error('A native Neo4j switch did not finish and needs recovery before services start.'), {
      code: 'native_recovery_needed', startupFailure: { code: 'native_recovery_needed', ...facts,
        operation: text(journal.action) ?? facts.operation, phase: text(journal.phase),
        fromVersion, toVersion, upgrade: Boolean(fromVersion && toVersion && fromVersion !== toVersion),
        backupName: backupPath ? basename(backupPath) : null, backupPath, journalPath: journalPath(root) }
    });
  }
  const holder = await holderState(lock?.holder ?? null, identity);
  const command = holder === 'running' ? commandName(lock.holder.command) : null;
  return Object.assign(new Error(`A native Neo4j lifecycle operation is in progress: its lock has been held since ${facts.since}`
    + ({ running: ` by process ${facts.pid}, which is still running.`, gone: ` by process ${facts.pid} (${facts.operation}), which has ended.`,
      unknown: ', with no record of who took it.' })[holder]), {
    code: 'native_lifecycle_lock', startupFailure: { code: 'native_lifecycle_lock', holder, ...facts, command }
  });
}

const text = value => typeof value === 'string' && value ? value : null;

// The program's own name from a command line ("java", "node").
export function commandName(command) {
  const first = String(command ?? '').trim().split(/\s+/)[0];
  return first ? first.split('/').pop() : null;
}

// A person's release of a lock no start takes over by itself: one with no
// recorded holder, from before FULI recorded one, or a start's or stop's whose
// holder cannot be checked. Never one an update, rollback or uninstall left: it
// may have left files half installed. Released only when every check passes;
// otherwise it answers the first that did not.
export async function releaseStaleNeo4jLifecycleLock({ paths, now = Date.now, identity = IDENTITY, listProcesses = processList }) {
  const root = paths.nativeRuntimeDir;
  const lock = readLock(root);
  if (!lock) return { released: false, reason: 'no_lock' };
  if (existsSync(journalPath(root))) return { released: false, reason: 'recovery_needed' };
  if (lock.holder && !SERVICE_OPERATIONS.has(lock.holder.operation)) {
    return { released: false, reason: 'asset_operation', operation: lock.holder.operation ?? null };
  }
  const busy = await runtimeInUse({ paths, lock, identity, listProcesses });
  if (busy) return { released: false, ...busy };
  // An old-format lock may be an interrupted update's: its half-installed
  // candidate sits in neo4j-assets, named by neither the manifest's Neo4j nor
  // the one it keeps for a rollback.
  const unfinished = unreferencedAssets(paths);
  if (unfinished) return { released: false, reason: 'unfinished_assets', directory: unfinished };
  const young = lockTooRecent(lock, now());
  if (young) return { released: false, ...young };
  return await takeOver(root, lock.owner, identity) ? { released: true } : { released: false, reason: 'changed' };
}

// A lock that names no holder may still be in use by whoever took it: it is
// released (or recovered) only once it is older than the longest operation
// could take. Its age counts from when the operation took it (lockStartedAt),
// which a recovery's claim keeps, not from the lock directory's own time,
// which rewriting the holder moves. The refusal, or null when it is old enough.
export function lockTooRecent(lock, now) {
  const since = lockStartedAt(lock);
  if (now - since >= RELEASE_AFTER_MS) return null;
  return { reason: 'too_recent', since: new Date(since).toISOString(), releasableAt: new Date(since + RELEASE_AFTER_MS).toISOString() };
}

// Why something may still be using this native runtime, or null: the lock's
// holder still runs, a graph service processes.json records still runs as
// itself, or another FULI CLI or desktop controller works on this data. A
// release and a recovery both ask this before they touch the lock.
// [services]: false when the caller stops the recorded services itself.
export async function runtimeInUse({ paths, lock = readLock(paths.nativeRuntimeDir), identity = IDENTITY, listProcesses = processList,
  services = true }) {
  if (lock && await holderState(lock.holder, identity) === 'running') return { reason: 'holder_running', pid: lock.holder.pid };
  if (services) {
    const [pid] = await runningGraphServices(paths, identity);
    if (pid) return { reason: 'services_running', pid };
  }
  // The console server, MCP processes and hooks name the data too but take no lock.
  const processes = await listProcesses();
  if (!processes) return { reason: 'cannot_inspect' };
  const other = processes.find(({ pid, command }) => pid !== process.pid && pid !== process.ppid
    && command.includes(paths.dataDir) && /(?:\/src\/cli\.js|-controller\.js|\/(?:fuli|fl))(?:\s|$)/.test(command));
  return other ? { reason: 'fuli_running', pid: other.pid } : null;
}

// The graph services processes.json records that still run as themselves (their PIDs).
export async function runningGraphServices(paths, identity = IDENTITY) {
  const recorded = readJsonFile(paths.nativeProcessStatePath, {}) ?? {};
  const running = [];
  for (const entry of [...Object.values(recorded.databases ?? {}), ...Object.values(recorded.providers ?? {})]) {
    if (Number.isInteger(entry?.pid) && typeof entry.command === 'string' && identity.state(entry.pid) !== 'gone'
      && await identity.matches(entry.pid, entry.command)) running.push(entry.pid);
  }
  return running;
}

// The first neo4j-assets/jvs-a-* directory the manifest does not use, or null.
function unreferencedAssets(paths) {
  const root = join(paths.nativeRuntimeDir, 'neo4j-assets');
  let names;
  try { names = readdirSync(root).filter(name => name.startsWith('jvs-a-')); } catch { return null; }
  const manifest = readJsonFile(paths.nativeRuntimeManifestPath ?? join(paths.nativeRuntimeDir, 'manifest.json'), null) ?? {};
  const used = [manifest.neo4jHome, manifest.previousNeo4jAsset?.home].filter(home => typeof home === 'string');
  const unused = names.find(name => !used.some(home => home === join(root, name) || home.startsWith(`${join(root, name)}${sep}`)));
  return unused ? join('neo4j-assets', unused) : null;
}

// Every running process as `ps` shows it ({ pid, command }), or null when it cannot be listed.
export function processList() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout.split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line))
        .filter(Boolean).map(([, pid, command]) => ({ pid: Number(pid), command })));
    });
  });
}
