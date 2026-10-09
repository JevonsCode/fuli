import { ApplicationError } from '../app/application-error.js';

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

export function successToolResult(value, { limitBytes = RESULT_LIMIT_BYTES, itemLimit = RESULT_ITEM_LIMIT } = {}) {
  const state = { truncated: false, itemLimit: Number.isInteger(itemLimit) && itemLimit > 0 ? Math.min(itemLimit, 1000) : RESULT_ITEM_LIMIT };
  // Task identity is a required part of the response, even if preferences or
  // memory exhaust the delivery budget. Sanitize it before reserving its bytes.
  const required = {};
  if (value?.agent_receipt?.required === true) {
    required.agent_receipt = sanitize(value.agent_receipt, state);
    if (state.truncated) throw new ApplicationError('validation', 'Cannot deliver the complete required Agent receipt');
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
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent
  };
}

export function hookAdditionalContextToolResult(
  value,
  {
    hookEventName,
    label,
    limitBytes = RESULT_LIMIT_BYTES,
    itemLimit = RESULT_ITEM_LIMIT
  }
) {
  const result = successToolResult(value, { limitBytes, itemLimit });
  const warning = result.structuredContent.truncated
    ? '\nContext delivery is incomplete. Do not claim full employee recovery or merge truncated memory. Read get_project_agent_memory for the exact role and project before continuing its work; retrieve omitted preference details before applying them.'
    : '';
  const additionalContext = `${label}${warning}\n${JSON.stringify(result.structuredContent)}`;
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
  const controlled = error instanceof ApplicationError;
  const code = controlled ? error.code : 'internal_error';
  const message = controlled
    ? applicationErrorMessage(error)
    : 'Tool execution failed';
  const validationErrors = controlled ? reportedValidationErrors(error) : [];
  const structuredContent = {
    error: {
      code,
      message,
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
