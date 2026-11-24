// How often one source address may present a missing or wrong guest token:
// FAILURES_ALLOWED times in WINDOW_MS, then every request from it is refused
// until its oldest failure leaves the window. Kept in memory: a token is 256
// random bits, so this only keeps a guessing loop off the store and the log.
// At most ADDRESSES_TRACKED addresses are remembered; past that the address
// whose last failure is oldest is forgotten first.
const WINDOW_MS = 10 * 60 * 1000;
const FAILURES_ALLOWED = 10;
const ADDRESSES_TRACKED = 4096;

export function createFailedBearerLimit({ now = Date.now } = {}) {
  const failures = new Map();

  const recent = (address) => {
    const cutoff = now() - WINDOW_MS;
    const kept = (failures.get(address) ?? []).filter(at => at > cutoff);
    if (kept.length) failures.set(address, kept);
    else failures.delete(address);
    return kept;
  };

  return {
    blocked: address => recent(address).length >= FAILURES_ALLOWED,
    fail(address) {
      const kept = recent(address);
      failures.delete(address);
      failures.set(address, [...kept, now()]);
      if (failures.size > ADDRESSES_TRACKED) failures.delete(failures.keys().next().value);
    }
  };
}
