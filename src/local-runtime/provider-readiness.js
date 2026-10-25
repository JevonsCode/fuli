import { setTimeout as delay } from 'node:timers/promises';

const PROVIDER_READY_TIMEOUT_MS = 120_000;
const PROVIDER_READY_INTERVAL_MS = 1000;
const PROVIDER_HEALTH_TIMEOUT_MS = 2500;
const MANAGED_PROVIDER_PORT = '8788';
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Polls `isReady(budgetMs)` until it answers true or `timeoutMs` of wall-clock
// time has passed, pausing `intervalMs` between probes. Each probe gets at most
// `probeTimeoutMs` and never more than the time left, so a slow probe cannot run
// past the deadline. `abandon` is checked before each probe, so a wait on a
// process that exits stops at the next check. Answers 'ready', 'abandoned' or
// 'timed_out' so each caller words the failure for its own service.
export async function waitUntilReady(isReady, {
  timeoutMs,
  intervalMs,
  probeTimeoutMs,
  wait = delay,
  now = Date.now,
  abandon = () => false
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await abandon()) return 'abandoned';
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return 'timed_out';
    if (await isReady(Math.min(probeTimeoutMs, remainingMs))) return 'ready';
    const leftMs = deadline - now();
    if (leftMs <= 0) return 'timed_out';
    await wait(Math.min(intervalMs, leftMs));
  }
}

// Polls the Provider health route until it answers. Neo4j recovery and index
// initialization can take a while after a cold start, so failures are retried.
export async function waitForProviderHealth(url, {
  fetchImpl = fetch,
  wait = delay,
  now = Date.now,
  timeoutMs = PROVIDER_READY_TIMEOUT_MS,
  failureMessage
}) {
  const healthUrl = `${String(url).replace(/\/$/, '')}/health`;
  const outcome = await waitUntilReady(async (budgetMs) => {
    try {
      const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(budgetMs) });
      return response.ok;
    } catch {
      return false; // The Provider is still starting.
    }
  }, { timeoutMs, intervalMs: PROVIDER_READY_INTERVAL_MS, probeTimeoutMs: PROVIDER_HEALTH_TIMEOUT_MS, wait, now });
  if (outcome !== 'ready') throw new Error(failureMessage);
}

// A workspace whose Provider is the locally managed development instance.
export function isManagedWorkspace(workspace) {
  if (workspace?.managedDevelopment === true) return true;
  try {
    const url = new URL(workspace?.providerUrl);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname) && url.port === MANAGED_PROVIDER_PORT;
  } catch {
    return false;
  }
}
