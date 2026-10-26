import { LOOPBACK_HOSTS } from '../config.js';
import { fetchWithoutRedirect } from '../no-redirect-fetch.js';
import { isJsonResponse, readJsonBody } from './exchange.js';

// Which local model build an OpenAI-compatible endpoint lists for the
// configured tag (rec#10 D-32). A local Ollama lists each installed tag with
// the digest of its build at GET /api/tags beside its /v1 API. That list is a
// catalog snapshot, not proof of what served an answer: the observation is
// kept for the settings page only (compare `ollama list`) and never enters a
// receipt, a review record or the role trust gate (rec#10 D-36).
// Observed only for loopback HTTP endpoints ending in /v1, with the exact
// tag (no :latest normalization) listed once with a well-formed digest; any
// other answer, a redirect, an error or an abort observes nothing (null).
// The read carries no key and no content and never follows a redirect; the
// port bounds it (port.js).

const OLLAMA_API_BASE = /\/v1$/;
const DIGEST = /^[0-9a-f]{64}$/;

export function observesLocalBuild(connection) {
  return localTagsUrl(connection.endpoint) !== null;
}

export async function observeLocalBuild({ connection, signal, fetchImpl }) {
  const tagsUrl = localTagsUrl(connection.endpoint);
  if (!tagsUrl) return null;
  try {
    const response = await fetchWithoutRedirect(fetchImpl, tagsUrl, { method: 'GET', headers: { accept: 'application/json' }, signal });
    if (!response.ok || !isJsonResponse(response)) {
      await response.body?.cancel();
      return null;
    }
    const listed = (await readJsonBody(response))?.models;
    const digests = new Set((Array.isArray(listed) ? listed : [])
      .filter(entry => entry?.name === connection.model).map(entry => entry.digest));
    const [digest] = digests;
    return digests.size === 1 && typeof digest === 'string' && DIGEST.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

function localTagsUrl(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || !OLLAMA_API_BASE.test(url.pathname)) return null;
  url.pathname = url.pathname.replace(OLLAMA_API_BASE, '/api/tags');
  return url.href;
}
