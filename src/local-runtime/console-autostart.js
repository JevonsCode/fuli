import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { inspectLocalStores } from '../data-format/local-stores.js';
import { holdDataDirectory } from '../data-format/maintenance-lock.js';
import { readJsonFile } from '../storage/json-file.js';
import { acquireConsoleStartLock, readConsoleAutostart, updateConsoleAutostart } from './console-autostart-record.js';
import { installedConsoleLauncher } from './installed-console-launcher.js';
import { isProcessAlive } from './processes.js';

// A client session's MCP process starts the FULI console when it is not
// running, and keeps checking while the session stays open (rec#94), the way
// the desktop client does (fuli_controller.dart). Every session of one data
// directory shares one lock and one record (console-autostart-record.js), so
// only one of them starts it. It never starts a console the person stopped
// on purpose, one whose data waits for the person's format confirmation, or a
// whole-store restore's data; and after 3 starts within 10 minutes it stops
// trying until the person starts FULI.

export const CONSOLE_AUTOSTART_LIMITS = Object.freeze({
  starts: 3,
  windowMs: 10 * 60_000,
  // A start in progress (Neo4j can take a minute) is not started again.
  startingMs: 2 * 60_000,
  checkEveryMs: 15_000,
  firstCheckMs: 1_000
});
const CONSOLE_AUTOSTART_ENV = 'FULI_CONSOLE_AUTOSTART';
// The local store states a person has to act on (format-notices.js).
const WAITING_STORE_STATES = new Set(['pending_confirmation', 'half_applied', 'newer_format', 'unsupported']);

// check() → running | stopped_by_person | not_configured | unreadable | busy
//   | starting | gave_up | needs_person | started. Synchronous: it reads small
// files and spawns at most one detached process.
export function consoleAutostart({ dataDir, launcher, now = Date.now, limits = CONSOLE_AUTOSTART_LIMITS,
  consoleRunning = () => recordedConsoleAlive(dataDir), configured = () => existsSync(join(dataDir, 'graph-runtime.json')),
  lock = () => acquireConsoleStartLock(dataDir), waitsForPerson = () => dataWaitsForPerson(dataDir) }) {
  return {
    check() {
      if (consoleRunning()) return 'running';
      const seen = readConsoleAutostart(dataDir);
      if (seen.unreadable) return 'unreadable';
      if (seen.stoppedAt) return 'stopped_by_person';
      if (!configured()) return 'not_configured';
      let release;
      try { release = lock(); } catch (error) {
        if (error?.code === 'file_lock_busy') return 'busy';
        throw error;
      }
      try {
        // Another session may have started it while this one waited.
        if (consoleRunning()) return 'running';
        return startUnderLock();
      } finally { release(); }
    }
  };

  function startUnderLock() {
    const at = now();
    const record = readConsoleAutostart(dataDir);
    if (record.unreadable) return 'unreadable';
    if (record.stoppedAt) return 'stopped_by_person';
    if (record.held?.reason === 'gave_up') return 'gave_up';
    const recent = record.starts.filter(start => at - Date.parse(start) < limits.windowMs);
    if (recent.some(start => at - Date.parse(start) < limits.startingMs)) return 'starting';
    if (recent.length >= limits.starts) {
      hold('gave_up', at);
      return 'gave_up';
    }
    if (waitsForPerson()) {
      hold('data_format', at);
      return 'needs_person';
    }
    // Written inside the record's own lock: a person's stop saved meanwhile wins.
    const written = updateConsoleAutostart(dataDir, current => current.stoppedAt ? undefined
      : { ...current, starts: [...recent, new Date(at).toISOString()], held: null });
    if (written.stoppedAt) return 'stopped_by_person';
    launcher.start();
    return 'started';
  }

  function hold(reason, at) {
    updateConsoleAutostart(dataDir, current => current.stoppedAt || current.held?.reason === reason ? undefined
      : { ...current, held: { reason, at: new Date(at).toISOString() } });
  }
}

// Starts checking for this MCP process; returns the stop. Nothing runs for a
// package that is not an installed FULI, or with FULI_CONSOLE_AUTOSTART=off.
export function superviseConsole({ dataDir, env = process.env, limits = CONSOLE_AUTOSTART_LIMITS,
  launcher = installedConsoleLauncher({ dataDir, env }), setTimer = setTimeout, clearTimer = clearTimeout,
  onError = () => {}, ...dependencies }) {
  if (env[CONSOLE_AUTOSTART_ENV] === 'off' || !launcher) return () => {};
  const autostart = consoleAutostart({ dataDir, launcher, limits, ...dependencies });
  let timer = null, stopped = false;
  const schedule = delayMs => {
    if (stopped) return;
    timer = setTimer(tick, delayMs);
    timer?.unref?.();
  };
  function tick() {
    try { autostart.check(); } catch (error) { onError(error); }
    schedule(limits.checkEveryMs);
  }
  schedule(limits.firstCheckMs);
  return () => { stopped = true; if (timer !== null) clearTimer(timer); };
}

function recordedConsoleAlive(dataDir) {
  let state;
  try { state = readJsonFile(join(dataDir, 'graph-runtime-state.json'), null); } catch { return false; }
  return Number.isInteger(state?.pid) && isProcessAlive(state.pid);
}

// A whole-store restore holding the data directory, or a local store whose
// format step waits for the person: the console stays for the person to start.
function dataWaitsForPerson(dataDir) {
  try { holdDataDirectory(dataDir)(); } catch { return true; }
  try {
    return inspectLocalStores(dataDir).some(store => WAITING_STORE_STATES.has(store.state));
  } catch {
    return true;
  }
}
