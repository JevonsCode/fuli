// Collapses line breaks and tabs so a value fits on one Markdown or log line.
export function singleLine(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}
