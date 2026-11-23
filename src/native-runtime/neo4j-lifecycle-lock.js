import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

import { processState } from '../local-runtime/processes.js';
import { readJsonFile } from '../storage/json-file.js';
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
export async function acquireNeo4jLifecycleLock(root, { operation, identify = ownIdentity } = {}) {
  const path = lockPath(root), token = randomUUID();
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error('Neo4j runtime must not be a symbolic link.');
  const prepared = join(root, `${LOCK}.new-${token}`);
  await mkdir(prepared, { mode: 0o700 });
  try {
    await writeFile(join(prepared, 'owner'), token, { flag: 'wx', mode: 0o600 });
    await writeFile(join(prepared, 'holder.json'), JSON.stringify({ ...await identify(), operation, at: new Date().toISOString() }),
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
  const owner = join(path, 'owner');
  async function assertHeld() { if (await readFile(owner, 'utf8') !== token) throw new Error('Neo4j lifecycle lock ownership changed.'); }
  return { token, assertHeld, async release() { await assertHeld(); await rm(path, { recursive: true }); } };
}

// This process as `ps` shows it, so a later reader can tell it from a stranger with its PID.
async function ownIdentity() {
  const [command, startedAt] = await Promise.all([processCommand(process.pid), processStartTime(process.pid)]);
  return { pid: process.pid, command, startedAt };
}

// The lock as it stands, or null when there is none. [holder] is null for a
// lock taken before FULI recorded its holder.
function readLock(root) {
  const path = lockPath(root);
  let since;
  try { since = statSync(path).mtime; } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let owner = null, holder = null;
  try { owner = readFileSync(join(path, 'owner'), 'utf8'); } catch { /* an incomplete older lock */ }
  try { holder = JSON.parse(readFileSync(join(path, 'holder.json'), 'utf8')); } catch { /* an older lock names no holder */ }
  return { path, since, owner, holder: Number.isInteger(holder?.pid) && holder.pid > 0 ? holder : null };
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

// Moves the lock aside under a unique name, checks it is the one judged, then
// removes it; a lock replaced in between is put back. Answers whether it was removed.
async function takeOver(root, owner) {
  const path = lockPath(root), aside = join(root, `${LOCK}.stale-${randomUUID()}`);
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
  return takeOver(root, lock.owner);
}

// Why the lock, or a switch journal, keeps a start from running: the facts a
// person needs (src/local-runtime/startup-failure.js), as one error.
export async function neo4jLifecycleLockError(root, identity = IDENTITY) {
  const lock = readLock(root);
  const facts = { since: lock?.since.toISOString() ?? null, operation: lock?.holder?.operation ?? null,
    pid: lock?.holder?.pid ?? null, lockPath: lockPath(root) };
  if (existsSync(journalPath(root))) {
    // Which switch it was and how far it got (neo4j-lifecycle.js writes it before
    // changing anything): 'switching' an update or rollback, 'removing-assets' an uninstall.
    const journal = readJsonFile(journalPath(root), null) ?? {};
    return Object.assign(new Error('A native Neo4j switch did not finish and needs recovery before services start.'), {
      code: 'native_recovery_needed', startupFailure: { code: 'native_recovery_needed', ...facts,
        operation: typeof journal.action === 'string' ? journal.action : facts.operation,
        phase: typeof journal.phase === 'string' ? journal.phase : null, journalPath: journalPath(root) }
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

// The program's own name from a command line ("java", "node").
function commandName(command) {
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
  if (await holderState(lock.holder, identity) === 'running') return { released: false, reason: 'holder_running', pid: lock.holder.pid };
  const recorded = readJsonFile(paths.nativeProcessStatePath, {}) ?? {};
  for (const entry of [...Object.values(recorded.databases ?? {}), ...Object.values(recorded.providers ?? {})]) {
    if (Number.isInteger(entry?.pid) && typeof entry.command === 'string' && identity.state(entry.pid) !== 'gone'
      && await identity.matches(entry.pid, entry.command)) {
      return { released: false, reason: 'services_running', pid: entry.pid };
    }
  }
  // Another FULI command for this data: its CLI or a desktop controller. The
  // console server, MCP processes and hooks name the data too but take no lock.
  const processes = await listProcesses();
  if (!processes) return { released: false, reason: 'cannot_inspect' };
  const other = processes.find(({ pid, command }) => pid !== process.pid && pid !== process.ppid
    && command.includes(paths.dataDir) && /(?:\/src\/cli\.js|-controller\.js|\/(?:fuli|fl))(?:\s|$)/.test(command));
  if (other) return { released: false, reason: 'fuli_running', pid: other.pid };
  const ageMs = now() - lock.since.getTime();
  if (ageMs < RELEASE_AFTER_MS) {
    return { released: false, reason: 'too_recent', since: lock.since.toISOString(), releasableAt: new Date(lock.since.getTime() + RELEASE_AFTER_MS).toISOString() };
  }
  return await takeOver(root, lock.owner) ? { released: true } : { released: false, reason: 'changed' };
}

function processList() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout.split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line))
        .filter(Boolean).map(([, pid, command]) => ({ pid: Number(pid), command })));
    });
  });
}
