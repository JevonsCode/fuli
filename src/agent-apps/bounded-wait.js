import { setTimeout as delay } from 'node:timers/promises';

// Whether work settles (either way) within ms. The timer is cleared as soon
// as the work settles.
export async function settledWithin(work, ms) {
  const timeout = new AbortController();
  try {
    return await Promise.race([work.then(() => true, () => true),
      delay(ms, false, { signal: timeout.signal }).catch(() => false)]);
  } finally {
    timeout.abort();
  }
}
