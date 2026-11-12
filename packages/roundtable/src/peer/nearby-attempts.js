import { PeerError } from './protocol.js';

// Every nearby pairing handshake this computer takes part in (a nonce it gives
// to a requesting device, or a pairing its person starts) is one attempt.
// Attempts are kept with their time in the computer's own store, so turning
// nearby pairing off and on, or restarting FULI, does not forget them; they
// only age out, or the person on this computer clears them (local only).
const WINDOW_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
export const ATTEMPT_LIMITS = Object.freeze({ perDeviceWindow: 3, window: 5, day: 10 });

export function createAttemptLedger({ read, write, clock = Date.now }) {
  // At most ATTEMPT_LIMITS.day entries are ever kept, so a scan is a scan of at most ten.
  function recent() {
    const now = clock();
    const stored = read();
    return (Array.isArray(stored) ? stored : [])
      .filter((entry) => typeof entry?.key === 'string' && Number.isFinite(entry.at) && entry.at > now - DAY_MS && entry.at <= now);
  }

  function summary() {
    const entries = recent();
    const now = clock();
    const window = entries.filter((entry) => entry.at > now - WINDOW_MS).length;
    return { lastWindow: window, lastDay: entries.length,
      limited: window >= ATTEMPT_LIMITS.window || entries.length >= ATTEMPT_LIMITS.day };
  }

  // Checks and counts in one synchronous step: no other request can pass between them.
  function take(key) {
    const entries = recent();
    const now = clock();
    const window = entries.filter((entry) => entry.at > now - WINDOW_MS);
    if (entries.length >= ATTEMPT_LIMITS.day || window.length >= ATTEMPT_LIMITS.window
      || window.filter((entry) => entry.key === key).length >= ATTEMPT_LIMITS.perDeviceWindow) {
      throw new PeerError('pairing_rate_limited', 'Too many pairing attempts on this computer; wait, or clear them on this computer', 429);
    }
    write([...entries, { key, at: now }]);
  }

  return { take, summary, clear: () => write([]) };
}
