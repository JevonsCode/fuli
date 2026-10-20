// rec#8 stop and fallback states. Every model failure has one class:
// - transient: timeout, network, rate limit, server fault; retried within bounds
// - configuration: repairable setup or output problem (model, key, schema)
// - refusal: a refusal, permission or privacy stop; never retried elsewhere
// - budget_exhausted: the role's budget pauses the call
// The port only reports whether the caller may fall back to the current
// session; deciding to fall back is the caller's job.

export const FAILURE_STATUS = Object.freeze({
  transient: 'failed', configuration: 'failed', refusal: 'stopped', budget_exhausted: 'paused'
});

const AUTH_SIGNAL = /authentication|invalid[_ -]?(api[_ -]?)?key|incorrect api key|invalid x-api-key|unauthori[sz]ed/i;
const CONTENT_POLICY_SIGNAL = /content[_ -]?(policy|filter)|safety system|flagged/i;
const MODEL_MISSING_SIGNAL = /model_not_found|model .{0,80}(not found|does not exist)|unknown model/i;
const TOO_LARGE_SIGNAL = /max_tokens_exceeded|context[_ -]length|maximum context|too (long|large)|exceeds .{0,40}(limit|context)/i;
const STRUCTURED_OUTPUT_SIGNAL = /response_format|json_schema|output_config|output_format|structured output/i;

export function modelFailure(failureClass, reason, { retryAfterMs = null } = {}) {
  return { failureClass, reason, retryAfterMs };
}

export function isFallbackEligible(failure, role) {
  return role?.fallbackToSession === true &&
    (failure.failureClass === 'transient' || failure.failureClass === 'configuration');
}

export function transportFailure(error) {
  return modelFailure('transient', error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network');
}

// Classifies an HTTP error by its status and the provider's own error type,
// code and message. A 403 is a permission stop unless the provider says the
// key itself is invalid. `structuredOutput` marks a request that asked for a
// JSON schema, so a rejection of that feature can fall back to prompt mode.
export function httpFailure(status, { type = null, code = null, message = '' } = {}, { retryAfterMs = null, structuredOutput = false } = {}) {
  const signal = [type, code, message].filter(Boolean).join(' ');
  if (status === 401) return modelFailure('configuration', 'auth_failed');
  if (status === 403) {
    return AUTH_SIGNAL.test(signal) ? modelFailure('configuration', 'auth_failed') : modelFailure('refusal', 'permission_denied');
  }
  if (status === 402) return modelFailure('configuration', 'provider_billing');
  if (status === 404) return modelFailure('configuration', 'model_or_endpoint_not_found');
  if (status === 408) return modelFailure('transient', 'timeout');
  if (status === 413) return modelFailure('configuration', 'request_too_large');
  if (status === 429) return modelFailure('transient', 'rate_limited', { retryAfterMs });
  if (status >= 500 || status === 409) return modelFailure('transient', 'server_error', { retryAfterMs });
  if (CONTENT_POLICY_SIGNAL.test(signal)) return modelFailure('refusal', 'content_policy');
  if (MODEL_MISSING_SIGNAL.test(signal)) return modelFailure('configuration', 'model_or_endpoint_not_found');
  if (TOO_LARGE_SIGNAL.test(signal)) return modelFailure('configuration', 'request_too_large');
  if (structuredOutput && status === 400 && STRUCTURED_OUTPUT_SIGNAL.test(signal)) {
    return modelFailure('configuration', 'unsupported_response_format');
  }
  return modelFailure('configuration', 'bad_request');
}
