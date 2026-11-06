import { z } from 'zod';

import { refuseRemoteDecision } from '../http/request-policy.js';
import { readJson, sendJson } from '../http/response.js';
import { endpointUrl, MODEL_BACKEND_PROTOCOLS } from './config.js';
import { listEndpointModels, ModelListError } from './endpoint-models.js';
import { secretReference } from './secret-store.js';

// The model field of the settings dialog lists what the typed endpoint
// offers, before anything is saved (endpoint-models.js). It only reads, but it
// sends the saved key named by secretRef to that endpoint, so like 测试连接 it
// is loopback only; no MCP or Agent tool reaches it. The key is read from the
// store here and never answered, logged or put in a URL.
const MODELS_ROUTE = '/api/model-backends/models';
const LIST_BODY = z.object({
  protocol: z.enum(MODEL_BACKEND_PROTOCOLS),
  endpoint: z.string(),
  secretRef: z.string().nullable().optional()
}).strict();
// Not the endpoint's answer: no saved key, or a protocol that lists nothing.
const LOCAL_CODES = new Set(['missing_key', 'listing_unsupported']);

export async function handleModelListRequest({ request, response, url, secrets, fetchImpl, timeoutMs }) {
  if (url.pathname !== MODELS_ROUTE) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'A model endpoint is listed only on this computer')) return true;
  const parsed = LIST_BODY.safeParse(await readJson(request));
  if (!parsed.success) throw new TypeError('Send { "protocol", "endpoint", "secretRef"? }');
  const { protocol } = parsed.data;
  const endpoint = endpointUrl(parsed.data.endpoint, 'endpoint');
  const reference = parsed.data.secretRef ? secretReference(parsed.data.secretRef, 'secretRef') : null;
  if (reference && !secrets) {
    sendJson(response, 503, { error: 'Model keys need a local FULI installation' });
    return true;
  }
  try {
    const secret = reference ? await secrets.read(reference) : null;
    if (reference && !secret) throw new ModelListError('missing_key');
    sendJson(response, 200, await listEndpointModels({ protocol, endpoint, secret, fetchImpl, timeoutMs }));
  } catch (error) {
    // The store's own refusals name the reference, never the key.
    if (typeof error?.code === 'string' && error.code.startsWith('secret_')) {
      sendJson(response, 409, { error: error.message, code: error.code });
    } else if (error instanceof ModelListError) {
      sendJson(response, LOCAL_CODES.has(error.code) ? 409 : 502, { error: error.message, code: error.code });
    } else throw error;
  }
  return true;
}
