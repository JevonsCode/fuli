import { setTimeout as delay } from 'node:timers/promises';

const PROVIDER_READY_ATTEMPTS = 120;
const PROVIDER_READY_INTERVAL_MS = 1000;
const PROVIDER_HEALTH_TIMEOUT_MS = 2500;
const MANAGED_PROVIDER_PORT = '8788';
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Polls the Provider health route until it answers. Neo4j recovery and index
// initialization can take a while after a cold start, so failures are retried.
export async function waitForProviderHealth(url, {
  fetchImpl = fetch,
  wait = delay,
  attempts = PROVIDER_READY_ATTEMPTS,
  failureMessage
}) {
  const healthUrl = `${String(url).replace(/\/$/, '')}/health`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(healthUrl, {
        signal: AbortSignal.timeout(PROVIDER_HEALTH_TIMEOUT_MS)
      });
      if (response.ok) return;
    } catch {
      // The Provider is still starting.
    }
    if (attempt < attempts - 1) await wait(PROVIDER_READY_INTERVAL_MS);
  }
  throw new Error(failureMessage);
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
