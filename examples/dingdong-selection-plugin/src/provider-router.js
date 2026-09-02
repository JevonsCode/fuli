const CONFIG_KEYS = new Set([
  'provider',
  'baseUrl',
  'baseURL',
  'model',
  'keychainTokenRef',
  'keychainTokenReference',
  'keychainRef',
  'tokenRef',
  'targetLanguage',
  'unloadLocalModelAfterResponse'
]);

const SECRET_KEYS = new Set([
  'token',
  'apiKey',
  'api_key',
  'secret',
  'authorization',
  'keychainToken'
]);

const PROVIDER_ALIASES = new Map([
  ['openai', 'openai-compatible'],
  ['openai-compatible', 'openai-compatible'],
  ['openaiCompatible', 'openai-compatible'],
  ['open_ai_compatible', 'openai-compatible'],
  ['openrouter', 'openrouter'],
  ['openRouter', 'openrouter'],
  ['gemini', 'gemini'],
  ['ollama', 'ollama'],
  ['lm-studio', 'lm-studio'],
  ['lmStudio', 'lm-studio'],
  ['lm_studio', 'lm-studio']
]);

const LOCAL_PROVIDERS = new Set(['ollama', 'lm-studio']);
const DEFAULT_TARGET_LANGUAGE = 'zh-CN';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESULT_LENGTH = 20_000;

export class ProviderError extends Error {
  constructor(message, code = 'PROVIDER_ERROR', options = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    if (options.provider) this.provider = options.provider;
    if (options.cause && !options.sensitive) this.cause = options.cause;
  }
}

export class ProviderConfigError extends ProviderError {
  constructor(message, code = 'PROVIDER_CONFIG_INVALID') {
    super(message, code);
    this.name = 'ProviderConfigError';
  }
}

export const PROVIDER_KINDS = Object.freeze([
  'openai-compatible',
  'openrouter',
  'gemini',
  'ollama',
  'lm-studio'
]);

export function validateProviderConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderConfigError(
      'Provider configuration is required.',
      'PROVIDER_NOT_CONFIGURED'
    );
  }

  for (const key of Object.keys(value)) {
    if (SECRET_KEYS.has(key) || (!CONFIG_KEYS.has(key) && /(?:token|secret|api.?key|authorization)/i.test(key))) {
      throw new ProviderConfigError(
        'Provider configuration cannot contain secret material.',
        'PROVIDER_SECRET_FORBIDDEN'
      );
    }
    if (!CONFIG_KEYS.has(key)) {
      throw new ProviderConfigError(
        `Provider configuration has unknown field: ${key}`,
        'PROVIDER_CONFIG_INVALID'
      );
    }
  }

  const provider = normalizeProvider(value.provider);
  const baseUrl = normalizeBaseUrl(value.baseUrl ?? value.baseURL, provider);
  const model = normalizeModel(value.model);

  const keychainTokenRef = normalizeTokenReference(
    value.keychainTokenRef ?? value.keychainTokenReference ?? value.keychainRef ?? value.tokenRef
  );
  const targetLanguage = value.targetLanguage === undefined
    ? undefined
    : normalizeText(value.targetLanguage, 'targetLanguage', 64);
  const unloadLocalModelAfterResponse = value.unloadLocalModelAfterResponse;
  if (
    unloadLocalModelAfterResponse !== undefined &&
    typeof unloadLocalModelAfterResponse !== 'boolean'
  ) {
    throw new ProviderConfigError(
      'Provider unloadLocalModelAfterResponse must be a boolean.',
      'PROVIDER_CONFIG_INVALID'
    );
  }

  const result = {
    provider,
    baseUrl,
    model
  };
  if (keychainTokenRef !== undefined) result.keychainTokenRef = keychainTokenRef;
  if (targetLanguage !== undefined) result.targetLanguage = targetLanguage;
  if (unloadLocalModelAfterResponse !== undefined) {
    result.unloadLocalModelAfterResponse = unloadLocalModelAfterResponse;
  }
  return freezeConfig(result);
}

export function normalizeProviderConfig(value) {
  return validateProviderConfig(value);
}

export function redactProviderConfig(value) {
  const config = validateProviderConfig(value);
  const result = {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model
  };
  if (config.keychainTokenRef !== undefined) {
    result.keychainTokenRef = config.keychainTokenRef;
  }
  if (config.targetLanguage !== undefined) result.targetLanguage = config.targetLanguage;
  if (config.unloadLocalModelAfterResponse !== undefined) {
    result.unloadLocalModelAfterResponse = config.unloadLocalModelAfterResponse;
  }
  return Object.freeze(result);
}

export function serializeProviderConfig(value) {
  return JSON.stringify(redactProviderConfig(value));
}

export function createProviderConfigStore({ read, write } = {}) {
  if (read !== undefined && typeof read !== 'function') {
    throw new ProviderConfigError(
      'Provider config reader must be a function.',
      'PROVIDER_CONFIG_INVALID'
    );
  }
  if (write !== undefined && typeof write !== 'function') {
    throw new ProviderConfigError(
      'Provider config writer must be a function.',
      'PROVIDER_CONFIG_INVALID'
    );
  }

  let currentConfig = null;
  return Object.freeze({
    async load() {
      if (!read) return currentConfig ? redactProviderConfig(currentConfig) : null;
      const value = await read();
      currentConfig = value === undefined || value === null
        ? null
        : validateProviderConfig(value);
      return currentConfig ? redactProviderConfig(currentConfig) : null;
    },
    async save(value) {
      const nextConfig = validateProviderConfig(value);
      const safeConfig = redactProviderConfig(nextConfig);
      if (write) await write(safeConfig);
      currentConfig = nextConfig;
      return safeConfig;
    },
    async clear() {
      currentConfig = null;
      if (write) await write(null);
      return null;
    },
    get() {
      return currentConfig ? redactProviderConfig(currentConfig) : null;
    }
  });
}

export function providerRequiresToken(value) {
  const config = validateProviderConfig(value);
  return requiresTokenForConfig(config);
}

export function createProviderRouter({
  config,
  fetchImpl = globalThis.fetch,
  keychain,
  tokenStore,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  let currentConfig = config === undefined || config === null
    ? null
    : validateProviderConfig(config);

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new ProviderConfigError(
      'Provider timeout is invalid.',
      'PROVIDER_CONFIG_INVALID'
    );
  }

  const tokenResolver = keychain ?? tokenStore;

  const router = {
    getConfig() {
      return currentConfig ? redactProviderConfig(currentConfig) : null;
    },
    setConfig(nextConfig) {
      if (nextConfig === undefined || nextConfig === null) {
        currentConfig = null;
        return null;
      }
      currentConfig = validateProviderConfig(nextConfig);
      return redactProviderConfig(currentConfig);
    },
    translate(payload = {}) {
      return request('translate', payload);
    },
    explain(payload = {}) {
      return request('explain', payload);
    },
    request(action, payload = {}) {
      return request(action, payload);
    }
  };

  async function request(action, payload) {
    const selectedConfig = currentConfig;
    if (!selectedConfig) {
      throw new ProviderError(
        '请先配置模型 Provider。',
        'PROVIDER_NOT_CONFIGURED'
      );
    }
    if (action !== 'translate' && action !== 'explain') {
      throw new ProviderError(
        'Unsupported provider action.',
        'PROVIDER_ACTION_UNSUPPORTED',
        { provider: selectedConfig.provider }
      );
    }
    if (typeof fetchImpl !== 'function') {
      throw new ProviderError(
        'Provider fetch is unavailable.',
        'PROVIDER_UNAVAILABLE',
        { provider: selectedConfig.provider }
      );
    }
    if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
      throw new ProviderError(
        'Select non-empty text before running a command.',
        'SELECTION_REQUIRED'
      );
    }
    const text = payload.text.trim().slice(0, 10_000);
    const token = await resolveToken(selectedConfig);
    const requestData = makeProviderRequest({
      action,
      text,
      targetLanguage: payload.targetLanguage,
      locale: payload.locale,
      config: selectedConfig,
      token
    });
    const controller = new AbortController();
    const signal = combineSignals(payload.signal, controller.signal);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(requestData.url, {
        ...requestData.options,
        signal
      });
      if (!response || response.ok !== true) {
        const status = Number.isInteger(response?.status) ? response.status : 0;
        throw new ProviderError(
          status ? `Provider returned HTTP ${status}.` : 'Provider request failed.',
          status ? 'PROVIDER_HTTP_ERROR' : 'PROVIDER_REQUEST_FAILED',
          { provider: selectedConfig.provider }
        );
      }
      let value;
      try {
        value = await response.json();
      } catch (cause) {
        throw new ProviderError(
          'Provider returned an invalid response.',
          'PROVIDER_RESPONSE_INVALID',
          { provider: selectedConfig.provider, cause }
        );
      }
      return parseProviderResponse(value, selectedConfig.provider);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error?.name === 'AbortError') {
        throw new ProviderError(
          'Provider request timed out.',
          'PROVIDER_TIMEOUT',
          { provider: selectedConfig.provider }
        );
      }
      throw new ProviderError(
        'Provider request failed.',
        'PROVIDER_REQUEST_FAILED',
        { provider: selectedConfig.provider }
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolveToken(selectedConfig) {
    if (!requiresTokenForConfig(selectedConfig)) return undefined;
    if (!selectedConfig.keychainTokenRef) {
      throw new ProviderError(
        '这个云端模型需要你自己的 API token。',
        'PROVIDER_TOKEN_REQUIRED',
        { provider: selectedConfig.provider }
      );
    }
    const resolver = typeof tokenResolver === 'function'
      ? tokenResolver
      : [
        tokenResolver?.getToken,
        tokenResolver?.resolveToken,
        tokenResolver?.load,
        tokenResolver?.get,
        tokenResolver?.resolve,
        tokenResolver?.read
      ].find((candidate) => typeof candidate === 'function');
    if (typeof resolver !== 'function') {
      throw new ProviderError(
        '无法从 Keychain 读取 Provider token。',
        'PROVIDER_TOKEN_UNAVAILABLE',
        { provider: selectedConfig.provider }
      );
    }
    let value;
    try {
      value = await resolver.call(tokenResolver, selectedConfig.keychainTokenRef);
    } catch {
      throw new ProviderError(
        '无法从 Keychain 读取 Provider token。',
        'PROVIDER_TOKEN_UNAVAILABLE',
        { provider: selectedConfig.provider }
      );
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ProviderError(
        '这个云端模型需要你自己的 API token。',
        'PROVIDER_TOKEN_REQUIRED',
        { provider: selectedConfig.provider }
      );
    }
    return value.trim();
  }

  return Object.freeze(router);
}

export const createProviderTextService = createProviderRouter;
export const createModelProvider = createProviderRouter;
export const createModelProviderRouter = createProviderRouter;
export const ProviderConfigurationError = ProviderConfigError;

export function makeProviderRequest({
  action,
  text,
  targetLanguage,
  locale,
  config,
  token
}) {
  const normalizedConfig = validateProviderConfig(config);
  if (action !== 'translate' && action !== 'explain') {
    throw new ProviderError('Unsupported provider action.', 'PROVIDER_ACTION_UNSUPPORTED');
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ProviderError('Select non-empty text before running a command.', 'SELECTION_REQUIRED');
  }
  const requiresToken = requiresTokenForConfig(normalizedConfig);
  if (requiresToken && (typeof token !== 'string' || token.trim().length === 0)) {
    throw new ProviderError(
      '这个云端模型需要你自己的 API token。',
      'PROVIDER_TOKEN_REQUIRED',
      { provider: normalizedConfig.provider }
    );
  }

  const path = normalizedConfig.provider === 'ollama'
    ? 'api/chat'
    : 'chat/completions';
  const url = appendPath(normalizedConfig.baseUrl, path);
  const language = normalizeOptionalLocale(
    targetLanguage ?? locale ?? normalizedConfig.targetLanguage,
    DEFAULT_TARGET_LANGUAGE
  );
  const instruction = action === 'translate'
    ? `Translate the selected text to ${language}. Return only the translation.`
    : `Explain the selected text in ${language}. Be concise and accurate.`;
  const body = {
    model: normalizedConfig.model,
    messages: [
      { role: 'system', content: instruction },
      { role: 'user', content: text.trim().slice(0, 10_000) }
    ],
    stream: false
  };
  if (normalizedConfig.provider === 'ollama') {
    body.think = false;
    body.keep_alive = normalizedConfig.unloadLocalModelAfterResponse === false ? '5m' : 0;
  } else {
    body.temperature = 0.2;
    body.max_tokens = 768;
  }

  const headers = { 'content-type': 'application/json' };
  if (requiresToken) headers.authorization = `Bearer ${token.trim()}`;
  return {
    url,
    options: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error'
    }
  };
}

export function parseProviderResponse(value, provider) {
  const result = provider === 'ollama'
    ? value?.message?.content
    : value?.choices?.[0]?.message?.content;
  if (typeof result !== 'string' || result.trim().length === 0) {
    throw new ProviderError(
      'Provider returned an invalid response.',
      'PROVIDER_RESPONSE_INVALID',
      { provider }
    );
  }
  const normalized = result.trim();
  if (normalized.length > MAX_RESULT_LENGTH) {
    throw new ProviderError(
      'Provider result is too large.',
      'PROVIDER_RESPONSE_TOO_LARGE',
      { provider }
    );
  }
  return normalized;
}

export const validateModelProviderConfig = validateProviderConfig;
export const redactModelProviderConfig = redactProviderConfig;
export const serializeModelProviderConfig = serializeProviderConfig;

function normalizeProvider(value) {
  if (typeof value !== 'string' || !PROVIDER_ALIASES.has(value.trim())) {
    throw new ProviderConfigError(
      'Provider kind is unsupported.',
      'PROVIDER_UNSUPPORTED'
    );
  }
  return PROVIDER_ALIASES.get(value.trim());
}

function normalizeBaseUrl(value, provider) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProviderConfigError(
      'Provider base URL is required.',
      'PROVIDER_CONFIG_INVALID'
    );
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProviderConfigError(
      'Provider base URL is invalid.',
      'PROVIDER_ENDPOINT_INVALID'
    );
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new ProviderConfigError(
      'Provider base URL cannot contain credentials, query, or fragment.',
      'PROVIDER_ENDPOINT_INVALID'
    );
  }
  const loopback = isLoopback(url.hostname);
  if (LOCAL_PROVIDERS.has(provider)) {
    if (url.protocol !== 'http:' || !loopback) {
      throw new ProviderConfigError(
        'Ollama and LM Studio require a local loopback HTTP endpoint.',
        'PROVIDER_LOCAL_ENDPOINT_REQUIRED'
      );
    }
  } else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ProviderConfigError(
      'Remote Provider endpoints must use HTTPS; HTTP is limited to loopback.',
      'PROVIDER_ENDPOINT_UNSAFE'
    );
  }
  return url.toString();
}

function normalizeModel(value) {
  return normalizeText(value, 'model', 256);
}

function normalizeTokenReference(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProviderConfigError(
      'Provider keychain token reference must be a non-empty string.',
      'PROVIDER_CONFIG_INVALID'
    );
  }
  return value.trim().slice(0, 512);
}

function normalizeText(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProviderConfigError(
      `Provider ${field} is required.`,
      'PROVIDER_CONFIG_INVALID'
    );
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ProviderConfigError(
      `Provider ${field} is too long.`,
      'PROVIDER_CONFIG_INVALID'
    );
  }
  return normalized;
}

function normalizeOptionalLocale(value, fallback) {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  const locale = value.trim();
  return /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale) ? locale : fallback;
}

function isLoopback(hostname) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname.toLowerCase());
}

function requiresTokenForConfig(config) {
  if (LOCAL_PROVIDERS.has(config.provider)) return false;
  const url = new URL(config.baseUrl);
  return !(url.protocol === 'http:' && isLoopback(url.hostname));
}

function appendPath(baseUrl, path) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  const extraPath = path.replace(/^\/+/, '');
  url.pathname = `${basePath}/${extraPath}`;
  return url.toString();
}

function combineSignals(primary, timeoutSignal) {
  if (!primary) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([primary, timeoutSignal]);
  if (primary.aborted) return primary;
  return timeoutSignal;
}

function freezeConfig(value) {
  return Object.freeze({ ...value });
}
