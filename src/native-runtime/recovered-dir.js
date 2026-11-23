import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// native-runtime/recovered/: what a recovery sets aside instead of deleting it
// (src/native-runtime/neo4j-recovery.js). Each recovery has its own folder,
// recovered/<time>/, with the directories it moved, the switch journal and
// the descriptor as it was before the recovery wrote it; beside it,
// recovered/recovery-<time>.json records what that recovery did.
//
// Moved programs take hundreds of MB, so a recovery also permanently deletes
// old folders, after it released the lock: one goes only when at least
// KEEP_RUNS newer ones exist and it is older than KEEP_DAYS. The recovery's
// plan lists each one, with both numbers, before anything happens. The
// records are small and always kept.

const RECOVERED = 'recovered';
const KEEP_RUNS = 3;
const KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

// "2026-11-23T03-00-00-000Z": a time that sorts, and is a file name everywhere.
export function recoveryStamp(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

export function recoveryFolder(root, stamp) {
  return join(root, RECOVERED, stamp);
}

export function recoveryRecordPath(root, stamp) {
  return join(root, RECOVERED, `recovery-${stamp}.json`);
}

// Bytes under [path] (a file or a directory), without following links; 0 when it is gone.
export function diskSize(path) {
  let stat;
  try { stat = lstatSync(path); } catch { return 0; }
  if (!stat.isDirectory()) return stat.size;
  let names;
  try { names = readdirSync(path); } catch { return 0; }
  return names.reduce((total, name) => total + diskSize(join(path, name)), 0);
}

// The recovery folders the clean-up rule deletes now, oldest first, with their
// size and the rule itself (the words of the plan name both numbers).
export function expiredRecoveryFolders(root, now) {
  const folders = listNames(join(root, RECOVERED)).filter(name => STAMP.test(name)).sort().reverse();
  return folders.slice(KEEP_RUNS)
    .filter(name => now - stampTime(name) >= KEEP_DAYS * DAY_MS)
    .reverse()
    .map(name => ({ path: recoveryFolder(root, name), bytes: diskSize(recoveryFolder(root, name)), keepRuns: KEEP_RUNS, keepDays: KEEP_DAYS }));
}

// Whether [path] is one of the recovery folders, so a clean-up never reaches anything else.
export function isRecoveryFolder(root, path) {
  const name = path.slice(join(root, RECOVERED).length + 1);
  return path === recoveryFolder(root, name) && STAMP.test(name);
}

// The newest recovery record and how many there are, or null when no recovery ran.
export function recoveryRecords(root) {
  const records = listNames(join(root, RECOVERED)).filter(name => /^recovery-.+\.json$/.test(name)).sort();
  return records.length ? { count: records.length, latest: join(root, RECOVERED, records.at(-1)) } : null;
}

function stampTime(name) {
  const [, day, hours, minutes, seconds, millis] = STAMP.exec(name);
  return Date.parse(`${day}T${hours}:${minutes}:${seconds}.${millis}Z`);
}

// The names in [directory]; none when it is missing or unreadable.
export function listNames(directory) {
  try { return readdirSync(directory); } catch { return []; }
}
