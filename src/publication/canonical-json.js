import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value, new Set()));
}

export function contentHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalValue(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError('Canonical JSON requires finite numbers');
  }
  if (typeof value !== 'object') {
    throw new TypeError('Canonical JSON contains an unsupported value');
  }
  if (ancestors.has(value)) throw new TypeError('Canonical JSON cannot contain circular values');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item, ancestors));
    if (!isPlainObject(value)) {
      throw new TypeError('Canonical JSON requires plain objects');
    }
    return Object.fromEntries(Object.keys(value).sort().map(
      (key) => [key, canonicalValue(value[key], ancestors)]
    ));
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
