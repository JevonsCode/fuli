import { InvalidInputError } from '../app/application-error.js';

// Shared checks for untrusted input values. Each throws InvalidInputError (a
// TypeError with code invalid_input) naming the caller's label, never the value.

export function requiredString(value, label, maximum = Infinity) {
  if (typeof value !== 'string' || !value.trim()) throw new InvalidInputError(`${label} is required`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new InvalidInputError(`${label} is too long`);
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
