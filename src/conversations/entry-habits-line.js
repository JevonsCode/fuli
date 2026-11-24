// The receipt sentence that says how many habits a new conversation got
// (turn-receipt-delivery.js) is written before the entry is bounded to the
// host's inline limit, so it used to claim the whole resolved set while the
// assistant had a handful of it: a receipt read "你的 70 条习惯" beside eight
// delivered ones (rec#146 item 6). A frame that leaves preferences out rewrites
// that one sentence with the two numbers it can now see; the link after it, and
// every other receipt line, are left exactly as they were.
import { deliveredHabits, HABITS_LEAD } from '../graphiti/turn-receipt-delivery.js';

// The entry with its habits sentence corrected, or the entry as it is when it
// has no habits line or leaves nothing out. A task entry's receipt carries the
// line in its markdown, one line each (identity-receipt.js withReceiptLines);
// a receipt still holding them apart has them in `lines`.
export function withDeliveredHabits(value) {
  const receipt = value?.agent_receipt;
  const readable = value?.preferences_omitted?.count ?? 0;
  if (!receipt || readable < 1) return value;
  const inline = Array.isArray(value.effective_preferences) ? value.effective_preferences.length : 0;
  const counts = [inline, readable, value.preferences_omitted.conditional?.length ?? 0];
  const markdown = typeof receipt.markdown === 'string'
    ? receipt.markdown.split('\n').map(line => rewrite(line, counts)).join('\n') : receipt.markdown;
  const lines = Array.isArray(receipt.lines) ? receipt.lines.map(line => rewrite(line, counts)) : receipt.lines;
  return markdown !== receipt.markdown || lines?.some((line, index) => line !== receipt.lines[index])
    ? { ...value, agent_receipt: { ...receipt, markdown, ...(lines ? { lines } : {}) } } : value;
}

// The sentence runs from the lead to the separator before the link.
function rewrite(line, counts) {
  if (typeof line !== 'string' || !line.startsWith(HABITS_LEAD)) return line;
  const rest = line.slice(HABITS_LEAD.length);
  const link = rest.indexOf(' · [');
  return `${HABITS_LEAD}${deliveredHabits(...counts)}${link === -1 ? '' : rest.slice(link)}`;
}
