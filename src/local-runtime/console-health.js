// Whether the recorded FULI console answers as itself: its /api/health names
// the service and the PID that was recorded for it.

export const CONSOLE_HEALTH_TIMEOUT_MS = 2500;

// timeoutMs bounds the whole check, including the legacy state fallback.
// expectedVersion, when given, also requires that FULI version (a thin hook
// entry hands its calls only to a console running its own code).
export async function checkLocalConsoleHealth(url, expectedPid, stateVersion = 3, timeoutMs = CONSOLE_HEALTH_TIMEOUT_MS,
  expectedVersion = null) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${url}/api/health`, { signal });
    if (response.ok) {
      const body = await response.json();
      return body?.service === 'fuli-local-console' &&
        (!Number.isInteger(expectedPid) || body.pid === expectedPid) &&
        (expectedVersion === null || body.version === expectedVersion);
    }
    if (expectedVersion !== null) return false;
    if (response.status !== 404 || stateVersion !== 2) return false;
  } catch {
    return false;
  }

  try {
    return (await fetch(`${url}/api/state`, { signal })).ok;
  } catch {
    return false;
  }
}
