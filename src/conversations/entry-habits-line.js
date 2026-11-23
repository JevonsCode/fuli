// The receipt sentence that says how many habits a new conversation got
// (turn-receipt-delivery.js) is written before the entry is bounded to the
// host's inline limit, so it used to claim the whole resolved set while the
// assistant had a handful of it: a receipt read "你的 70 条习惯" beside eight
// delivered ones (rec#146 item 6). A frame that leaves preferences out rewrites
// that one sentence with the two numbers it can now see; the link after it, and
// every other receipt line, are left exactly as they were.
import { deliveredHabits, HABITS_LEAD } from '../graphiti/turn-receipt-delivery.js';

// The entry with its habits sentence corrected, or the entry as it is when it
// has no habits line or leaves nothing out.
export function withDeliveredHabits(value) {
  const lines = value?.agent_receipt?.lines;
  const readable = value?.preferences_omitted?.count ?? 0;
  if (!Array.isArray(lines) || readable < 1) return value;
  const inline = Array.isArray(value.effective_preferences) ? value.effective_preferences.length : 0;
  const rewritten = lines.map(line => rewrite(line, inline, readable));
  return rewritten.some((line, index) => line !== lines[index])
    ? { ...value, agent_receipt: { ...value.agent_receipt, lines: rewritten } } : value;
}

// The sentence runs from the lead to the separator before the link.
function rewrite(line, inline, readable) {
  if (typeof line !== 'string' || !line.startsWith(HABITS_LEAD)) return line;
  const rest = line.slice(HABITS_LEAD.length);
  const link = rest.indexOf(' · [');
  return `${HABITS_LEAD}${deliveredHabits(inline, readable)}${link === -1 ? '' : rest.slice(link)}`;
}
