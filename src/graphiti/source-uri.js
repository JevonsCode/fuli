const SOURCE_URI_ERROR =
  'Source URI must be an absolute HTTP(S) URI without credentials';

export function onlineSourceUri(value) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 2048
    || /(?:\s|\p{C})/u.test(value)
  ) {
    throw new TypeError(SOURCE_URI_ERROR);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(SOURCE_URI_ERROR);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
  ) {
    throw new TypeError(SOURCE_URI_ERROR);
  }
  return value;
}
