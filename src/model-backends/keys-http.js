import { z } from 'zod';

import { refuseRemoteDecision } from '../http/request-policy.js';
import { readJson, sendJson } from '../http/response.js';
import { secretReference } from './secret-store.js';

// The model settings page's key entry: the same local store `fuli models
// set-key` writes (secret-store.js). A key travels once, in a loopback
// request body, and is never sent back, logged or put in a URL; the page
// learns only which references have a key. Loopback only, like every model
// settings change; FULI trusts local callers and has no console login
// (rec#11 D-70). No MCP or Agent tool reaches it.
const KEYS_ROUTE = '/api/model-backends/keys';
const KEY_ROUTE = /^\/api\/model-backends\/keys\/([^/]+)$/;
const KEY_BODY = z.object({ key: z.string() }).strict();

export async function handleModelKeyRequest({ request, response, url, secrets }) {
  const reference = KEY_ROUTE.exec(url.pathname)?.[1] ?? null;
  if (url.pathname !== KEYS_ROUTE && reference === null) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== (reference === null ? 'GET' : 'PUT')) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'Model keys are saved only on this computer')) return true;
  if (!secrets) {
    sendJson(response, 503, { error: 'Model keys need a local FULI installation' });
    return true;
  }
  try {
    if (reference === null) {
      sendJson(response, 200, { saved: secrets.references() });
      return true;
    }
    secretReference(reference, 'Key reference');
    const parsed = KEY_BODY.safeParse(await readJson(request));
    if (!parsed.success) throw new TypeError('Send the key as { "key": "…" }');
    await secrets.set(reference, parsed.data.key);
    sendJson(response, 200, { reference, saved: true });
  } catch (error) {
    // The store's own refusals name the reference, never the key.
    if (typeof error?.code !== 'string' || !error.code.startsWith('secret_')) throw error;
    sendJson(response, 409, { error: error.message, code: error.code });
  }
  return true;
}
