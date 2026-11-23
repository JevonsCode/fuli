// Collapses line breaks (every Unicode line terminator) and tabs so a value
// fits on one Markdown or log line.
export function singleLine(value) {
  return String(value ?? '').replace(/[\r\n\t\v\f\x85\p{Zl}\p{Zp}]+/gu, ' ').trim();
}

// The first `limit` characters of the one-line text; a longer one is cut at
// that character (not at a word end) and marked with …
export function singleLineExcerpt(value, limit) {
  const flat = singleLine(value).replace(/\s+/g, ' ');
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}
