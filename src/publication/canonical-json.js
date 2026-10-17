import { createHash } from 'node:crypto';

// One canonical JSON form for hashing and signing across the product.
// `omitUndefined` follows JSON.stringify: undefined object fields are dropped and
// undefined array items or roots become null. Without it, undefined is rejected.
export function canonicalJson(value, { omitUndefined = false } = {}) {
  return JSON.stringify(canonicalValue(value, new Set(), omitUndefined) ?? null);
}

export function contentHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalValue(value, ancestors, omitUndefined) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value === undefined && omitUndefined) return undefined;
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
    if (Array.isArray(value)) {
      return value.map((item) => canonicalValue(item, ancestors, omitUndefined) ?? null);
    }
    if (!isPlainObject(value)) {
      throw new TypeError('Canonical JSON requires plain objects');
    }
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalValue(value[key], ancestors, omitUndefined)])
      .filter(([, item]) => item !== undefined));
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
