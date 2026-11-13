import { performance } from 'node:perf_hooks';

import { PeerError } from './protocol.js';

// Every nearby pairing handshake this computer takes part in (a nonce it gives
// to a requesting device, or a pairing its person starts) is one attempt.
// Attempts are kept with their time in the computer's own store, so turning
// nearby pairing off and on, or restarting FULI, does not forget them; they
// only age out, or the person on this computer clears them (local only).
//
// Time here never runs backward. While FULI runs, it advances only with the
// process's monotonic clock: setting the system clock back or forward changes
// nothing. Across restarts it starts from the later of the system clock and
// the latest time already stored (a high-water mark), so a clock set back is
// measured from that mark. An entry stored later than that is counted as now.
// What remains: a system clock moved forward while FULI is stopped ages the
// count by that much once.
const WINDOW_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
export const ATTEMPT_LIMITS = Object.freeze({ perDeviceWindow: 3, window: 5, day: 10 });

export function createAttemptLedger({ read, update, clock = Date.now, monotonic = () => performance.now() }) {
  let anchor = null;

  // This process's own time: the start point plus monotonic time since.
  function now(stored) {
    anchor ??= { at: Math.max(clock(), stored.highWater), mono: monotonic() };
    return Math.max(anchor.at + (monotonic() - anchor.mono), stored.highWater);
  }

  // At most ATTEMPT_LIMITS.day entries are ever kept, so a scan is a scan of at most ten.
  function current(value, at) {
    const stored = shape(value);
    const time = at ?? now(stored);
    const entries = stored.entries.map((entry) => ({ key: entry.key, at: Math.min(entry.at, time) }))
      .filter((entry) => entry.at > time - DAY_MS);
    return { time, entries, window: entries.filter((entry) => entry.at > time - WINDOW_MS) };
  }

  function summary() {
    const { entries, window } = current(read());
    return { lastWindow: window.length, lastDay: entries.length,
      limited: window.length >= ATTEMPT_LIMITS.window || entries.length >= ATTEMPT_LIMITS.day };
  }

  // Checks and counts in one immediate store transaction: no other request,
  // and no other process on this data directory, can pass between them.
  function take(key) {
    update((value) => {
      const { time, entries, window } = current(value);
      if (entries.length >= ATTEMPT_LIMITS.day || window.length >= ATTEMPT_LIMITS.window
        || window.filter((entry) => entry.key === key).length >= ATTEMPT_LIMITS.perDeviceWindow) {
        throw new PeerError('pairing_rate_limited', 'Too many pairing attempts on this computer; wait, or clear them on this computer', 429);
      }
      return { entries: [...entries, { key, at: time }], highWater: time };
    });
  }

  // The person's own reset keeps the high-water mark: a clock set back stays measured from it.
  function clear() {
    update((value) => ({ entries: [], highWater: now(shape(value)) }));
  }

  return { take, summary, clear };
}

// The stored list, or an earlier plain array of entries, or nothing usable.
function shape(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.entries) ? value.entries : [];
  const entries = list.filter((entry) => typeof entry?.key === 'string' && Number.isFinite(entry.at));
  const highWater = Math.max(Number.isFinite(value?.highWater) ? value.highWater : 0, ...entries.map((entry) => entry.at), 0);
  return { entries, highWater };
}
