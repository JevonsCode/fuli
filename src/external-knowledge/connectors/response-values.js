// Shared readers for values that external knowledge sources return or accept.

const WEB_PROTOCOLS = Object.freeze(['http:', 'https:']);

// A browsable source link without embedded credentials, otherwise null.
export function onlineUrl(value, protocols = WEB_PROTOCOLS) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export function dateTimeOrNull(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

// A detached copy of a JSON object, or an empty object for anything else.
export function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? structuredClone(value)
    : {};
}

export function timeoutMilliseconds(value, label, fallback = 30_000) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1_000 || value > 120_000) {
    throw new TypeError(`${label} must be between 1000 and 120000`);
  }
  return value;
}
