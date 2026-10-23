import { LOOPBACK_HOSTS } from '../config.js';
import { fetchWithoutRedirect } from '../no-redirect-fetch.js';
import { isJsonResponse, readJsonBody } from './exchange.js';

// The digest of the model build that served one OpenAI-compatible answer,
// when the endpoint itself proves it (rec#8, prerequisite of rec#10 D-24).
// A local Ollama lists each installed model tag with the digest of its build
// at GET /api/tags beside its /v1 API. The list is read before and after the
// call: the digest is reported only when the exact configured tag is listed
// with the same well-formed digest both times and the answer names that same
// tag. Anything else is unknown (null): another server, an HTTPS endpoint, a
// tag listed without a digest or with two, a change in between, a redirect, an
// error or a timeout. A digest is never derived from the model name.
// Each read carries no key and no content, never follows a redirect, and is
// bounded by the attempt's own deadline and a short limit of its own.

const OLLAMA_API_BASE = /\/v1$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TAGS_TIMEOUT_MS = 2000;

// exchange(): the attempt's model exchange; its result gains modelDigest.
export async function withServedDigest({ connection, signal, fetchImpl }, exchange) {
  const tagsUrl = localTagsUrl(connection.endpoint);
  const before = tagsUrl ? await listedDigest(tagsUrl, connection.model, signal, fetchImpl) : null;
  const result = await exchange();
  if (!before || !result.ok || result.actualModel !== connection.model) return { ...result, modelDigest: null };
  const after = await listedDigest(tagsUrl, connection.model, signal, fetchImpl);
  return { ...result, modelDigest: after === before ? before : null };
}

function localTagsUrl(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || !OLLAMA_API_BASE.test(url.pathname)) return null;
  url.pathname = url.pathname.replace(OLLAMA_API_BASE, '/api/tags');
  return url.href;
}

async function listedDigest(tagsUrl, model, signal, fetchImpl) {
  let response;
  try {
    response = await fetchWithoutRedirect(fetchImpl, tagsUrl, { method: 'GET', headers: { accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(TAGS_TIMEOUT_MS)]) });
    if (!response.ok || !isJsonResponse(response)) {
      await response.body?.cancel();
      return null;
    }
    const listed = (await readJsonBody(response))?.models;
    const digests = new Set((Array.isArray(listed) ? listed : []).filter(entry => entry?.name === model).map(entry => entry.digest));
    const [digest] = digests;
    return digests.size === 1 && typeof digest === 'string' && DIGEST.test(digest) ? digest : null;
  } catch {
    return null;
  }
}
