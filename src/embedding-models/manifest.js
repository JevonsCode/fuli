// The embedding model catalog (registry/embedding-models.json): small models
// a person may download to search by meaning on this computer, with where
// each file comes from and the digest it must have. It is data and may be
// updated from main without a FULI release, so a copy is accepted only whole
// and only when every field is exactly as written here: a fetched copy can
// name only data files the graph service reads (never a program), only on the
// hosts below, only under licences FULI may point people to.

const FORMAT_ID = 'fuli-embedding-models';
const FORMAT_VERSION = 1;
// Ends in a letter or digit: Windows drops a trailing dot from a folder name.
export const EMBEDDING_MODEL_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
// The three files the graph service runs (graph-provider/fuli_graph/builtin_embedding.py).
export const EMBEDDING_MODEL_FILES = Object.freeze(['config.json', 'vocab.txt', 'model.safetensors']);
const DOWNLOAD_HOSTS = new Set(['huggingface.co', 'hf-mirror.com']);
const LICENSES = new Set(['MIT', 'Apache-2.0']);
const LANGUAGES = new Set(['zh', 'en', 'multi']);
const POOLING = new Set(['cls', 'mean']);
const MAX_MODELS = 32;
const MAX_URLS = 4;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;

class EmbeddingModelsManifestError extends TypeError {
  constructor(message) {
    super(`Embedding model catalog: ${message}`);
    this.code = 'embedding_models_invalid';
  }
}

const fail = message => { throw new EmbeddingModelsManifestError(message); };

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) fail(`${label} has unknown fields: ${extra.join(', ')}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} needs ${key}`);
}

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} must be text of at most ${max} characters`);
  }
  return value;
}

function whole(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be a whole number from ${min} to ${max}`);
  return value;
}

function flag(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be true or false`);
  return value;
}

function downloadUrl(value, label) {
  text(value, label, 512);
  let url;
  try { url = new URL(value); } catch { fail(`${label} must be an https URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !DOWNLOAD_HOSTS.has(url.hostname)) {
    fail(`${label} must be an https URL on ${[...DOWNLOAD_HOSTS].join(' or ')}`);
  }
  return value;
}

// The address after the URL parser has resolved it: `..` segments, encoded
// slashes or another repository cannot stand in for the pinned file.
function pinnedFileUrl(value, label, { repository, revision, path }) {
  downloadUrl(value, label);
  const url = new URL(value);
  if (url.href !== value || url.pathname !== `${repository}/resolve/${revision}/${path}`) {
    fail(`${label} must be exactly <model repository>/resolve/<revision>/${path}`);
  }
  return value;
}

function parseFile(file, label, { repository, revision }) {
  exactKeys(file, ['path', 'bytes', 'sha256', 'urls'], label);
  if (!EMBEDDING_MODEL_FILES.includes(file.path)) fail(`${label}.path must be one of ${EMBEDDING_MODEL_FILES.join(', ')}`);
  if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) fail(`${label}.sha256 must be a lowercase SHA-256`);
  if (!Array.isArray(file.urls) || !file.urls.length || file.urls.length > MAX_URLS) fail(`${label}.urls must list 1 to ${MAX_URLS} URLs`);
  // A link names the exact commit of the model's own repository, so the file behind it cannot change.
  const urls = file.urls.map((url, index) => pinnedFileUrl(url, `${label}.urls[${index}]`, { repository, revision, path: file.path }));
  return { path: file.path, bytes: whole(file.bytes, `${label}.bytes`, 1, MAX_FILE_BYTES), sha256: file.sha256, urls };
}

function parseModel(model, label) {
  exactKeys(model, ['id', 'name', 'license', 'languages', 'dimensions', 'maxTokens', 'pooling', 'lowercase', 'stripAccents',
    'recommended', 'memoryMb', 'summary', 'source', 'revision', 'files'], label);
  if (typeof model.id !== 'string' || !EMBEDDING_MODEL_ID.test(model.id)) fail(`${label}.id must be lowercase letters, digits, dots or dashes`);
  if (!LICENSES.has(model.license)) fail(`${label}.license must be one of ${[...LICENSES].join(', ')}`);
  if (!Array.isArray(model.languages) || !model.languages.length || model.languages.some(language => !LANGUAGES.has(language))
    || new Set(model.languages).size !== model.languages.length) {
    fail(`${label}.languages must list some of ${[...LANGUAGES].join(', ')}`);
  }
  if (!POOLING.has(model.pooling)) fail(`${label}.pooling must be cls or mean`);
  exactKeys(model.summary, ['zh', 'en'], `${label}.summary`);
  if (typeof model.revision !== 'string' || !REVISION.test(model.revision)) fail(`${label}.revision must be a full commit id`);
  if (!Array.isArray(model.files) || model.files.length !== EMBEDDING_MODEL_FILES.length) {
    fail(`${label}.files must be exactly ${EMBEDDING_MODEL_FILES.join(', ')}`);
  }
  const source = downloadUrl(model.source, `${label}.source`);
  // /owner/name, as every file address must start.
  const repository = new URL(source).pathname.replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)) fail(`${label}.source must be a model repository`);
  const files = model.files.map((file, index) => parseFile(file, `${label}.files[${index}]`, { repository, revision: model.revision }));
  if (new Set(files.map(file => file.path)).size !== files.length) fail(`${label}.files repeats a file`);
  return {
    id: model.id, name: text(model.name, `${label}.name`, 80), license: model.license, languages: [...model.languages],
    dimensions: whole(model.dimensions, `${label}.dimensions`, 16, 4096), maxTokens: whole(model.maxTokens, `${label}.maxTokens`, 8, 8192),
    pooling: model.pooling, lowercase: flag(model.lowercase, `${label}.lowercase`),
    stripAccents: flag(model.stripAccents, `${label}.stripAccents`), recommended: flag(model.recommended, `${label}.recommended`),
    memoryMb: whole(model.memoryMb, `${label}.memoryMb`, 1, 65536),
    summary: { zh: text(model.summary.zh, `${label}.summary.zh`, 100), en: text(model.summary.en, `${label}.summary.en`, 160) },
    source, revision: model.revision, files
  };
}

export function parseEmbeddingModelsManifest(raw) {
  exactKeys(raw, ['format', 'formatVersion', 'manifestVersion', 'updatedAt', 'models'], 'manifest');
  if (raw.format !== FORMAT_ID || raw.formatVersion !== FORMAT_VERSION) fail(`format must be ${FORMAT_ID} version ${FORMAT_VERSION}`);
  whole(raw.manifestVersion, 'manifestVersion', 1, Number.MAX_SAFE_INTEGER);
  if (typeof raw.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.updatedAt)) fail('updatedAt must be a date (YYYY-MM-DD)');
  if (!Array.isArray(raw.models) || !raw.models.length || raw.models.length > MAX_MODELS) fail(`models must list 1 to ${MAX_MODELS} models`);
  const models = raw.models.map((model, index) => parseModel(model, `models[${index}]`));
  if (new Set(models.map(model => model.id)).size !== models.length) fail('models repeats an id');
  if (models.filter(model => model.recommended).length !== 1) fail('exactly one model must be recommended');
  return { format: FORMAT_ID, formatVersion: FORMAT_VERSION, manifestVersion: raw.manifestVersion, updatedAt: raw.updatedAt, models };
}

// What an update changes, for the person who applies it.
export function diffEmbeddingModels(current, next) {
  const before = new Map(current.models.map(model => [model.id, model]));
  const after = new Map(next.models.map(model => [model.id, model]));
  return {
    fromVersion: current.manifestVersion, toVersion: next.manifestVersion,
    added: [...after.keys()].filter(id => !before.has(id)),
    removed: [...before.keys()].filter(id => !after.has(id)),
    changed: [...after.keys()].filter(id => before.has(id) && JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)))
  };
}

// How much a model downloads, in bytes.
export const embeddingModelBytes = model => model.files.reduce((sum, file) => sum + file.bytes, 0);
