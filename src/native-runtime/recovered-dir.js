import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { mkdir, rename, statfs } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

// native-runtime/recovered/: what a recovery sets aside instead of deleting it
// (src/native-runtime/neo4j-recovery.js). Each recovery has its own folder,
// recovered/<time>/, with the directories it moved, the switch journal and
// the descriptor as it was before the recovery wrote it; beside it,
// recovered/recovery-<time>.json records what that recovery did.
//
// Moved programs take hundreds of MB, so a recovery also permanently deletes
// old folders, after it released the lock: one goes only when at least
// KEEP_RUNS newer ones exist and it is older than KEEP_DAYS. The recovery's
// plan lists each one, with both numbers, before anything happens. A folder
// that holds any graph instance's databases or transaction logs is never
// deleted by that rule: it may be the only copy of a graph, so only a person
// deletes it (graphDataFolders says where it is and how to move it back). The
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
// Bytes free on the disk that holds [path].
export async function diskFree(path) {
  const { bavail, bsize } = await statfs(path);
  return bavail * bsize;
}

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
    .filter(name => now - stampTime(name) >= KEEP_DAYS * DAY_MS && !graphStoresIn(recoveryFolder(root, name)).length)
    .reverse()
    .map(name => ({ path: recoveryFolder(root, name), bytes: diskSize(recoveryFolder(root, name)), keepRuns: KEEP_RUNS, keepDays: KEEP_DAYS }));
}

// Where an instance keeps its graph: the databases, and the transaction logs
// (FULI's neo4j.conf puts them in <instance>/transactions; Neo4j's own default,
// which older layouts used, is data/transactions).
export const GRAPH_STORE_DIRS = Object.freeze([['data', 'databases'], ['transactions'], ['data', 'transactions']]);

// An instance's database and its transaction logs (GRAPH_STORE_DIRS), whether or not they exist.
export function instanceGraphStores(paths, id) {
  const instance = id === 'personal' ? paths.nativePersonalDir : paths.nativeWorkspaceDir;
  return GRAPH_STORE_DIRS.map(parts => join(instance, ...parts, 'neo4j'));
}

// Sets [path], inside the native runtime [root], aside into the recovery
// [folder] at the same path relative to the runtime — beside, never over,
// what an earlier run already put there. Nothing to do when it is gone.
export async function setAsideInto(root, folder, path) {
  if (!existsSync(path)) return;
  const to = join(folder, relative(root, path));
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await rename(path, existsSync(to) ? `${to}-${Date.now()}` : to);
}

// The graph data a recovery moved into [folder]: each store under an instance
// directory (personal, workspace), as { instance, from, to } — where it is now
// and, given the native runtime [root], where it came from (a recovery keeps
// the path relative to the runtime when it moves something). A store moved
// beside an earlier one carries a time suffix (neo4j-<ms>); it goes back
// under its own name, neo4j, all the same.
export function graphStoresIn(folder, root = null) {
  const stores = [];
  for (const instance of listNames(folder)) {
    for (const parts of GRAPH_STORE_DIRS) {
      const dir = join(folder, instance, ...parts);
      if (!isDirectory(dir)) continue;
      const names = listNames(dir);
      const home = root ? join(root, instance, ...parts) : null;
      for (const name of names.length ? names : [null]) {
        stores.push({ instance, from: name ? join(dir, name) : dir, to: home && (name ? join(home, /^neo4j-\d+$/.test(name) ? 'neo4j' : name) : home) });
      }
    }
  }
  return stores;
}

// Every recovery folder that holds graph data, oldest first: where it is, how
// big, which instances, and where each store goes back to. A person deletes
// these; the clean-up never does.
export function graphDataFolders(root) {
  return listNames(join(root, RECOVERED)).filter(name => STAMP.test(name)).sort().flatMap((name) => {
    const path = recoveryFolder(root, name);
    const stores = graphStoresIn(path, root);
    return stores.length ? [{ path, bytes: diskSize(path), instances: [...new Set(stores.map(({ instance }) => instance))], stores }] : [];
  });
}

function isDirectory(path) {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
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
