import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';

import { OWNED_PROCESS_TYPE, powershell } from '../local-runtime/windows-process-handle.js';

// Which FULI process (console, standalone runner, CLI) holds an app's owner
// lease, and whether it still exists (rec#7 D-28.25, D-28.29, D-28.30). This is
// the one module of src/agent-apps that may look at another process: a probe
// answers alive, exited or unknown, and unknown is always treated as alive by
// the caller. A path, a heartbeat or a start time within a tolerance is never
// evidence; only an exact identity or the OS saying the process is gone is.
//
// Identities carry their platform as a prefix, and a prefix that is not this
// platform's (WSL and Windows sharing one registry) is unknown:
// - linux:<boot_id>:<pid namespace inode>:<starttime ticks>. A process in
//   another PID namespace is invisible here, so a namespace that differs from
//   ours, or that cannot be read, is unknown before any exit evidence is
//   looked at: ESRCH there says nothing about the owner.
// - win32:<creation FILETIME>, read through a handle opened for query and
//   wait only (GetProcessTimes), compared exactly; read-only.
// - darwin:unverified. ps prints lstart with tv_sec through localtime and
//   strftime, so a time zone or locale change alters it and it is not an
//   identity; macOS has no exact adapter yet, so only ESRCH or a zombie state
//   is evidence, and anything else is unknown.
// Other platforms have no adapter: their owner identity is unrecorded and
// every probe is unknown. Nothing here stops a process: --force would need a
// stable reference that both checks the identity and waits for the exit, and
// this version stops no FULI process on any platform (D-28.29, rec#11 D-36).

const UNVERIFIED_DARWIN = 'darwin:unverified';
const PS_TIMEOUT_MS = 5000;
const PS_STATE = 'stat=';

const LINUX_PROCFS = Object.freeze({
  readText: (path) => readFileSync(path, 'utf8'),
  readLink: (path) => readlinkSync(path)
});

const WINDOWS_PROCESSES = Object.freeze({
  created: (pid) => powershell(`${OWNED_PROCESS_TYPE}
ConvertTo-Json -Compress -InputObject ([FuliOwnedProcess]::Created(${pid}))`),
  probe: (pid, created) => powershell(`${OWNED_PROCESS_TYPE}
ConvertTo-Json -Compress -InputObject ([FuliOwnedProcess]::Probe(${pid}, ${created}))`)
});

function psState(pid) {
  return new Promise((resolve) => execFile('ps', ['-p', String(pid), '-o', PS_STATE], { encoding: 'utf8', timeout: PS_TIMEOUT_MS },
    (error, stdout) => resolve(error ? null : stdout.trim())));
}

// procfs, windows and readPsState are seams for synthetic tests; production uses
// this computer's.
export function createHostIdentity({
  platform = process.platform, procfs = LINUX_PROCFS, windows = WINDOWS_PROCESSES, readPsState = psState
} = {}) {
  const adapters = {
    linux: linuxAdapter(procfs),
    win32: windowsAdapter(windows),
    darwin: darwinAdapter(readPsState)
  };
  const adapter = adapters[platform] ?? null;

  // The identity a later probe compares exactly: of this process for an owner
  // lease, of an app process the trusted runner started for its instance.
  async function identify(pid) {
    return adapter ? adapter.identity(pid) : null;
  }

  // This process: what an owner lease records about its holder.
  async function self() {
    return { pid: process.pid, identity: await identify(process.pid), exePath: process.execPath };
  }

  async function probe({ pid, identity }) {
    if (!adapter || !Number.isInteger(pid) || pid <= 0 || typeof identity !== 'string'
      || !identity.startsWith(`${platform}:`)) return 'unknown';
    return adapter.probe(pid, identity);
  }

  return { platform, self, identify, probe };
}

// kill(pid, 0) sends no signal: it asks whether the PID exists here.
function signalProbe(pid) {
  try {
    process.kill(pid, 0);
    return 'present';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'absent';
    return error?.code === 'EPERM' ? 'present' : 'unknown';
  }
}

function linuxAdapter(procfs) {
  const read = (path) => {
    try { return procfs.readText(path); } catch { return null; }
  };
  const namespace = () => {
    try { return /^pid:\[(\d+)\]$/.exec(procfs.readLink('/proc/self/ns/pid'))?.[1] ?? null; } catch { return null; }
  };
  const bootId = () => read('/proc/sys/kernel/random/boot_id')?.trim() || null;
  // Fields after the last ')': state is field 3, starttime field 22.
  const stat = (pid) => {
    const text = read(`/proc/${pid}/stat`);
    const fields = text?.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
    return fields && fields.length >= 20 && /^\d+$/.test(fields[19]) ? { state: fields[0], starttime: fields[19] } : null;
  };

  return {
    async identity(pid) {
      const [boot, pidns, entry] = [bootId(), namespace(), stat(pid)];
      return boot && pidns && entry ? `linux:${boot}:${pidns}:${entry.starttime}` : null;
    },
    async probe(pid, identity) {
      const [, recordedBoot, recordedNamespace, recordedStart, ...rest] = identity.split(':');
      if (rest.length || !recordedBoot || !/^\d+$/.test(recordedNamespace ?? '') || !/^\d+$/.test(recordedStart ?? '')) return 'unknown';
      const pidns = namespace();
      if (!pidns || pidns !== recordedNamespace) return 'unknown';
      const boot = bootId();
      if (!boot) return 'unknown';
      if (boot !== recordedBoot) return 'exited';
      const signal = signalProbe(pid);
      if (signal === 'absent') return 'exited';
      if (signal === 'unknown') return 'unknown';
      const entry = stat(pid);
      if (!entry) return 'unknown';
      if (entry.state === 'Z' || entry.state === 'X') return 'exited';
      return entry.starttime === recordedStart ? 'alive' : 'exited';
    }
  };
}

const FILETIME = /^\d{1,20}$/;

function windowsAdapter(windows) {
  return {
    async identity(pid) {
      try {
        const created = await windows.created(pid);
        return typeof created === 'string' && FILETIME.test(created) ? `win32:${created}` : null;
      } catch { return null; }
    },
    async probe(pid, identity) {
      const created = identity.slice('win32:'.length);
      if (!FILETIME.test(created)) return 'unknown';
      try {
        const verdict = await windows.probe(pid, created);
        return verdict === 'alive' || verdict === 'exited' ? verdict : 'unknown';
      } catch { return 'unknown'; }
    }
  };
}

function darwinAdapter(readPsState) {
  return {
    async identity() { return UNVERIFIED_DARWIN; },
    async probe(pid, identity) {
      if (identity !== UNVERIFIED_DARWIN) return 'unknown';
      const signal = signalProbe(pid);
      if (signal === 'absent') return 'exited';
      if (signal === 'unknown') return 'unknown';
      const state = await readPsState(pid);
      return state?.startsWith('Z') ? 'exited' : 'unknown';
    }
  };
}
