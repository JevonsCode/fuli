import { readFileSync } from 'node:fs';

import { jsonFormat } from '../storage/json-format.js';
import { createUpdatableManifest } from '../registry/updatable-manifest.js';
import { diffClientLinks, parseClientLinksManifest } from './manifest.js';

// The manifest FULI ships, and the public copy it may update to.
const CLIENT_LINKS_REMOTE_URL = 'https://raw.githubusercontent.com/JevonsCode/fuli/main/registry/client-links.json';
const BUNDLED_MANIFEST = new URL('../../registry/client-links.json', import.meta.url);
// The person's applied copy, whether updates apply by themselves, and what changed.
export const CLIENT_LINKS_STATE_FORMAT = jsonFormat({ store: 'client-links', versions: [1] });

const readBundledManifest = () => JSON.parse(readFileSync(BUNDLED_MANIFEST, 'utf8'));

// Daily updates run only when the person turned them on.
export function createClientLinksRegistry({
  statePath, remoteUrl = CLIENT_LINKS_REMOTE_URL, fetchImpl = globalThis.fetch,
  now = () => new Date(), readBundled = readBundledManifest
}) {
  return createUpdatableManifest({ statePath, format: CLIENT_LINKS_STATE_FORMAT, remoteUrl, readBundled,
    parse: parseClientLinksManifest, diff: diffClientLinks, changedCode: 'client_links_changed', fetchImpl, now });
}
