// Every listed rule fetch is a model round trip (Codex re-sends its whole
// prompt each time), so ordinary tasks must not read the shared rules at all.
export const TASK_RULES_ON_DEMAND = 'Shared rules are referenced by version. Do not read fuli://rules/task-entry for an ordinary task; read one referenced section only when you must act on it (workers, memory merge, conflicts).';

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
