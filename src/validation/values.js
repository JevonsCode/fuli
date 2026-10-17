// Shared checks for untrusted input values. Each throws TypeError with the caller's label.

export function requiredString(value, label, maximum = Infinity) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new TypeError(`${label} is too long`);
  return normalized;
}

// Lenient read: a trimmed nonempty string, otherwise null. Never throws.
export function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function positiveInteger(value, label, maximum) {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

// Missing means empty. Items are trimmed and deduplicated in their first-seen order.
export function uniqueTextArray(value, label, maximum = Infinity) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum ||
      value.some((item) => typeof item !== 'string' || !item.trim())) {
    const bound = Number.isFinite(maximum) ? `at most ${maximum} ` : '';
    throw new TypeError(`${label} must be an array of ${bound}nonempty strings`);
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
    throw new TypeError(`${label} must be a JSON object`);
  }
}
