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
// Such a process is recognised by what it is, not by its name: every native
// graph service FULI starts runs from this data directory's own instance
// folder (runtime.js spawnNativeDatabase and spawnNativeProvider), detached in
// a process group of its own. A sole listener is this data directory's when
// its working directory or its command line (`ps -o command=`) is in that
// instance folder, and its process group's leader is too. Nothing is ended on
// sight: a start stops and says what holds the port, and offers to end it and
// start (`fuli start --end-orphaned-services`, the desktop app's
// 「结束它并启动」). Anything else on the port is left as it was, for the start
// to report as before. macOS only: there the start checks its ports.

// The processes of this data directory holding these ports, as [{ port, pid, group, command }].
export async function findOrphanedServices({ instanceDir, ports, listeners = listenerPids, groupOf = processGroup,
  cwdOf = processWorkingDirectory, commandOf = processCommand }) {
  const home = canonical(instanceDir);
  if (!home) return [];
  const ours = async (pid) => inside(home, await cwdOf(pid).catch(() => null))
    || mentions(home, instanceDir, await commandOf(pid).catch(() => null));
  const found = [];
  for (const port of ports) {
    const pids = await listeners(port);
    if (pids.length !== 1) continue;
    const [pid] = pids;
    if (!await ours(pid)) continue;
    const group = await groupOf(pid).catch(() => null);
    if (!Number.isInteger(group) || group <= 0 || (group !== pid && !await ours(group))) continue;
    found.push({ port, pid, group, command: shortCommand(await commandOf(pid).catch(() => null)) });
  }
  return found;
}

// Ends what findOrphanedServices found, each process group once, gracefully
// first (stop: runtime.js stopOwnedProcess), and records each in the data
// directory's diagnostics.
export async function endOrphanedServices(found, { stop, record = () => false }) {
  const groups = new Set();
  for (const service of found) {
    if (!groups.has(service.group)) {
      groups.add(service.group);
      await stop(service.group);
    }
    record({ component: 'native-runtime', operation: 'native.orphan', outcome: 'stopped', code: 'orphaned_graph_service',
      port: service.port, pid: service.pid });
  }
}

// Why the start stopped, in both languages, with what to do: one action the
// desktop app shows as a button, and the same as a command.
export const END_ORPHANS_ACTION = 'end-orphans-start';
export const END_ORPHANS_FLAG = '--end-orphaned-services';
export function orphanedServicesError(found) {
  const ports = found.map((service) => service.port).join(', ');
  return Object.assign(new Error(`本数据目录之前启动的图服务还在运行，占着端口 ${ports}（上次启动被中断后 FULI 没再记着它）。`
    + `点「结束它并启动」，或运行 fuli start ${END_ORPHANS_FLAG}。`
    + ` / A graph service this data directory started earlier is still running on port ${ports}`
    + ` (FULI lost track of it when an earlier start was interrupted). Choose "End it and start", or run`
    + ` \`fuli start ${END_ORPHANS_FLAG}\`.`), {
    code: 'orphaned_graph_service',
    startupFailure: { code: 'orphaned_graph_service', action: END_ORPHANS_ACTION,
      services: found.map(({ port, pid, command }) => ({ port, pid, command })) }
  });
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

// The command line of a process, from ps; read only.
export function processCommand(pid) {
  return new Promise((resolve, reject) => execFile('/bin/ps', ['-p', String(pid), '-o', 'command='],
    { encoding: 'utf8', timeout: 10_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim() || null))));
}

// Whether a command line names the instance folder as a path of its own (not a longer name that starts the same).
function mentions(home, instanceDir, command) {
  if (typeof command !== 'string') return false;
  return [home, instanceDir].some((folder) => folder && new RegExp(`${escapeRegExp(folder)}(?:[/\\s"'=]|$)`).test(command));
}

function shortCommand(command) {
  if (typeof command !== 'string') return null;
  const [program] = command.split(/\s+/);
  return program.split('/').pop() || null;
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
