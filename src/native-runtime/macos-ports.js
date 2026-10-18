import { execFile } from 'node:child_process';

// Inspect all listening addresses, including wildcard/IPv6 sockets. Never signal
// a listener while checking it. lsof failure is unknown, never a free port.
async function listenerPids(port) {
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

export async function assertMacNativePortFree(port) {
  if ((await listenerPids(port)).length) throw new Error(`Native service port ${port} is already in use; its owner was left untouched.`);
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

async function processGroup(pid) {
  return new Promise((resolve, reject) => execFile('/bin/ps', ['-p', String(pid), '-o', 'pgid='], {
    encoding: 'utf8', timeout: 10_000
  }, (error, stdout) => {
    if (error) reject(new Error('Unable to verify native process group.', { cause: error }));
    else resolve(Number(stdout.trim()));
  }));
}
