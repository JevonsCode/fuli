import { FULI_PACKAGE_NAME, FULI_VERSION } from '../package-metadata.js';
import { compareSemanticVersions, parseSemanticVersion } from '../semantic-version.js';

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_SUCCESS_CACHE_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_FAILURE_CACHE_MS = 5 * 60 * 1_000;

export function createPackageVersionChecker({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  packageName = FULI_PACKAGE_NAME,
  currentVersion = FULI_VERSION,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  successCacheMs = DEFAULT_SUCCESS_CACHE_MS,
  failureCacheMs = DEFAULT_FAILURE_CACHE_MS
} = {}) {
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
  const packageUrl = `https://www.npmjs.com/package/${encodeURIComponent(packageName)}`;
  let cached = null;
  let expiresAt = 0;
  let inFlight = null;

  async function resolveStatus() {
    const checkedAt = new Date(now()).toISOString();
    try {
      parseSemanticVersion(currentVersion);
      const response = await fetchImpl(registryUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
      const body = await response.json();
      const latestVersion = String(body?.version ?? '').trim();
      parseSemanticVersion(latestVersion);
      return {
        status: 'ready',
        currentVersion,
        latestVersion,
        updateAvailable: compareSemanticVersions(latestVersion, currentVersion) > 0,
        packageUrl,
        checkedAt
      };
    } catch {
      return {
        status: 'unavailable',
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        packageUrl,
        checkedAt
      };
    }
  }

  async function check() {
    const timestamp = now();
    if (cached && timestamp < expiresAt) return cached;
    if (inFlight) return inFlight;
    inFlight = resolveStatus()
      .then((result) => {
        cached = result;
        expiresAt = now() + (result.status === 'ready' ? successCacheMs : failureCacheMs);
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { check };
}
