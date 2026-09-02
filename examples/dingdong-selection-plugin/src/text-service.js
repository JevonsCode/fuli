import { createProviderRouter } from './provider-router.js';

const MAX_RESULT_LENGTH = 20_000;

export class TextServiceError extends Error {
  constructor(message, code, { cause } = {}) {
    super(message, { cause });
    this.name = 'TextServiceError';
    this.code = code;
  }
}

export function createHttpTextService({
  endpoint,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  config,
  providerConfig,
  keychain,
  tokenStore
} = {}) {
  if (config !== undefined || providerConfig !== undefined) {
    return createProviderRouter({
      config: config ?? providerConfig,
      fetchImpl,
      keychain,
      tokenStore,
      timeoutMs
    });
  }
  const url = parseEndpoint(endpoint);
  if (typeof fetchImpl !== 'function') {
    throw new TextServiceError('Fetch is unavailable', 'TEXT_SERVICE_UNAVAILABLE');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TextServiceError('Text service timeout is invalid', 'TEXT_SERVICE_CONFIG_INVALID');
  }

  const request = async (action, payload) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const signal = payload.signal
      ? AbortSignal.any([payload.signal, controller.signal])
      : controller.signal;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          text: payload.text,
          ...(action === 'translate'
            ? { targetLanguage: payload.targetLanguage }
            : { locale: payload.locale })
        }),
        signal,
        credentials: 'omit',
        redirect: 'error'
      });
      if (!response.ok) {
        throw new TextServiceError(
          `Text service returned HTTP ${response.status}`,
          'TEXT_SERVICE_HTTP_ERROR'
        );
      }
      const value = await response.json();
      if (!value || typeof value.text !== 'string' || value.text.trim().length === 0) {
        throw new TextServiceError(
          'Text service returned an invalid response',
          'TEXT_SERVICE_RESPONSE_INVALID'
        );
      }
      if (value.text.length > MAX_RESULT_LENGTH) {
        throw new TextServiceError(
          'Text service result is too large',
          'TEXT_SERVICE_RESPONSE_TOO_LARGE'
        );
      }
      return value.text.trim();
    } catch (error) {
      if (error instanceof TextServiceError) throw error;
      if (error?.name === 'AbortError') {
        throw new TextServiceError('Text service request timed out', 'TEXT_SERVICE_TIMEOUT');
      }
      throw new TextServiceError(
        'Text service request failed',
        'TEXT_SERVICE_REQUEST_FAILED',
        { cause: error }
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  return Object.freeze({
    translate: (payload) => request('translate', payload),
    explain: (payload) => request('explain', payload)
  });
}

export function parseEndpoint(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TextServiceError(
      '请先配置文本服务地址，再使用翻译或解释。',
      'TEXT_SERVICE_NOT_CONFIGURED'
    );
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch (cause) {
    throw new TextServiceError(
      '文本服务地址不是有效 URL。',
      'TEXT_SERVICE_CONFIG_INVALID',
      { cause }
    );
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TextServiceError(
      '文本服务必须使用 HTTPS；本机回环地址可使用 HTTP。',
      'TEXT_SERVICE_ENDPOINT_UNSAFE'
    );
  }
  if (url.username || url.password) {
    throw new TextServiceError(
      '文本服务地址不能包含凭据。',
      'TEXT_SERVICE_ENDPOINT_UNSAFE'
    );
  }
  return url.toString();
}

// Keep the legacy endpoint service available while exposing the formal
// Provider contract from the module used by the original browser example.
export {
  PROVIDER_KINDS,
  ProviderConfigError,
  ProviderConfigurationError,
  ProviderError,
  createProviderConfigStore,
  createModelProvider,
  createModelProviderRouter,
  createProviderRouter,
  createProviderTextService,
  makeProviderRequest,
  normalizeProviderConfig,
  parseProviderResponse,
  providerRequiresToken,
  redactModelProviderConfig,
  redactProviderConfig,
  serializeModelProviderConfig,
  serializeProviderConfig,
  validateModelProviderConfig,
  validateProviderConfig
} from './provider-router.js';
