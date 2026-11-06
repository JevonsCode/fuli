import { localTagsUrl } from './adapters/ollama-local-build.js';
import { isJsonResponse, readFailure, readJsonBody } from './adapters/exchange.js';
import { httpFailure, transportFailure } from './failures.js';
import { modelFetch } from './model-fetch.js';
import { fetchWithoutRedirect, RedirectRefusedError } from './no-redirect-fetch.js';

// Which models an endpoint lists, for the model field of the settings dialog.
// One GET, no project content, never a redirect, bounded in time. An
// OpenAI-compatible endpoint answers GET {endpoint}/models with data[].id; a
// loopback Ollama that does not also answers GET /api/tags with models[].name.
// Anthropic answers GET {endpoint}/models with data[].id and needs the key.
// The key goes only into the request header: no answer or error carries it.

const LIST_TIMEOUT_MS = 5000;
const MAX_MODELS = 1000;
const MAX_MODEL_ID = 200;
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_COMPATIBLE = new Set(['openai_chat', 'openai_embeddings']);

export class ModelListError extends Error {
  constructor(code) {
    super(`The endpoint's models could not be listed (${code})`);
    this.name = 'ModelListError';
    this.code = code;
  }
}

// { protocol, endpoint } validated by the caller; secret: the key or null.
export async function listEndpointModels({ protocol, endpoint, secret, fetchImpl = modelFetch, timeoutMs = LIST_TIMEOUT_MS }) {
  const signal = AbortSignal.timeout(timeoutMs);
  if (protocol === 'anthropic_messages') {
    if (!secret) throw new ModelListError('missing_key');
    const answer = await readList(fetchImpl, `${endpoint}/models`, { 'x-api-key': secret, 'anthropic-version': ANTHROPIC_VERSION }, signal);
    return { models: modelIds(answer?.data, 'id'), source: 'models' };
  }
  if (!OPENAI_COMPATIBLE.has(protocol)) throw new ModelListError('listing_unsupported');
  const headers = secret ? { authorization: `Bearer ${secret}` } : {};
  const tagsUrl = localTagsUrl(endpoint);
  try {
    const answer = await readList(fetchImpl, `${endpoint}/models`, headers, signal);
    return { models: modelIds(answer?.data, 'id'), source: 'models' };
  } catch (error) {
    // A loopback Ollama also lists its tags; a redirect or timeout stays the
    // answer, and so does the first failure when the tags fail too.
    if (!tagsUrl || !(error instanceof ModelListError) || ['endpoint_redirected', 'timeout'].includes(error.code)) throw error;
    return ollamaTags(fetchImpl, tagsUrl, signal).catch(() => { throw error; });
  }
}

async function ollamaTags(fetchImpl, tagsUrl, signal) {
  const answer = await readList(fetchImpl, tagsUrl, {}, signal);
  return { models: modelIds(answer?.models, 'name'), source: 'ollama_tags' };
}

async function readList(fetchImpl, url, headers, signal) {
  let response;
  try {
    response = await fetchWithoutRedirect(fetchImpl, url, { method: 'GET', headers: { accept: 'application/json', ...headers }, signal });
  } catch (error) {
    if (error instanceof RedirectRefusedError) throw new ModelListError('endpoint_redirected');
    throw new ModelListError(transportFailure(signal.aborted ? signal.reason : error).reason);
  }
  if (!response.ok || !isJsonResponse(response)) {
    await response.body?.cancel();
    throw new ModelListError(response.ok ? 'invalid_response' : httpFailure(response.status).reason);
  }
  try {
    return await readJsonBody(response);
  } catch (error) {
    throw new ModelListError(readFailure(signal.aborted ? signal.reason : error).reason);
  }
}

// Plain, unique, sorted ids; an answer without the expected list is not a model list.
function modelIds(entries, field) {
  if (!Array.isArray(entries)) throw new ModelListError('invalid_response');
  const ids = entries.map(entry => entry?.[field])
    .filter(id => typeof id === 'string' && id.length > 0 && id.length <= MAX_MODEL_ID && !/[\u0000-\u001f\u007f]/.test(id));
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right)).slice(0, MAX_MODELS).map(id => ({ id }));
}
