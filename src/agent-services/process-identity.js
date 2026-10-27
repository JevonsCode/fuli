import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { isProcessAlive } from '../local-runtime/processes.js';
import { OWNED_PROCESS_TYPE, powershell } from '../local-runtime/windows-process-handle.js';

// Who a recorded service process is, read from the OS: an exact identity (its
// start time), its executable and its command line. A service FULI does not
// own is stopped only while all three still match what was recorded, so a
// reused PID or another program is never ended (rec#11 D-71).
// - win32: the creation time from Win32_Process to the microsecond; the stop
//   opens one handle, checks the creation time and the executable on it and
//   terminates through it ([FuliOwnedProcess]::Stop), so a PID reused after
//   the check cannot be ended instead.
// - linux: boot id and starttime ticks from /proc; the stop checks again and
//   signals SIGTERM.
// - darwin: ps lstart read with TZ=UTC and LC_ALL=C, so a time zone or locale
//   change does not alter it; the stop checks again and signals SIGTERM.
// inspect answers null when the OS could not be asked at all.
const PS_TIMEOUT_MS = 5000;
// After SIGTERM, how long a stop waits for the process to end.
const STOP_WAIT_MS = 5000;
const STOP_POLL_MS = 100;

export function createProcessInspector({ platform = process.platform } = {}) {
  const adapter = { win32: windowsAdapter, linux: linuxAdapter, darwin: darwinAdapter }[platform] ?? null;

  // Map<pid, { identity, executable, commandLine }> of the PIDs that exist.
  async function inspect(pids) {
    const wanted = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
    if (!wanted.length) return new Map();
    if (!adapter) return null;
    try {
      return await adapter.inspect(wanted);
    } catch {
      return null;
    }
  }

  // Ends the recorded process only when it is still the one recorded:
  // 'stopped', 'mismatch' (gone, or another process now) or 'still_running'
  // (asked to stop, not ended yet).
  async function terminate(recorded) {
    const current = (await inspect([recorded.pid]))?.get(recorded.pid);
    if (!current || !sameProcess(recorded, current)) return 'mismatch';
    if (adapter.stop) {
      try {
        return (await adapter.stop(recorded)) === true ? 'stopped' : 'mismatch';
      } catch {
        return 'still_running';
      }
    }
    try {
      process.kill(recorded.pid, 'SIGTERM');
    } catch {
      return 'mismatch';
    }
    for (let waited = 0; waited < STOP_WAIT_MS; waited += STOP_POLL_MS) {
      if (!isProcessAlive(recorded.pid)) return 'stopped';
      await delay(STOP_POLL_MS);
    }
    return 'still_running';
  }

  return { inspect, terminate };
}

// The recorded process and the one the OS shows now are the same: the exact
// identity, the executable and the command line all match.
export function sameProcess(recorded, current) {
  return Boolean(recorded.pidIdentity) && recorded.pidIdentity === current.identity
    && sameText(recorded.executable, current.executable) && (recorded.commandLine ?? null) === (current.commandLine ?? null);
}

const sameText = (left, right) => String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();

const windowsAdapter = {
  async inspect(pids) {
    const rows = await powershell(`$found = @(Get-CimInstance Win32_Process -Filter "${pids.map((pid) => `ProcessId=${pid}`).join(' OR ')}" | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; created = $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc().ToString() } else { '' }); executable = $_.ExecutablePath; commandLine = $_.CommandLine } })
ConvertTo-Json -Compress -Depth 3 -InputObject $found`);
    return new Map((Array.isArray(rows) ? rows : rows ? [rows] : []).map((row) => [row.pid, {
      identity: /^\d{1,20}$/.test(row.created ?? '') ? `win32:${row.created}` : null,
      executable: row.executable ?? null, commandLine: row.commandLine ?? null }]));
  },
  // The executable and command line were compared just before; Stop checks
  // the exact creation time again on the handle it terminates through, so a
  // PID reused since then is never ended. Its image check takes the path
  // through that same API, since Win32_Process shows a linked path unresolved.
  async stop({ pid, pidIdentity }) {
    const created = pidIdentity.slice('win32:'.length);
    return powershell(`${OWNED_PROCESS_TYPE}
ConvertTo-Json -Compress -InputObject ([FuliOwnedProcess]::Stop(${pid}, ${created}, [FuliOwnedProcess]::Image(${pid})))`);
  }
};

const linuxAdapter = {
  async inspect(pids) {
    const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
    const boot = read('/proc/sys/kernel/random/boot_id')?.trim();
    const found = new Map();
    for (const pid of pids) {
      const stat = read(`/proc/${pid}/stat`);
      if (!stat) continue;
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      if (['Z', 'X'].includes(fields[0])) continue;
      let executable = null;
      try { executable = readlinkSync(`/proc/${pid}/exe`); } catch { /* another user's process */ }
      found.set(pid, { identity: boot && /^\d+$/.test(fields[19] ?? '') ? `linux:${boot}:${fields[19]}` : null, executable,
        commandLine: read(`/proc/${pid}/cmdline`)?.split('\0').filter(Boolean).join(' ') || null });
    }
    return found;
  }
};

const darwinAdapter = {
  inspect(pids) {
    return new Promise((resolve, reject) => execFile('ps', ['-p', pids.join(','), '-o', 'pid=,stat=,lstart=,command='], {
      encoding: 'utf8', timeout: PS_TIMEOUT_MS, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }
    }, (error, stdout) => {
      // ps exits 1 when none of the PIDs exists.
      if (error && error.code !== 1) return reject(error);
      const found = new Map();
      for (const line of stdout.split('\n')) {
        // lstart is five fields: Tue Oct 27 10:15:30 2026.
        const match = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
        if (!match || match[2].startsWith('Z')) continue;
        found.set(Number(match[1]), { identity: `darwin:${match[3].replace(/\s+/g, ' ')}`, executable: null, commandLine: match[4] });
      }
      resolve(found);
    }));
  }
};
