import { readFileSync } from 'node:fs';

import { jsonFormat } from '../storage/json-format.js';
import { createUpdatableManifest } from '../registry/updatable-manifest.js';
import { diffEmbeddingModels, parseEmbeddingModelsManifest } from './manifest.js';

// The catalog FULI ships, and the public copy it updates to, so a new model
// reaches people without a FULI release.
const EMBEDDING_MODELS_REMOTE_URL = 'https://raw.githubusercontent.com/JevonsCode/fuli/main/registry/embedding-models.json';
const BUNDLED_MANIFEST = new URL('../../registry/embedding-models.json', import.meta.url);
export const EMBEDDING_MODELS_STATE_FORMAT = jsonFormat({ store: 'embedding-models', versions: [1] });

const readBundledManifest = () => JSON.parse(readFileSync(BUNDLED_MANIFEST, 'utf8'));

// Updated once a day unless the person turned that off: the catalog only
// lists what may be downloaded; nothing is downloaded until a person asks.
export function createEmbeddingModelRegistry({
  statePath, remoteUrl = EMBEDDING_MODELS_REMOTE_URL, fetchImpl = globalThis.fetch,
  now = () => new Date(), readBundled = readBundledManifest
}) {
  return createUpdatableManifest({ statePath, format: EMBEDDING_MODELS_STATE_FORMAT, remoteUrl, readBundled,
    parse: parseEmbeddingModelsManifest, diff: diffEmbeddingModels, changedCode: 'embedding_models_changed',
    autoUpdateDefault: true, fetchImpl, now });
}
