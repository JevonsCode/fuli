import { ApplicationError, isControlledError } from '../app/application-error.js';
import { blockedPreferenceDelivery, blockedPreferenceLabel, blockedPreferenceRecovery, completeBlockedPreferenceDelivery,
  preferenceDeliveryReason, entryFieldOrder, TASK_PREFERENCE_RESULT_LIMIT_BYTES } from './preference-delivery.js';

const OMITTED_KEYS = new Set([
  'store',
  'dbpath',
  'databasepath',
  'privatepath',
  'snapshot',
  'fullsnapshot'
]);
const RESULT_LIMIT_BYTES = 1200;
const RESULT_STRING_LIMIT_BYTES = 512;
const RESULT_ITEM_LIMIT = 20;
const RESULT_PROPERTY_LIMIT = 64;
const RESULT_DEPTH_LIMIT = 8;
const MESSAGE_LIMIT = 240;
const TRUNCATION_MARKER = '...[truncated]';
const VALIDATION_ERROR_LIMIT = 5;

function jsonEnvelope(value) {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
}

// Used only for explicit, bounded business projections that must remain whole.
export function completeToolResult(value, limitBytes) {
  const result = jsonEnvelope(value);
  if (jsonBytes(result) > limitBytes) throw new ApplicationError('result_too_large', 'Request a smaller page to receive the complete result');
  return result;
}

// The reader already supplies an explicit business projection. Never pass it
// through the generic string/array sanitizer and then call it complete.
export function completePreferenceToolResult(value, limitBytes = TASK_PREFERENCE_RESULT_LIMIT_BYTES) {
  if (!value || (value.preferences_complete !== true && !['blocked', 'paginated', 'keys'].includes(value.preference_delivery?.status))) {
    throw new ApplicationError('validation', 'Incomplete preference reader projection');
  }
  const allowed = new Set(['effective_preferences', 'scope_unknown', 'active_conflicts', 'deferred_conflicts',
    'application_guidance', 'task_guidance', 'judgment_context', 'agent_receipt', 'context',
    'project_agent_context', 'taskContextToken', 'task_context_token', 'checkpoint_required', 'checkpoint_reason', 'checkpoint_guidance', 'project_scope', 'worker_run',
    'preference_delivery', 'revision', 'preferences_complete', 'same_task_recovery_available', 'truncated']);
  // One JSON form for both channels: undefined fields never differ between them.
  const envelope = jsonEnvelope;
  const unsafe = (item, depth = 0) => depth > 64 || (item && typeof item === 'object' &&
    Object.entries(item).some(([key, nested]) => OMITTED_KEYS.has(key.replace(/[_-]/g, '').toLowerCase()) || unsafe(nested, depth + 1)));
  let candidate = value;
  if (value?.context?.source_truncated === true) candidate = blockedPreferenceRecovery(value, 'source_window');
  else if (Object.keys(value ?? {}).some(key => !allowed.has(key)) || unsafe(value)) {
    candidate = blockedPreferenceRecovery(value, 'unsafe_projection');
  }
  let result = envelope(entryFieldOrder(candidate));
  // A read by key that does not fit is fixed by asking for fewer keys, not a
  // blocked recovery that told the model to give up on the task's preferences
  // (review of #1070).
  if (jsonBytes(result) > limitBytes && candidate === value && value.preference_delivery?.status === 'keys') {
    throw new ApplicationError('validation', `These ${value.preference_delivery.requested} preferences together do not fit `
      + `one result (${Math.floor(limitBytes / 1024)} KB): read them with fewer keys at a time.`);
  }
  if (jsonBytes(result) > limitBytes) {
    result = envelope(blockedPreferenceRecovery(value, 'delivery_budget'));
    if (jsonBytes(result) > limitBytes) throw new ApplicationError('validation', 'Cannot deliver the complete blocked preference recovery');
  }
  if (unsafe(result.structuredContent)) throw new ApplicationError('validation', 'Preference recovery cannot expose private fields');
  return result;
}

export function successToolResult(value, { limitBytes = RESULT_LIMIT_BYTES, itemLimit = RESULT_ITEM_LIMIT,
  preferenceContext = false, preserveHumanInteraction = false } = {}) {
  const blockedResult = reason => {
    const envelope = blockedPreferenceDelivery(value, reason);
    const sanitized = sanitize(envelope, { truncated: false, itemLimit: 1000 });
    const budget = Number.isInteger(limitBytes) && limitBytes > 0 ? limitBytes : RESULT_LIMIT_BYTES;
    if (!completeBlockedPreferenceDelivery(envelope, sanitized) || jsonBytes(sanitized) > budget) {
      throw new ApplicationError('validation', 'Result budget cannot hold the complete blocked preference delivery');
    }
    return { content: [{ type: 'text', text: JSON.stringify(sanitized) }],
      structuredContent: sanitized };
  };
  if (preferenceContext && value?.context?.source_truncated === true) return blockedResult('source_window');
  const state = { truncated: false, itemLimit: Number.isInteger(itemLimit) && itemLimit > 0 ? Math.min(itemLimit, 1000) : RESULT_ITEM_LIMIT };
  // Task identity is a required part of the response, even if preferences or
  // memory exhaust the delivery budget. Sanitize it before reserving its bytes.
  const required = {};
  for (const key of ['taskContextToken', 'task_context_token']) {
    if (typeof value?.[key] === 'string') required[key] = sanitize(value[key], state);
  }
  if (typeof value?.checkpoint_required === 'boolean') required.checkpoint_required = value.checkpoint_required;
  if (value?.agent_receipt?.required === true) {
    required.agent_receipt = sanitize(value.agent_receipt, state);
    if (state.truncated) throw new ApplicationError('validation', 'Cannot deliver the complete required Agent receipt');
  }
  if (preserveHumanInteraction && value?.human_interaction) {
    // A question is delivered whole or not at all; its producers bound its choices
    // (at most four), and a batch's source lists every decision it asks about (rec#96).
    const nativeState = { truncated: false, itemLimit: 1000 };
    required.human_interaction = sanitize(value.human_interaction, nativeState);
    if (nativeState.truncated) throw new ApplicationError('validation', 'Cannot deliver the complete human question');
  }
  const sanitized = sanitize(Object.keys(required).length ? { ...required, ...value } : value, state);
  const candidate = isObject(sanitized) && !Array.isArray(sanitized)
    ? sanitized
    : { result: sanitized };
  const structuredContent = boundedStructuredContent(
    candidate,
    state.truncated,
    limitBytes,
    required
  );
  const reason = preferenceContext && preferenceDeliveryReason(value, structuredContent);
  if (reason) return blockedResult(reason);
  const delivered = preferenceContext ? entryFieldOrder(structuredContent) : structuredContent;
  return { content: [{ type: 'text', text: JSON.stringify(delivered) }], structuredContent: delivered };
}

export function hookAdditionalContextToolResult(
  value,
  {
    hookEventName,
    label,
    // Added after a blocked frame's own lead (blockedPreferenceLabel).
    blockedNote = '',
    limitBytes = RESULT_LIMIT_BYTES,
    itemLimit = RESULT_ITEM_LIMIT
  }
) {
  const result = successToolResult(value, { limitBytes, itemLimit, preferenceContext: true });
  const blocked = result.structuredContent.preferences_complete === false;
  const warning = !blocked && result.structuredContent.truncated
    ? '\nContext delivery is incomplete. Do not claim full employee recovery or merge truncated memory. Read get_project_agent_memory for the exact role and project before continuing its work.'
    : '';
  const lead = blocked ? `${blockedPreferenceLabel(result.structuredContent)} ${blockedNote}`.trim() : label;
  const additionalContext = `${lead}${warning}\n${JSON.stringify(result.structuredContent)}`;
  return {
    ...result,
    content: [{
      type: 'text',
      text: JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          additionalContext
        }
      })
    }]
  };
}

export function errorToolResult(error) {
  const controlled = isControlledError(error);
  const unexpected = controlled ? null : uncontrolledFailure(error);
  const code = controlled ? error.code : unexpected.code;
  const message = controlled
    ? applicationErrorMessage(error)
    : unexpected.message;
  const validationErrors = controlled ? reportedValidationErrors(error) : [];
  const next = NEXT_STEPS[code];
  const structuredContent = {
    error: {
      code,
      message,
      ...(next ? { next } : {}),
      ...(validationErrors.length ? { validationErrors } : {})
    }
  };
  const detail = validationErrors
    .map(({ field, message: reason }) => (field ? `${field} — ${reason}` : reason))
    .join('; ');
  return {
    content: [{
      type: 'text',
      text: detail ? `${code}: ${message}\n${detail}` : `${code}: ${message}`
    }],
    structuredContent,
    isError: true
  };
}

// What a failure FULI did not anticipate still says (the coordinator's count:
// 32 get_collaboration_preferences failures in two weeks, every one
// "internal_error: Tool execution failed", and every FULI tool said the same
// while the console was not running). Only the kind of failure is read, from
// the error and its causes; no message text of it is passed on.
// Connection codes only. ENOENT is one too, but only from connect() to a local
// socket: FULI reading a missing file throws the same code from inside a call
// that may already have written something, and "nothing was done" would then
// be false (review of #1076).
const REFUSED = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);
const refusedConnection = item => REFUSED.has(item.code) || (item.code === 'ENOENT' && item.syscall === 'connect');
const TIMED_OUT = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const DROPPED = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
function uncontrolledFailure(error) {
  const chain = [];
  for (let item = error, depth = 0; item && typeof item === 'object' && depth < 8; item = item.cause, depth++) chain.push(item);
  const codes = chain.map(item => item.code).filter(code => typeof code === 'string');
  const names = chain.map(item => item.name);
  if (chain.some(refusedConnection) || chain.some(item => /\bECONNREFUSED\b/.test(String(item.message ?? '')))) {
    return { code: 'fuli_not_running', message: 'FULI did not answer on this computer (connection refused): it is not running, so nothing was done.' };
  }
  if (codes.some(code => TIMED_OUT.has(code)) || names.some(name => name === 'TimeoutError' || name === 'AbortError')) {
    return { code: 'fuli_timeout', message: 'FULI did not answer in time, so whether this call finished is unknown.' };
  }
  if (codes.some(code => DROPPED.has(code))) {
    return { code: 'fuli_connection_lost', message: 'The connection to FULI dropped, so whether this call finished is unknown.' };
  }
  return { code: 'internal_error', message: 'Tool execution failed inside FULI; it recorded where in its diagnostics.' };
}

// The one thing to do next, by code, for the failures an Agent meets most:
// said in the result so it never has to guess from a code.
const NEXT_STEPS = Object.freeze({
  fuli_not_running: 'Tell the person FULI is not running and ask them to open it (the FULI app); retry once it is.',
  fuli_timeout: 'Retry once with exactly the same arguments; if it times out again, tell the person FULI is slow to answer.',
  fuli_connection_lost: 'Retry once with exactly the same arguments; a write that already finished is not repeated.',
  provider_unavailable: 'FULI is running but its knowledge service is not ready (starting or stopped). Wait a moment and retry once; '
    + 'if it stays unavailable, tell the person to check FULI\'s status page.',
  provider_timeout: 'FULI\'s knowledge service did not answer in time. Retry once with the same arguments; if it fails again, tell the person.',
  internal_error: 'Retry once with exactly the same arguments; if it fails again, tell the person FULI hit an internal error '
    + '(read_diagnostic_events shows where).'
});

function reportedValidationErrors(error) {
  if (!Array.isArray(error?.validationErrors)) return [];
  return error.validationErrors
    .filter((entry) => entry && typeof entry.message === 'string' && entry.message.trim())
    .slice(0, VALIDATION_ERROR_LIMIT)
    .map(({ field, message }) => ({
      field: typeof field === 'string' ? boundedMessage(field) : '',
      message: boundedMessage(message)
    }));
}

export function applicationErrorMessage(error) {
  return boundedMessage(String(error.message));
}

export function protocolErrorResult(message, validationErrors = []) {
  if (message.includes('Input validation error')) {
    const error = new ApplicationError('validation', 'Invalid tool arguments');
    error.validationErrors = validationErrors;
    return errorToolResult(error);
  }
  return errorToolResult(new Error('Protocol tool failure'));
}

function sanitize(value, state, seen = new WeakSet(), depth = 0) {
  if (!isObject(value)) return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= RESULT_DEPTH_LIMIT) {
    state.truncated = true;
    return TRUNCATION_MARKER;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > state.itemLimit) state.truncated = true;
    const result = value.slice(0, state.itemLimit)
      .map((item) => sanitize(item, state, seen, depth + 1));
    seen.delete(value);
    return result;
  }

  const sanitized = {};
  let included = 0;
  for (const [key, item] of Object.entries(value)) {
    if (OMITTED_KEYS.has(key.toLowerCase().replaceAll('_', ''))) continue;
    if (included >= RESULT_PROPERTY_LIMIT) {
      state.truncated = true;
      break;
    }
    sanitized[key] = sanitize(item, state, seen, depth + 1);
    included += 1;
  }
  seen.delete(value);
  return sanitized;
}

function boundedStructuredContent(value, alreadyTruncated, limitBytes, required) {
  const budget = Number.isInteger(limitBytes) && limitBytes > 0
    ? limitBytes
    : RESULT_LIMIT_BYTES;
  if (!alreadyTruncated && jsonBytes(value) <= budget) return value;
  const reserved = { truncated: true, ...required };
  if (Object.keys(required).length && jsonBytes(reserved) > budget) {
    throw new ApplicationError('validation', 'Result budget cannot hold the required Agent receipt');
  }
  return projectObject(value, budget, 0, true, reserved);
}

function projectValue(value, budget, depth) {
  if (budget < 2) return undefined;
  if (typeof value === 'string') return projectString(value, budget);
  if (!isObject(value)) return jsonBytes(value) <= budget ? value : undefined;
  if (depth >= RESULT_DEPTH_LIMIT) return projectString(TRUNCATION_MARKER, budget);
  if (Array.isArray(value)) return projectArray(value, budget, depth);
  return projectObject(value, budget, depth);
}

function projectString(value, budget) {
  const limit = Math.min(budget, RESULT_STRING_LIMIT_BYTES);
  if (jsonBytes(value) <= limit) return value;
  if (jsonBytes('') > limit) return undefined;
  if (jsonBytes(TRUNCATION_MARKER) > limit) return '';

  let projected = '';
  for (const character of value) {
    if (jsonBytes(projected + character + TRUNCATION_MARKER) > limit) break;
    projected += character;
  }
  return projected + TRUNCATION_MARKER;
}

function projectArray(value, budget, depth) {
  const projected = [];
  let used = 2;
  // sanitize already applied the caller's item limit. A second default limit
  // here silently drops catalog entries and preferences when bytes are capped.
  for (const item of value) {
    const separatorBytes = projected.length ? 1 : 0;
    const child = projectValue(item, budget - used - separatorBytes, depth + 1);
    if (child === undefined) continue;
    const childBytes = jsonBytes(child);
    if (used + separatorBytes + childBytes > budget) continue;
    projected.push(child);
    used += separatorBytes + childBytes;
  }
  return projected;
}

function projectObject(value, budget, depth, root = false, reserved = {}) {
  const projected = root ? { truncated: true, ...reserved } : {};
  let used = jsonBytes(projected);
  let propertyCount = Object.keys(projected).length;

  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(projected, key)) continue;
    const separatorBytes = propertyCount ? 1 : 0;
    const propertyBytes = separatorBytes + jsonBytes(key) + 1;
    const child = projectValue(item, budget - used - propertyBytes, depth + 1);
    if (child === undefined) continue;
    const childBytes = jsonBytes(child);
    if (used + propertyBytes + childBytes > budget) continue;
    projected[key] = child;
    used += propertyBytes + childBytes;
    propertyCount += 1;
  }
  return projected;
}

function jsonBytes(value) {
  const json = JSON.stringify(value);
  return json === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(json, 'utf8');
}

function boundedMessage(message) {
  const singleLine = String(message).replace(/[\r\n\t]+/g, ' ').trim();
  return singleLine.slice(0, MESSAGE_LIMIT) || 'Request failed';
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}
