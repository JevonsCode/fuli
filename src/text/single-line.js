// Collapses line breaks (every Unicode line terminator) and tabs so a value
// fits on one Markdown or log line.
export function singleLine(value) {
  return String(value ?? '').replace(/[\r\n\t\v\f\x85\p{Zl}\p{Zp}]+/gu, ' ').trim();
}
