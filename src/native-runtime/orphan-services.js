import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

import { listenerPids, processGroup } from './macos-ports.js';

// A graph service of this data directory left running when FULI lost track of
// it: a start that was killed after it spawned Neo4j or the Provider, with
// `processes.json` emptied, so the service kept the data directory's port and
// every later start refused to begin (「port … is already in use」) until a
// person found and ended it by hand.
//
// Such a process is recognised by where it runs, not by its name: every native
// graph service FULI starts runs with its working directory in the data
// directory's own instance folder (runtime.js spawnNativeDatabase and
// spawnNativeProvider), detached in a process group of its own. Only a
// listener whose working directory, and whose process group's leader's, is in
// that instance folder is ended, the whole group at once and gracefully first
// (stopOwnedProcess). Anything else on the port is left untouched for the
// start to report as before. macOS only: there the start checks its ports.
//
// stop: how a process group FULI started is ended (runtime.js stopOwnedProcess).
// Answers the processes it ended, as [{ port, pid, group }].
export async function stopOrphanedServices({ instanceDir, ports, listeners = listenerPids, groupOf = processGroup,
  cwdOf = processWorkingDirectory, stop, record = () => false }) {
  const home = canonical(instanceDir);
  if (!home) return [];
  const ended = [];
  for (const port of ports) {
    const pids = await listeners(port);
    if (pids.length !== 1) continue;
    const [pid] = pids;
    if (!inside(home, await cwdOf(pid).catch(() => null))) continue;
    const group = await groupOf(pid).catch(() => null);
    if (!Number.isInteger(group) || group <= 0 || !inside(home, await cwdOf(group).catch(() => null))) continue;
    await stop(group);
    ended.push({ port, pid, group });
    record({ component: 'native-runtime', operation: 'native.orphan', outcome: 'stopped', code: 'orphaned_graph_service',
      port, pid });
  }
  return ended;
}

// The working directory of a process, from lsof; null when it cannot be read.
export function processWorkingDirectory(pid) {
  return new Promise((resolve, reject) => execFile('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
    { encoding: 'utf8', timeout: 10_000 }, (error, stdout) => {
      if (error) { reject(error); return; }
      const line = String(stdout).split('\n').find((entry) => entry.startsWith('n'));
      resolve(line ? line.slice(1) : null);
    }));
}

function inside(home, path) {
  const real = canonical(path);
  if (!real) return false;
  const rel = relative(home, real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function canonical(path) {
  if (typeof path !== 'string' || !path) return null;
  try { return realpathSync(path); } catch { return null; }
}
