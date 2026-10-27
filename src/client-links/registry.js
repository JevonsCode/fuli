import { readFileSync } from 'node:fs';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { diffClientLinks, parseClientLinksManifest } from './manifest.js';

// The manifest FULI ships, and the public copy it may update to. Only this
// data file is updated, never FULI itself.
const CLIENT_LINKS_REMOTE_URL = 'https://raw.githubusercontent.com/JevonsCode/fuli/main/registry/client-links.json';
const BUNDLED_MANIFEST = new URL('../../registry/client-links.json', import.meta.url);
// The person's applied copy, whether updates apply by themselves, and what changed.
export const CLIENT_LINKS_STATE_FORMAT = jsonFormat({ store: 'client-links', versions: [1] });
const STATE_VERSION = 1;
const MAX_MANIFEST_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const AUTO_UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
// Checked hourly so a computer that slept still updates about once a day.
const AUTO_UPDATE_TICK_MS = 60 * 60 * 1000;
const MAX_HISTORY = 20;

const readBundledManifest = () => JSON.parse(readFileSync(BUNDLED_MANIFEST, 'utf8'));

export function createClientLinksRegistry({
  statePath, remoteUrl = CLIENT_LINKS_REMOTE_URL, fetchImpl = globalThis.fetch,
  now = () => new Date(), readBundled = readBundledManifest
}) {
  const bundled = parseClientLinksManifest(readBundled());
  // What the last check found, applied only by its digest: what was shown is what is applied.
  let pending = null;

  function readState() {
    const stored = readJsonFile(statePath, null);
    return {
      version: STATE_VERSION,
      manifest: stored?.manifest ?? null,
      autoUpdate: stored?.autoUpdate === true,
      lastCheckedAt: stored?.lastCheckedAt ?? null,
      history: Array.isArray(stored?.history) ? stored.history : []
    };
  }

  const writeState = state => writeVersionedJsonFileAtomic(statePath, state, CLIENT_LINKS_STATE_FORMAT);

  // An applied copy older than the bundled one (FULI was upgraded) or no longer
  // valid gives way to the bundled copy.
  function active(state = readState()) {
    let applied = null;
    try { applied = state.manifest ? parseClientLinksManifest(state.manifest) : null; } catch { applied = null; }
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
    if (Buffer.byteLength(body) > MAX_MANIFEST_BYTES) throw new Error('the manifest is too large');
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
    try { remote = parseClientLinksManifest(JSON.parse(body)); } catch (error) {
      // Anything invalid is refused whole; the current copy stays in use.
      return { status: 'invalid', checkedAt, reason: error instanceof SyntaxError ? 'not JSON' : error.message };
    }
    const { manifest } = active(state);
    if (remote.manifestVersion <= manifest.manifestVersion) {
      return { status: 'up_to_date', checkedAt, manifestVersion: manifest.manifestVersion };
    }
    pending = { digest: contentHash(remote), manifest: remote };
    return { status: 'update_available', checkedAt, digest: pending.digest, updatedAt: remote.updatedAt,
      diff: diffClientLinks(manifest, remote) };
  }

  function apply(digest, { automatic = false } = {}) {
    if (!pending || pending.digest !== digest) {
      throw new ApplicationError('client_links_changed', 'The update you saw is no longer the one available; check for updates again.',
        { status: 409 });
    }
    const state = readState();
    const change = { appliedAt: now().toISOString(), automatic, ...diffClientLinks(active(state).manifest, pending.manifest) };
    writeState({ ...state, manifest: pending.manifest, history: [change, ...state.history].slice(0, MAX_HISTORY) });
    pending = null;
    return current();
  }

  function setAutoUpdate(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('autoUpdate must be true or false');
    writeState({ ...readState(), autoUpdate: enabled });
    return current();
  }

  // Once a day when the person turned it on: check, and apply what is valid.
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
