import { FULI_PACKAGE_NAME, FULI_VERSION } from '../package-metadata.js';
import { compareSemanticVersions, parseSemanticVersion } from '../semantic-version.js';

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_SUCCESS_CACHE_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_FAILURE_CACHE_MS = 5 * 60 * 1_000;

// The update channels a person can follow: stable takes npm's `latest` only;
// beta takes whichever of `latest` and `beta` is newer, so a stable release
// after a beta is still offered.
export const UPDATE_CHANNELS = Object.freeze(['stable', 'beta']);

export function channelVersion(distTags, channel) {
  const candidates = [distTags?.latest, ...(channel === 'beta' ? [distTags?.beta] : [])]
    .map((tag) => String(tag ?? '').trim()).filter(Boolean);
  if (!candidates.length) throw new TypeError('npm returned no release for this channel');
  candidates.forEach(parseSemanticVersion);
  return candidates.reduce((best, version) => (compareSemanticVersions(version, best) > 0 ? version : best));
}

export function createPackageVersionChecker({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  packageName = FULI_PACKAGE_NAME,
  currentVersion = FULI_VERSION,
  // The person's update channel (runtime settings); read on every check.
  channel = () => 'stable',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  successCacheMs = DEFAULT_SUCCESS_CACHE_MS,
  failureCacheMs = DEFAULT_FAILURE_CACHE_MS
} = {}) {
  const registryUrl = `https://registry.npmjs.org/-/package/${encodeURIComponent(packageName)}/dist-tags`;
  const packageUrl = `https://www.npmjs.com/package/${encodeURIComponent(packageName)}`;
  let cached = null;
  let cachedChannel = null;
  let expiresAt = 0;
  let inFlight = null;

  async function resolveStatus(followed) {
    const checkedAt = new Date(now()).toISOString();
    try {
      parseSemanticVersion(currentVersion);
      const response = await fetchImpl(registryUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
      const latestVersion = channelVersion(await response.json(), followed);
      return {
        status: 'ready',
        channel: followed,
        currentVersion,
        latestVersion,
        updateAvailable: compareSemanticVersions(latestVersion, currentVersion) > 0,
        packageUrl,
        checkedAt
      };
    } catch {
      return {
        status: 'unavailable',
        channel: followed,
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
    const followed = channel();
    if (cached && cachedChannel === followed && timestamp < expiresAt) return cached;
    if (inFlight && inFlight.channel === followed) return inFlight;
    const pending = resolveStatus(followed)
      .then((result) => {
        cached = result;
        cachedChannel = followed;
        expiresAt = now() + (result.status === 'ready' ? successCacheMs : failureCacheMs);
        return result;
      })
      .finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    pending.channel = followed;
    inFlight = pending;
    return pending;
  }

  // The last answer without waiting on the network (null before the first
  // one); an expired answer starts a check in the background.
  function peek() {
    if (!cached || cachedChannel !== channel() || now() >= expiresAt) void check();
    return cachedChannel === channel() ? cached : null;
  }

  return { check, peek };
}
