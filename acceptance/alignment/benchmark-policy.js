const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_CLAUDE_TIMEOUT_MS = 4 * 60_000;

export function resolveAlignmentTimeouts(env = process.env) {
  const claudeProcessTimeoutMs = positiveTimeout(
    env.FULI_ALIGNMENT_CLAUDE_TIMEOUT_MS,
    DEFAULT_CLAUDE_TIMEOUT_MS,
    'FULI_ALIGNMENT_CLAUDE_TIMEOUT_MS'
  );
  const providerRequestTimeoutMs = positiveTimeout(
    env.FULI_ALIGNMENT_PROVIDER_TIMEOUT_MS,
    claudeProcessTimeoutMs,
    'FULI_ALIGNMENT_PROVIDER_TIMEOUT_MS'
  );
  const hookTimeoutSec = positiveTimeout(
    env.FULI_ALIGNMENT_HOOK_TIMEOUT_SEC,
    Math.ceil(providerRequestTimeoutMs / 1000),
    'FULI_ALIGNMENT_HOOK_TIMEOUT_SEC'
  );
  const hookSmokeTimeoutMs = positiveTimeout(
    env.FULI_ALIGNMENT_HOOK_SMOKE_TIMEOUT_MS,
    claudeProcessTimeoutMs,
    'FULI_ALIGNMENT_HOOK_SMOKE_TIMEOUT_MS'
  );
  return Object.freeze({
    claudeProcessTimeoutMs,
    providerRequestTimeoutMs,
    hookTimeoutSec,
    hookSmokeTimeoutMs
  });
}

export function classifyClaudeCaseStatus({
  passed,
  errors = [],
  diagnostics = [],
  toolResults = []
}) {
  if ([...errors, ...diagnostics, ...toolResults]
    .some(isClaudeInfrastructureError)) return 'ERROR';
  return passed ? 'PASS' : 'FAIL';
}

export function isClaudeInfrastructureError(error) {
  const message = diagnosticText(error);
  return /\bAPI Error:\s*5\d{2}\b/i.test(message)
    || /\bClaude API returned HTTP 5\d{2}\b/i.test(message)
    || /\binference gateway\b/i.test(message)
    || /\b(?:Claude|hook|process)\s+(?:execution\s+)?(?:timed out|timeout)\b/i.test(message)
    || /\b(?:no usable Claude result|Claude result(?: event)? unavailable|no result event)\b/i.test(message)
    || /\b(?:mcp\s+)?tool_result\s+error\b/i.test(message)
    || /\bprovider[_ -](?:http[_ -])?5\d{2}\b/i.test(message)
    || /\bHTTP\s+5\d{2}\b/i.test(message)
    || /\bClaude executable is unavailable\b/i.test(message);
}

export function summarizeClaudeExecutionError(error) {
  const message = diagnosticText(error);
  const status = message.match(/\bAPI Error:\s*(\d{3})\b/i)?.[1];
  if (status && /\binference gateway\b/i.test(message)) {
    return `Claude API returned HTTP ${status} through the configured inference gateway.`;
  }
  if (status) return `Claude API returned HTTP ${status}.`;
  const httpStatus = message.match(/\bHTTP\s+(5\d{2})\b/i)?.[1];
  if (httpStatus) return `Provider returned HTTP ${httpStatus}.`;
  if (/\b(?:timed out|timeout)\b/i.test(message)) return 'Claude execution timed out.';
  if (/\b(?:no usable Claude result|Claude result(?: event)? unavailable|no result event)\b/i.test(message)) {
    return 'Claude produced no usable result.';
  }
  if (/\btool_result\s+error\b/i.test(message)) {
    return 'MCP tool returned an error result.';
  }
  if (/\b(?:ENOENT|command not found)\b/i.test(message)) {
    return 'Claude executable is unavailable.';
  }
  return 'Claude execution failed before a usable result was produced.';
}

export function summarizeMcpToolResultError({ name = 'unknown', summary = '' } = {}) {
  const safeName = String(name).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120);
  const raw = String(summary ?? '');
  const httpStatus = raw.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  const detail = /InputValidationError|input validation/i.test(raw)
    ? 'input validation error'
    : /timed out|timeout/i.test(raw)
      ? 'request timed out'
      : httpStatus
        ? `HTTP ${httpStatus}`
        : /unavailable|connection refused/i.test(raw)
          ? 'provider unavailable'
          : 'tool execution failed';
  return `MCP tool_result error (${safeName}): ${detail}.`;
}

export function composeResourcesRemoved({
  containers,
  networks,
  volumes
}) {
  return [containers, networks, volumes]
    .every((value) => String(value ?? '').trim() === '');
}

function diagnosticText(value) {
  if (value && typeof value === 'object') {
    return [
      value.isError ? 'MCP tool_result error' : '',
      value.category,
      value.detail,
      value.message,
      value.name
    ]
      .filter(Boolean)
      .join(' ');
  }
  return String(value ?? '');
}

function positiveTimeout(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TIMEOUT_MS) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return parsed;
}
