import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { currentProcessIdentity, PROCESS_IDENTITY, recordedProcessState } from '../native-runtime/process-identity.js';

// The lock one process holds while it downloads one asset: a directory whose
// holder.json names the process (PID, start time, command) and a token of
// its own. It is prepared under a unique name and renamed into place, so it is
// never seen without its holder. In a rare race (a lock judged abandoned by its
// age while its holder releases it and another takes a new one) two processes
// may each believe they hold it; each writes its own staging file and publishes
// only a copy it verified (executable-download.js), so that does no harm.
//
// A lock is abandoned when its holder has ended (or its PID is now another
// program), or when it is older than `abandonedAfterMs`. An abandoned lock is
// taken over one taker at a time (a `.takeover` directory): it is read again,
// moved aside under a unique name only while it is still the one judged, and
// removed. A holder releases its lock only while it still holds its token.
const HOLDER = 'holder.json';
// A take-over lasts milliseconds; one older than this was left by a killed taker.
const TAKEOVER_ABANDONED_MS = 60_000;
// What a rename onto a lock that exists answers: EEXIST/ENOTEMPTY on POSIX, EPERM on Windows.
const LOCK_EXISTS = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM']);
// What Windows answers when a lock is moved while another process has its holder.json open (a waiter
// reading it): tried again this many times, a wait apart.
const LOCK_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const BUSY_ATTEMPTS = 5;

// Answers { token, release() } once this process holds the lock. While a
// live holder downloads it calls onWait() once and waits (wait(signal)), or
// answers null at once when waitForOthers is false. signal aborts the wait.
// release() answers whether it removed the lock: one Windows keeps refusing to
// move stays, and is taken over once this process has ended.
export async function acquireDownloadLock(path, { abandonedAfterMs, now = Date.now, wait, signal, onWait = () => {},
  waitForOthers = true, identity = PROCESS_IDENTITY, identify = currentProcessIdentity }) {
  const token = randomUUID();
  const holder = JSON.stringify({ ...await identify(), token });
  let announced = false;
  for (;;) {
    signal?.throwIfAborted();
    if (await create(path, token, holder)) {
      await removeLeftovers(path, now(), abandonedAfterMs);
      return { token, release: () => moveAsideIfHeld(path, token, 'released', () => wait()) };
    }
    const held = await readLock(path);
    // Refused although no lock is there: one is being moved aside right now.
    if (!held) { await wait(signal); continue; }
    const abandoned = now() - held.since >= abandonedAfterMs || await recordedProcessState(held.holder, identity) === 'gone';
    if (abandoned && await takeOver(path, held.token, identity, now, () => wait(signal))) continue;
    if (!abandoned && !waitForOthers) return null;
    if (!abandoned && !announced) { announced = true; onWait(); }
    await wait(signal);
  }
}

async function create(path, token, holder) {
  const prepared = `${path}.new-${token}`;
  await mkdir(prepared, { mode: 0o700 });
  try {
    await writeFile(join(prepared, HOLDER), holder, { flag: 'wx', mode: 0o600 });
    try { await rename(prepared, path); return true; }
    catch (error) { if (LOCK_EXISTS.has(error.code)) return false; throw error; }
  } finally {
    await rm(prepared, { recursive: true, force: true });
  }
}

// The lock as it stands, or null when there is none. token and holder are
// null for a lock an older FULI took (an empty directory).
async function readLock(path) {
  let since;
  try { since = (await stat(path)).mtimeMs; } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let recorded = null;
  try { recorded = JSON.parse(await readFile(join(path, HOLDER), 'utf8')); } catch { /* an older lock records no holder */ }
  return { since, token: typeof recorded?.token === 'string' ? recorded.token : null,
    holder: Number.isInteger(recorded?.pid) && recorded.pid > 0 ? recorded : null };
}

// Under the take-over directory, moves the judged lock aside. Answers whether it did.
async function takeOver(path, judged, identity, now, wait) {
  const takeover = `${path}.takeover`;
  try { await mkdir(takeover, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await clearAbandonedTakeover(takeover, identity, now);
    return false;
  }
  try {
    await writeFile(join(takeover, 'pid'), String(process.pid), { mode: 0o600 });
    return await moveAsideIfHeld(path, judged, 'stale', wait);
  } finally {
    await rm(takeover, { recursive: true, force: true });
  }
}

async function clearAbandonedTakeover(takeover, identity, now) {
  let pid = null, since;
  try { since = (await stat(takeover)).mtimeMs; } catch { return; }
  try { pid = Number(await readFile(join(takeover, 'pid'), 'utf8')); } catch { /* killed before it wrote its PID */ }
  const ended = Number.isInteger(pid) && pid > 0 && identity.state(pid) === 'gone';
  if (ended || now() - since >= TAKEOVER_ABANDONED_MS) await rm(takeover, { recursive: true, force: true });
}

// Moves the lock aside under a unique name while it still carries `token`,
// then removes it. A lock replaced between the read and the move is put
// back. Answers whether the lock was removed; a move Windows still refuses
// after BUSY_ATTEMPTS leaves it where it is.
async function moveAsideIfHeld(path, token, why, wait) {
  if ((await readLock(path))?.token !== token) return false;
  const aside = `${path}.${why}-${process.pid}-${randomUUID()}`;
  for (let attempt = 1; ; attempt += 1) {
    try { await rename(path, aside); break; }
    catch (error) {
      if (error.code === 'ENOENT' || (LOCK_BUSY.has(error.code) && attempt >= BUSY_ATTEMPTS)) return false;
      if (!LOCK_BUSY.has(error.code)) throw error;
      await wait();
    }
  }
  if ((await readLock(aside))?.token === token) {
    await rm(aside, { recursive: true, force: true });
    return true;
  }
  // Another holder's lock: back where it was, or left aside when a new lock took its place.
  await rename(aside, path).catch(() => {});
  return false;
}

// What killed takers and holders left beside the lock, once older than any of them may run.
async function removeLeftovers(path, now, abandonedAfterMs) {
  const prefix = `${basename(path)}.`;
  let names;
  try { names = await readdir(dirname(path)); } catch { return; }
  for (const name of names.filter((entry) => /^(?:new|stale|released)-/.test(entry.slice(prefix.length)) && entry.startsWith(prefix))) {
    const leftover = join(dirname(path), name);
    try { if (now - (await lstat(leftover)).mtimeMs >= abandonedAfterMs) await rm(leftover, { recursive: true, force: true }); }
    catch { /* gone already */ }
  }
}
