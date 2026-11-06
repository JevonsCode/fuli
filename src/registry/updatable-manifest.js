import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { readJsonFile } from '../storage/json-file.js';
import { writeVersionedJsonFileAtomic } from '../storage/json-format.js';

// A data manifest FULI ships in registry/ and may update from the public copy
// on main without a FULI release (client links, occupation plugins). A copy is
// accepted only whole, only when its parser accepts every field, and only by
// the digest of what the last check showed. Only this data file is updated,
// never FULI itself; a FULI upgrade with a newer bundled copy wins again.
const STATE_VERSION = 1;
const DEFAULT_MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const AUTO_UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
// Checked hourly so a computer that slept still updates about once a day.
const AUTO_UPDATE_TICK_MS = 60 * 60 * 1000;
const MAX_HISTORY = 20;

// parse: the manifest's whole-copy validator (throws on anything it does not
// accept); diff(current, next): what an update changes, with fromVersion and
// toVersion. changedCode: the error code when the checked update is gone.
// autoUpdateDefault: whether daily updates run before the person chose.
export function createUpdatableManifest({
  statePath, format, remoteUrl, readBundled, parse, diff, changedCode,
  autoUpdateDefault = false, maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl = globalThis.fetch, now = () => new Date()
}) {
  const bundled = parse(readBundled());
  // What the last check found, applied only by its digest: what was shown is what is applied.
  let pending = null;

  function readState() {
    const stored = readJsonFile(statePath, null);
    return {
      version: STATE_VERSION,
      manifest: stored?.manifest ?? null,
      autoUpdate: typeof stored?.autoUpdate === 'boolean' ? stored.autoUpdate : autoUpdateDefault,
      lastCheckedAt: stored?.lastCheckedAt ?? null,
      history: Array.isArray(stored?.history) ? stored.history : []
    };
  }

  const writeState = state => writeVersionedJsonFileAtomic(statePath, state, format);

  // An applied copy older than the bundled one (FULI was upgraded) or no longer
  // valid gives way to the bundled copy.
  function active(state = readState()) {
    let applied = null;
    try { applied = state.manifest ? parse(state.manifest) : null; } catch { applied = null; }
    return applied && applied.manifestVersion > bundled.manifestVersion
      ? { manifest: applied, source: 'updated' } : { manifest: bundled, source: 'bundled' };
  }

  function current() {
    const state = readState();
    return { ...active(state), remoteUrl, autoUpdate: state.autoUpdate, lastCheckedAt: state.lastCheckedAt,
      history: state.history };
  }

  async function fetchRemote() {
    const response = await fetchImpl(remoteUrl, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body) > maxBytes) throw new Error('the manifest is too large');
    return body;
  }

  async function check() {
    const state = readState();
    const checkedAt = now().toISOString();
    writeState({ ...state, lastCheckedAt: checkedAt });
    pending = null;
    let body;
    try { body = await fetchRemote(); } catch (error) {
      return { status: 'unavailable', checkedAt, reason: error?.message ?? String(error) };
    }
    let remote;
    try { remote = parse(JSON.parse(body)); } catch (error) {
      // Anything invalid is refused whole; the current copy stays in use.
      return { status: 'invalid', checkedAt, reason: error instanceof SyntaxError ? 'not JSON' : error.message };
    }
    const { manifest } = active(state);
    if (remote.manifestVersion <= manifest.manifestVersion) {
      return { status: 'up_to_date', checkedAt, manifestVersion: manifest.manifestVersion };
    }
    pending = { digest: contentHash(remote), manifest: remote };
    return { status: 'update_available', checkedAt, digest: pending.digest, updatedAt: remote.updatedAt,
      diff: diff(manifest, remote) };
  }

  function apply(digest, { automatic = false } = {}) {
    if (!pending || pending.digest !== digest) {
      throw new ApplicationError(changedCode, 'The update you saw is no longer the one available; check for updates again.',
        { status: 409 });
    }
    const state = readState();
    const change = { appliedAt: now().toISOString(), automatic, ...diff(active(state).manifest, pending.manifest) };
    writeState({ ...state, manifest: pending.manifest, history: [change, ...state.history].slice(0, MAX_HISTORY) });
    pending = null;
    return current();
  }

  function setAutoUpdate(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('autoUpdate must be true or false');
    writeState({ ...readState(), autoUpdate: enabled });
    return current();
  }

  // Once a day while auto-update is on: check, and apply what is valid.
  async function autoUpdate() {
    const state = readState();
    if (!state.autoUpdate || (state.lastCheckedAt && now() - new Date(state.lastCheckedAt) < AUTO_UPDATE_EVERY_MS)) return null;
    const result = await check();
    return result.status === 'update_available' ? apply(result.digest, { automatic: true }) : null;
  }

  function startAutoUpdate({ onError = () => {} } = {}) {
    const run = () => autoUpdate().catch(onError);
    run();
    const timer = setInterval(run, AUTO_UPDATE_TICK_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { current, check, apply, setAutoUpdate, autoUpdate, startAutoUpdate };
}
