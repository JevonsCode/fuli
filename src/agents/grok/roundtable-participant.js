const OUTPUT_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const OFFICIAL_BASE_URL = 'https://api.x.ai/v1';

class GrokParticipantError extends Error {
  constructor(code, status = null) {
    const messages = {
      missing_api_key: 'Configure XAI_API_KEY before starting the Grok API participant.',
      missing_model: 'Select a model or configure XAI_MODEL before starting the Grok API participant.',
      invalid_endpoint: 'The Grok API participant requires the official HTTPS API endpoint.',
      model_unavailable: 'The selected Grok model is unavailable to this API account.',
      waiting_auth: 'Grok API authentication or permission is required.',
      response_invalid: 'Grok API returned an invalid response.',
      response_incomplete: 'Grok API did not return a completed response.',
      output_too_large: 'Grok API output exceeds the roundtable message limit.',
      response_too_large: 'Grok API response exceeds the transport limit.',
      remote_failed: 'The Grok API request failed.',
      cancelled: 'The Grok API request was interrupted; remote cancellation is unconfirmed.',
      timeout: 'The Grok API request timed out; remote cancellation is unconfirmed.',
      participant_busy: 'The Grok API participant already has a running turn.',
      participant_closed: 'The Grok API participant is closed.'
    };
    super(messages[code] ?? messages.remote_failed);
    this.code = code;
    if (status !== null) this.status = status;
  }
}

function redact(value, secret) {
  return secret && typeof value === 'string' ? value.replaceAll(secret, '[REDACTED_SECRET]') : value;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function actualUsage(value) {
  const totalTokens = tokenCount(value?.total_tokens);
  if (totalTokens === null) return null;
  return {
    source: 'executor', totalTokens,
    inputTokens: tokenCount(value.input_tokens),
    outputTokens: tokenCount(value.output_tokens),
    cachedInputTokens: tokenCount(value.input_tokens_details?.cached_tokens),
    cacheWriteInputTokens: null,
    reasoningOutputTokens: tokenCount(value.output_tokens_details?.reasoning_tokens)
  };
}

async function responseJson(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new GrokParticipantError('response_invalid');
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_LIMIT) throw new GrokParticipantError('response_too_large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function resultBody(response, secret) {
  if (!Array.isArray(response.output)) throw new GrokParticipantError('response_invalid');
  const text = response.output.filter((item) => item.type === 'message' && item.role === 'assistant')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text).join('\n');
  const body = redact(text, secret).trim();
  if (!body) throw new GrokParticipantError('response_invalid');
  if (Buffer.byteLength(body, 'utf8') > OUTPUT_LIMIT) throw new GrokParticipantError('output_too_large');
  return body;
}

/** A model API seat, distinct from an existing native Grok Bot conversation. */
export function createGrokParticipant({
  model,
  env = process.env,
  fetchImpl = globalThis.fetch,
  baseUrl = OFFICIAL_BASE_URL,
  timeoutMs = 5 * 60 * 1000
} = {}) {
  const selectedModel = String(model ?? env.XAI_MODEL ?? '').trim();
  const secret = typeof env.XAI_API_KEY === 'string' ? env.XAI_API_KEY.trim() : '';
  const validEndpoint = String(baseUrl).replace(/\/$/, '') === OFFICIAL_BASE_URL;
  let active = null;
  let closed = false;

  function configured() {
    if (closed) throw new GrokParticipantError('participant_closed');
    if (!validEndpoint) throw new GrokParticipantError('invalid_endpoint');
    if (!secret || /[\r\n]/.test(secret)) throw new GrokParticipantError('missing_api_key');
    if (!selectedModel) throw new GrokParticipantError('missing_model');
  }

  async function request(path, { method = 'GET', body, signal }) {
    signal.throwIfAborted();
    const response = await fetchImpl(`${OFFICIAL_BASE_URL}${path}`, {
      method, signal, redirect: 'error',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (response.redirected || (response.url && new URL(response.url).origin !== 'https://api.x.ai')) {
      await response.body?.cancel();
      throw new GrokParticipantError('invalid_endpoint');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GrokParticipantError([401, 403].includes(response.status) ? 'waiting_auth' : 'remote_failed', response.status);
    }
    return responseJson(response, signal);
  }

  function safeFailure(error, signal) {
    if (signal?.aborted) {
      const result = new GrokParticipantError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
      result.cancellationConfirmed = false;
      return result;
    }
    return error instanceof GrokParticipantError ? error : new GrokParticipantError('remote_failed');
  }

  return {
    describe() {
      return { applicationLabel: 'Grok API', automatic: true, workspaceWrite: false, cancel: 'request_only', reportsUsage: true };
    },
    async preflight({ signal } = {}) {
      const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      try {
        configured();
        const response = await request('/models', { signal: boundedSignal });
        if (!Array.isArray(response.data)) throw new GrokParticipantError('response_invalid');
        if (!response.data.some((item) => item.id === selectedModel)) throw new GrokParticipantError('model_unavailable');
        return { ready: true, applicationLabel: 'Grok API', model: redact(selectedModel, secret), evidence: 'authenticated_model_catalog' };
      } catch (error) {
        const failure = safeFailure(error, boundedSignal);
        return { ready: false, code: failure.code, reason: failure.message };
      }
    },
    async dispatch({ prompt, signal } = {}) {
      configured();
      if (active) throw new GrokParticipantError('participant_busy');
      if (typeof prompt !== 'string' || !prompt.trim()) throw new GrokParticipantError('response_invalid');
      const controller = new AbortController();
      const boundedSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      active = controller;
      let actual = null;
      try {
        const response = await request('/responses', {
          method: 'POST', signal: boundedSignal,
          body: { model: selectedModel, input: [{ role: 'user', content: prompt }], store: false, parallel_tool_calls: false }
        });
        if (typeof response.id !== 'string' || !response.id || response.id.length > 256 ||
            typeof response.model !== 'string' || !response.model || response.model.length > 256) {
          throw new GrokParticipantError('response_invalid');
        }
        actual = {
          sourceApplication: 'other', applicationLabel: 'Grok API', provider: 'xai',
          model: redact(response.model, secret), sessionId: redact(response.id, secret),
          usage: actualUsage(response.usage), evidence: 'api_response'
        };
        if (response.status !== 'completed') throw new GrokParticipantError('response_incomplete');
        return { body: resultBody(response, secret), actual };
      } catch (error) {
        const failure = safeFailure(error, boundedSignal);
        if (actual) failure.actual = actual;
        throw failure;
      } finally {
        active = null;
      }
    },
    async close() {
      closed = true;
      active?.abort();
    }
  };
}
