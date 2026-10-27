// Every listed rule fetch is a model round trip (Codex re-sends its whole
// prompt each time), so ordinary tasks must not read the shared rules at all.
// A call that carries its task token is decided by that session; without one
// it may be refused while another session of the client is off (rec#5 C3b).
export const PASS_TASK_TOKEN = 'Pass taskContextToken to every FULI call. ';
export const TASK_RULES_ON_DEMAND = 'Shared rules are referenced by version. Do not read fuli://rules/task-entry for an ordinary task; read one referenced section only when you must act on it (workers, Agent choices, board writes, memory merge, conflicts).';

// How a hook-delivered task ends, in the entry's own label (rec#47 F1). The
// entry only references the checkpoint and receipt rules, so the label says
// what to do with its fields. It names them rather than repeating their values:
// the whole context reaches the model, also on a host that keeps only a
// preview of a longer one, as Claude Code's entry is bounded to it
// (entry-inline-budget.js, rec#11 D-72). The Stop hook closes a task whose
// entry has checkpoint_guidance (stop-auto-close.js); a required checkpoint is
// left to the model.
export function taskClosingInstruction(entry) {
  if (typeof entry?.taskContextToken !== 'string') return '';
  const call = 'checkpoint_task_knowledge with this taskContextToken';
  const checkpoint = entry.checkpoint_required === true ? `Before your final reply, call ${call}. `
    : entry.checkpoint_guidance ? `The Stop hook closes this task. Call ${call} only when something is worth recording `
      + '(knowledge, experience, memory changes, collaborators, a meaningful workLog). ' : '';
  return checkpoint + taskReceiptInstruction(entry);
}

// The receipt sentence alone: a blocked frame keeps it too (preference-lifecycle.js).
export function taskReceiptInstruction(entry) {
  return entry?.agent_receipt?.required === true && typeof entry.agent_receipt.markdown === 'string'
    ? 'End your final reply with agent_receipt.markdown, unchanged and once '
      + '(a receipt returned by checkpoint_task_knowledge replaces it). ' : '';
}

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
