import { createCodexTokenUsageResolver } from './codex/token-usage.js';

const TOKEN_USAGE_SOURCES = new Set(['executor', 'host', 'dingdong']);
const DEFAULT_RESOLVER = createAgentTokenUsageResolver();

/**
 * Resolve one exact worker/session identity through the runtime adapter port.
 *
 * A worker runtime is authoritative when present. Its session is never
 * replaced with the reporting host session. A reporting host session is used
 * only when no worker runtime was supplied, which covers direct host activity.
 */
export function resolveAgentSession(input = {}) {
  const workerRuntime = input.workerRuntime ?? input.worker_runtime;
  if (workerRuntime !== undefined && workerRuntime !== null) {
    if (!workerRuntime || typeof workerRuntime !== 'object' || Array.isArray(workerRuntime)) {
      return null;
    }
    const application = workerRuntime.application;
    const sessionId = safeSessionId(workerRuntime.sessionId ?? workerRuntime.session_id);
    if (!validApplication(application) || !sessionId) return null;
    return {
      application,
      sessionId,
      sourceApplication: input.sourceApplication ?? input.source_application ?? null,
      sourceSessionId: input.sourceSessionId ?? input.source_session_id ?? null,
      scope: 'worker'
    };
  }

  if (hasWorkerMetadata(input)) return null;
  const application = input.sourceApplication ?? input.source_application;
  const sessionId = safeSessionId(input.sourceSessionId ?? input.source_session_id);
  if (!validApplication(application) || !sessionId) return null;
  return {
    application,
    sessionId,
    sourceApplication: application,
    sourceSessionId: sessionId,
    scope: 'host'
  };
}

/**
 * Shared adapter port for exact session token usage.
 *
 * Adapters receive only the selected session identity and return a cumulative
 * snapshot or null. They must not return transcript content.
 */
export function createAgentTokenUsageResolver({ adapters } = {}) {
  const registry = adapters instanceof Map
    ? adapters
    : new Map(Object.entries(adapters ?? {
      codex: createCodexTokenUsageResolver()
    }));
  return {
    async resolve(input = {}) {
      const session = resolveAgentSession(input);
      if (!session) return null;
      const adapter = registry.get(session.application);
      const resolve = typeof adapter === 'function' ? adapter : adapter?.resolve;
      if (typeof resolve !== 'function') return null;
      try {
        return normalizeTokenUsage(await resolve.call(adapter, session));
      } catch {
        // Usage collection is best-effort. It must not prevent the host from
        // recording otherwise valid worker activity.
        return null;
      }
    }
  };
}

export async function enrichProjectAgentTaskActivity(input = {}, resolver = DEFAULT_RESOLVER) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const actorKind = input.actorKind ?? input.actor_kind;
  if (actorKind === 'human') return input;
  // Null is an explicit report (including an explicit zero inside the object),
  // so only an omitted value is eligible for automatic collection.
  const explicitTokenUsage = (Object.hasOwn(input, 'tokenUsage') && input.tokenUsage !== undefined) ||
    (Object.hasOwn(input, 'token_usage') && input.token_usage !== undefined);
  if (explicitTokenUsage) return input;

  const resolve = typeof resolver === 'function' ? resolver : resolver?.resolve;
  if (typeof resolve !== 'function') return input;
  try {
    const tokenUsage = normalizeTokenUsage(await resolve.call(resolver, input));
    return tokenUsage ? { ...input, tokenUsage } : input;
  } catch {
    return input;
  }
}

export async function resolveProjectAgentTaskActivityTokenUsage(input, resolver = DEFAULT_RESOLVER) {
  const enriched = await enrichProjectAgentTaskActivity(input, resolver);
  if (!enriched || typeof enriched !== 'object') return null;
  return enriched.tokenUsage !== undefined ? enriched.tokenUsage : enriched.token_usage ?? null;
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value.source;
  const totalTokens = nonNegativeInteger(value.totalTokens ?? value.total_tokens);
  if (!TOKEN_USAGE_SOURCES.has(source) || totalTokens === null) return null;
  return {
    source,
    totalTokens,
    inputTokens: optionalNonNegativeInteger(value.inputTokens ?? value.input_tokens),
    outputTokens: optionalNonNegativeInteger(value.outputTokens ?? value.output_tokens),
    cachedInputTokens: optionalNonNegativeInteger(value.cachedInputTokens ?? value.cached_input_tokens),
    cacheWriteInputTokens: optionalNonNegativeInteger(
      value.cacheWriteInputTokens ?? value.cache_write_input_tokens
    ),
    reasoningOutputTokens: optionalNonNegativeInteger(
      value.reasoningOutputTokens ?? value.reasoning_output_tokens
    )
  };
}

function optionalNonNegativeInteger(value) {
  return value === null || value === undefined ? null : nonNegativeInteger(value);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validApplication(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function hasWorkerMetadata(input) {
  return [
    input.workerId ?? input.worker_id,
    input.workerLabel ?? input.worker_label,
    input.workerStatus ?? input.worker_status,
    input.workerOccupationEmoji ?? input.worker_occupation_emoji
  ].some((value) => value !== undefined && value !== null && value !== '');
}

function safeSessionId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || normalized.includes('..') ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) return null;
  return normalized;
}
