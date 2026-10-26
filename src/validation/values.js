import { ConnectorResponseError, InvalidInputError } from '../app/application-error.js';

// Shared checks for untrusted input values. The caller-input checks throw
// InvalidInputError (a TypeError with code invalid_input) naming the caller's
// label, never the value. A label is a constant field name
// (test/validation-labels.test.js).

export function requiredString(value, label, maximum = Infinity) {
  return checkedText(value, label, maximum, InvalidInputError);
}

// The same check for a value FULI supplies itself, never the caller: its own
// personal space, the host session a hook or the MCP process is bound to, a
// task's stored session. A missing one is FULI's fault, so it stays a plain
// TypeError (internal_error), never invalid_input the caller cannot fix.
export function requiredBinding(value, label, maximum = Infinity) {
  return checkedText(value, label, maximum, TypeError);
}

// The same check for a value a remote external-knowledge source returned: a
// missing field is the source's fault, not the caller's argument, so it gets
// connector_response_invalid instead of invalid_input.
export function requiredResponseString(value, label, maximum = Infinity) {
  return checkedText(value, label, maximum, ConnectorResponseError);
}

function checkedText(value, label, maximum, Failure) {
  if (typeof value !== 'string' || !value.trim()) throw new Failure(`${label} is required`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Failure(`${label} is too long`);
  return normalized;
}

// Lenient read: a trimmed nonempty string, otherwise null. Never throws.
export function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function positiveInteger(value, label, maximum) {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new InvalidInputError(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

// Missing means empty. Items are trimmed and deduplicated in their first-seen order.
export function uniqueTextArray(value, label, maximum = Infinity) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum ||
      value.some((item) => typeof item !== 'string' || !item.trim())) {
    const bound = Number.isFinite(maximum) ? `at most ${maximum} ` : '';
    throw new InvalidInputError(`${label} must be an array of ${bound}nonempty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

export function assertJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidInputError(`${label} must be a JSON object`);
  }
}
