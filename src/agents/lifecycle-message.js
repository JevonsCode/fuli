const DEFAULT_MAX_BYTES = 8_000;
const TRUNCATION_SUFFIX = '… [truncated]';

export function boundedHookMessage(value, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof value !== 'string') return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;

  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, 'utf8');
  const contentBudget = Math.max(0, maxBytes - suffixBytes);
  let bytes = 0;
  let bounded = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > contentBudget) break;
    bounded += character;
    bytes += characterBytes;
  }
  return `${bounded}${TRUNCATION_SUFFIX}`;
}
