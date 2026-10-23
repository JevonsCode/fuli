import { modelFailure, transportFailure } from '../failures.js';
import { fetchWithoutRedirect, RedirectRefusedError } from '../no-redirect-fetch.js';

// Mechanics shared by every model adapter: one bounded HTTP exchange, error
// details for classification only (never returned or stored), and
// server-sent events. Protocol meaning stays in each adapter.

const MAX_ERROR_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_REPLY_CHARS = 64 * 1024;

class ResponseFormatError extends Error {}

export async function postJson({ fetchImpl, url, headers, body, signal }) {
  try {
    return { response: await fetchWithoutRedirect(fetchImpl, url, { method: 'POST', signal, body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }) };
  } catch (error) {
    // A redirect leaves the endpoint the egress check approved: a stop like
    // egress_not_approved, never retried and never handed to the session.
    if (error instanceof RedirectRefusedError) return { failure: modelFailure('refusal', 'endpoint_redirected') };
    return { failure: transportFailure(error) };
  }
}

export function attemptFailure(failure, { usage, actualModel = null }) {
  return { ok: false, failure, usage, actualModel };
}

// The failure for an error raised while a response body was being read.
export function readFailure(error) {
  return error instanceof SyntaxError || error instanceof ResponseFormatError
    ? modelFailure('configuration', 'invalid_response') : transportFailure(error);
}

export async function errorDetails(response) {
  const { text } = await readBounded(response, MAX_ERROR_BYTES);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { type: null, code: null, message: text };
  }
  // { error: {...} } (OpenAI, Anthropic), { error: '...' } (Ollama) or
  // { detail: {...} | '...' } (Jev).
  const error = body?.error ?? (body?.detail && typeof body.detail === 'object' ? body.detail : undefined);
  const message = typeof error === 'string' ? error : error?.message ?? body?.message ?? body?.detail;
  const type = error?.type ?? error?.error_type;
  return {
    type: typeof type === 'string' ? type : null,
    code: typeof (error?.code ?? body?.code) === 'string' ? error?.code ?? body.code : null,
    message: typeof message === 'string' ? message : ''
  };
}

export function retryAfterMs(headers) {
  const milliseconds = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds;
  const value = headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

export function isJsonResponse(response) {
  return /application\/json/i.test(response.headers.get('content-type') ?? '');
}

export async function readJsonBody(response) {
  const { text, truncated } = await readBounded(response, MAX_RESPONSE_BYTES);
  if (truncated) throw new ResponseFormatError('The model response is too large');
  return JSON.parse(text);
}

export async function* serverSentEvents(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new ResponseFormatError('The model stream is too large');
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const event = parseEvent(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
      if (event) yield event;
    }
  }
  const last = parseEvent(buffer + decoder.decode());
  if (last) yield last;
}

function parseEvent(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

async function readBounded(response, limit) {
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > limit) return { text, truncated: true };
    text += decoder.decode(chunk, { stream: true });
  }
  return { text: text + decoder.decode(), truncated: false };
}
