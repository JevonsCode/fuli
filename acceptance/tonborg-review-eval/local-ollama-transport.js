// The only network the Tonborg review evaluation may reach: the local Ollama
// on 127.0.0.1:11434 (rec#26). Every request is checked before it leaves:
// another origin, path or method throws, and a chat request that offers tools
// throws. The evaluation's fixed sampling is added to the chat body here, at
// the transport boundary, so the production adapter's request is otherwise
// unchanged. Each exchange is handed to `onExchange` exactly as sent and
// received, for the raw per-case record.

export const OLLAMA_ORIGIN = 'http://127.0.0.1:11434';
export const CHAT_PATH = '/v1/chat/completions';

// Ollama's own read-only metadata routes, for the model digest and runtime.
const ALLOWED_ROUTES = Object.freeze({
  [CHAT_PATH]: 'POST', '/api/version': 'GET', '/api/tags': 'GET', '/api/show': 'POST', '/api/ps': 'GET'
});
// What the production openai_chat adapter sends, plus the evaluation's
// sampling. Anything else, tools above all, is not this evaluation's request.
const CHAT_FIELDS = new Set(['model', 'messages', 'max_tokens', 'reasoning_effort', 'stream', 'stream_options', 'response_format']);
const SAMPLING_FIELDS = new Set(['temperature', 'seed']);
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);
// A re-wrapped body is already decoded and its length is the text's own.
const STALE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding'];

function assertLocalOllama(url, method = 'GET') {
  const target = new URL(String(url));
  if (target.origin !== OLLAMA_ORIGIN) throw new Error(`Refusing network access outside ${OLLAMA_ORIGIN}: ${target.origin}`);
  if (ALLOWED_ROUTES[target.pathname] !== method.toUpperCase()) {
    throw new Error(`Refusing ${method.toUpperCase()} ${target.pathname}: not a route this evaluation uses`);
  }
  return target;
}

function assertToolFreeChat(body) {
  const extra = Object.keys(body).filter(field => !CHAT_FIELDS.has(field));
  if (extra.length) throw new Error(`Refusing a chat request with fields the evaluation does not send: ${extra.join(', ')}`);
  if (!Array.isArray(body.messages) || body.messages.some(message => !MESSAGE_ROLES.has(message.role)
    || typeof message.content !== 'string' || Object.keys(message).some(key => key !== 'role' && key !== 'content'))) {
    throw new Error('Refusing a chat request whose messages are not plain system, user or assistant text');
  }
}

// The only way the evaluation reaches the network: an allowed local route,
// and never a redirect. Native fetch follows redirects by default, so a
// checked first URL alone could still end on another host or port.
export function localOnlyFetch(fetchImpl = globalThis.fetch) {
  return async function checkedFetch(url, init = {}) {
    const target = assertLocalOllama(url, init.method ?? 'GET');
    const response = await fetchImpl(target.href, { ...init, redirect: 'error' });
    if (response.redirected) throw new Error(`Refusing a redirected response from ${target.href}`);
    return response;
  };
}

// sampling: the fixed generation settings this evaluation adds, e.g.
// { temperature: 0, seed: 20261022 }.
export function createLocalOllamaTransport({ sampling, fetchImpl = globalThis.fetch, onExchange = () => {} }) {
  const unknown = Object.keys(sampling).filter(field => !SAMPLING_FIELDS.has(field));
  if (unknown.length) throw new TypeError(`Unsupported sampling fields: ${unknown.join(', ')}`);
  const send = localOnlyFetch(fetchImpl);
  return async function localOllamaFetch(url, init = {}) {
    const method = init.method ?? 'GET';
    const target = assertLocalOllama(url, method);
    let body = init.body ?? undefined;
    if (target.pathname === CHAT_PATH) {
      const chat = JSON.parse(body);
      assertToolFreeChat(chat);
      body = JSON.stringify({ ...chat, ...sampling });
    }
    const response = await send(target.href, { ...init, body });
    const responseText = await response.text();
    onExchange({ url: target.href, method: method.toUpperCase(), requestBody: body ?? null,
      status: response.status, contentType: response.headers.get('content-type'), responseText });
    const headers = new Headers(response.headers);
    for (const name of STALE_HEADERS) headers.delete(name);
    return new Response(responseText, { status: response.status, statusText: response.statusText, headers });
  };
}
