import { execFile } from 'node:child_process';

// Inspect all listening addresses, including wildcard/IPv6 sockets. Never signal
// a listener while checking it. lsof failure is unknown, never a free port.
export async function listenerPids(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid native service port.');
  const text = await new Promise((resolve, reject) => execFile('/usr/sbin/lsof', [
    '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && !(error.code === 1 && !stdout.trim() && !stderr.trim())) {
      reject(new Error('Unable to inspect macOS native port ownership.', { cause: error }));
    } else resolve(stdout);
  }));
  return [...new Set(text.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
}

// A port another program holds: said in both languages, with who holds it and a
// reason a client can show (the same `port_taken` Windows native and container
// mode give). A graph service of this data directory that FULI lost track of is
// told apart before this (orphan-services.js) and offered 「结束它并启动」.
export async function assertMacNativePortFree(port, { listeners = listenerPids, describe = describeProcess } = {}) {
  const [pid] = await listeners(port);
  if (pid === undefined) return;
  const holder = await describe(pid).catch(() => ({}));
  const who = holder.command ? `${holder.command}（进程 ${pid}）` : `（进程 ${pid}）`;
  throw Object.assign(new Error(`FULI 要用的端口 ${port} 已被别的程序 ${who}占用，FULI 没有动它，也没有启动这个服务。`
    + `请结束那个程序，或在设置里换一个端口。 / Native service port ${port} is already in use; its owner was left untouched.`), {
    code: 'port_taken',
    startupFailure: { code: 'port_taken', port, pid, command: holder.command ?? null, runningSeconds: holder.runningSeconds ?? null }
  });
}

// The command name of a process and how long it has run, from ps; read only.
async function describeProcess(pid) {
  const text = await new Promise((resolve, reject) => execFile('/bin/ps', ['-p', String(pid), '-o', 'etime=,comm='], {
    encoding: 'utf8', timeout: 10_000
  }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
  const [elapsed, ...command] = text.trim().split(/\s+/);
  return { runningSeconds: elapsedSeconds(elapsed), command: command.join(' ').split('/').pop() || null };
}

// ps elapsed time, [[dd-]hh:]mm:ss, in seconds; null when it is not one.
export function elapsedSeconds(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(value ?? ''));
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match.map((part) => (part === undefined ? undefined : Number(part)));
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

export async function assertMacNativePortOwner(entry, port) {
  if (!Number.isInteger(entry?.pid) || entry.pid <= 0) throw new Error('Missing native process PID identity.');
  const pids = await listenerPids(port);
  if (pids.length === 1 && pids[0] === entry.pid) return;
  if (pids.length === 1) {
    const group = await processGroup(pids[0]);
    // Unix Neo4j scripts retain a launcher and fork Java. Detached spawning
    // gives this installation a private process group, also used by stop.
    if (group === entry.pid && await processGroup(entry.pid) === entry.pid) return;
  }
  throw new Error(`Native service port ${port} ownership could not be verified.`);
}

export async function processGroup(pid) {
  return new Promise((resolve, reject) => execFile('/bin/ps', ['-p', String(pid), '-o', 'pgid='], {
    encoding: 'utf8', timeout: 10_000
  }, (error, stdout) => {
    if (error) reject(new Error('Unable to verify native process group.', { cause: error }));
    else resolve(Number(stdout.trim()));
  }));
}
