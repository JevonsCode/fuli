// The only network the Tonborg review evaluation may reach when it measures a
// model behind an Anthropic-compatible gateway (rec#26): POST <endpoint>/messages
// on the one endpoint the run names, nothing else. Like the local Ollama
// transport, every request is checked before it leaves (another origin, path
// or method throws; a request that offers tools throws), the evaluation's
// sampling is added here at the transport boundary, and each exchange is
// handed to `onExchange` exactly as sent and received.

import { fetchWithoutRedirect } from '../../src/model-backends/no-redirect-fetch.js';
import { recordedExchange } from './exchange-record.js';

const MESSAGES_PATH = '/messages';

// What the production anthropic_messages adapter sends, plus the evaluation's
// sampling. The Messages API has no seed, so temperature is the only setting.
const MESSAGE_FIELDS = new Set(['model', 'max_tokens', 'system', 'messages', 'stream', 'output_config']);
const SAMPLING_FIELDS = new Set(['temperature']);
const MESSAGE_ROLES = new Set(['user', 'assistant']);

function messagesUrl(endpoint) {
  return new URL(`${new URL(endpoint).href.replace(/\/+$/, '')}${MESSAGES_PATH}`);
}

function assertGatewayRoute(allowed, url, method = 'GET') {
  const target = new URL(String(url));
  if (target.origin !== allowed.origin) throw new Error(`Refusing network access outside ${allowed.origin}: ${target.origin}`);
  if (target.pathname !== allowed.pathname || method.toUpperCase() !== 'POST') {
    throw new Error(`Refusing ${method.toUpperCase()} ${target.pathname}: not a route this evaluation uses`);
  }
  return target;
}

function assertToolFreeMessages(body) {
  const extra = Object.keys(body).filter(field => !MESSAGE_FIELDS.has(field));
  if (extra.length) throw new Error(`Refusing a messages request with fields the evaluation does not send: ${extra.join(', ')}`);
  if (typeof body.system !== 'string' || !Array.isArray(body.messages) || body.messages.some(message => !MESSAGE_ROLES.has(message.role)
    || typeof message.content !== 'string' || Object.keys(message).some(key => key !== 'role' && key !== 'content'))) {
    throw new Error('Refusing a messages request whose system or messages are not plain text');
  }
}

// The only way the evaluation reaches the network in a gateway run.
export function gatewayOnlyFetch(endpoint, fetchImpl = globalThis.fetch) {
  const allowed = messagesUrl(endpoint);
  return async function checkedFetch(url, init = {}) {
    const target = assertGatewayRoute(allowed, url, init.method ?? 'GET');
    return fetchWithoutRedirect(fetchImpl, target.href, init);
  };
}

// sampling: e.g. { temperature: 0 }.
export function createAnthropicGatewayTransport({ endpoint, sampling, fetchImpl = globalThis.fetch, onExchange = () => {} }) {
  const unknown = Object.keys(sampling).filter(field => !SAMPLING_FIELDS.has(field));
  if (unknown.length) throw new TypeError(`Unsupported sampling fields for the Messages API: ${unknown.join(', ')}`);
  const allowed = messagesUrl(endpoint);
  const send = gatewayOnlyFetch(endpoint, fetchImpl);
  return async function gatewayFetch(url, init = {}) {
    const method = init.method ?? 'GET';
    const target = assertGatewayRoute(allowed, url, method);
    const request = JSON.parse(init.body);
    assertToolFreeMessages(request);
    const body = JSON.stringify({ ...request, ...sampling });
    const response = await send(target.href, { ...init, body });
    return recordedExchange({ target, method, body, response, onExchange });
  };
}
