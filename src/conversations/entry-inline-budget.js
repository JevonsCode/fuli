import { copyPreferenceScope, entryWorkKind } from './preference-snapshot.js';
import { preferenceAlwaysInline, preferenceNamesWorkKind, preferenceSceneReplaceable } from '../graphiti/preference-task-scope.js';
import { blockedByDeliveryBudget } from '../mcp/preference-delivery.js';

// A task entry bounded to the inline limit of the host that shows it (rec#11
// D-54). An Agent adapter whose host keeps only a preview of a longer hook
// context passes its limit; every other entry is delivered as it is.
export const OMITTED_PREFERENCES_LABEL = 'More preferences apply than this entry lists (preferences_omitted): '
  + 'read them with its read call before acting where one may apply.';
// Added when hard rules are among them (D-69).
export const ALWAYS_INLINE_OMITTED_LABEL = 'Hard rules are among them (preferences_omitted.includes_always_inline): '
  + 'read them all with read_task_preferences before acting; they stay in force.';

// The default: the entry as it is.
export const WHOLE_ENTRY = (value, { deliver }) => deliver(value);

// For a path without a session cache: every candidate is delivered as it is.
export function fitUncached(fit, value, render) {
  const attempt = candidate => ({ candidate, result: render(candidate) });
  return fit(value, { deliver: attempt, complete: attempt }).result;
}

// A fit for an inline limit of `limit`, measured by `length(result)`. The
// delivery passes `deliver(candidate)`, the frame this session would actually
// get (a delta where one applies), and `complete(candidate)`, its complete
// frame. The answer is always one `deliver` made.
//
// An entry that fits is unchanged. Otherwise, in this order:
// 1. the automatic recall becomes a pointer to its search, then the recent
//    conversation drops its oldest messages, as the Provider's own window does;
// 2. then preferences go, lowest ranked first. Closing fields, identity,
//    role, authority, conflicts and everything outside effective_preferences
//    stay; so do hard rules (preferenceAlwaysInline). The rest rank by kind
//    and task scene: a boundary a scene switch never revokes first, then an
//    item whose own scene key names the task's work kind, then human-confirmed
//    before agent-confirmed, then the Provider's order. The set is the largest
//    ranked prefix whose complete frame fits with the leanest context, so the
//    same preferences select the same set on the next turn, and a delta follows;
// 3. then as much recall and conversation as still fits comes back.
// What is left out is named by count with its reader. If the hard rules alone
// are over the limit (D-69), they are bounded the same way, as the largest
// prefix in the Provider's order, and the omission says so
// (includes_always_inline): past Claude Code's preview they were never seen.
export function inlineEntryFit(limit, length) {
  return (value, { deliver, complete }) => {
    // A frame the renderer blocked as over its own delivery budget is short,
    // but delivers nothing: it does not fit. Size only grows with the entry,
    // so both conditions stay monotonic for the search below. Any other
    // blocked reason is kept as it is.
    const fits = attempt => !blockedByDeliveryBudget(attempt.result.structuredContent) && length(attempt.result) <= limit;
    const levels = contextLevels(value);
    for (const level of levels) {
      const attempt = deliver(level);
      if (fits(attempt)) return attempt;
    }
    const preferences = Array.isArray(value.effective_preferences) ? value.effective_preferences : [];
    const { kept, ranked } = inlineRanking(preferences, entryWorkKind(value));
    const leanestFits = selected => fits(complete(withPreferences(levels.at(-1), selected, preferences.length)));
    // What the search may leave out: the ranked rest after every hard rule,
    // or the hard rules themselves when they alone do not fit.
    const [fixed, order] = !kept.length || leanestFits(new Set(kept)) ? [kept, ranked] : [[], kept];
    if (!order.length) return deliver(levels.at(-1));
    const selection = count => new Set([...fixed, ...order.slice(0, count)]);
    // At least one item of `order` is left out: with all of them nothing fit.
    let low = 0;
    let high = order.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (leanestFits(selection(middle))) low = middle;
      else high = middle - 1;
    }
    const selected = selection(low);
    let attempt;
    for (const level of levels) {
      attempt = deliver(withPreferences(level, selected, preferences.length));
      if (fits(attempt)) return attempt;
    }
    return attempt;
  };
}

// Indexes into effective_preferences: those that always stay, and the rest
// in rank order.
function inlineRanking(preferences, workKind) {
  const kept = [], optional = [];
  preferences.forEach((item, index) => (preferenceAlwaysInline(item) ? kept : optional).push(index));
  const rank = index => [preferenceSceneReplaceable(preferences[index]) ? 1 : 0,
    preferenceNamesWorkKind(preferences[index], workKind) ? 0 : 1,
    preferences[index].confirmation_status === 'confirmed' ? 0 : 1, index];
  const ranked = optional.map(index => [rank(index), index])
    .sort(([a], [b]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]).map(([, index]) => index);
  return { kept, ranked };
}

function withPreferences(level, selected, total) {
  return copyPreferenceScope(level, { ...level,
    effective_preferences: level.effective_preferences.filter((_, index) => selected.has(index)),
    preferences_omitted: { count: total - selected.size,
      ...(level.effective_preferences.some((item, index) => !selected.has(index) && preferenceAlwaysInline(item))
        ? { includes_always_inline: true } : {}),
      read: { tool: 'read_task_preferences', arguments: { taskContextToken: level.taskContextToken } } } });
}

// The entry, then each smaller context: the recall as a pointer, then the
// conversation window without its oldest message, one at a time. A window
// that drops a message says so as the Provider does: truncated, with the
// latest omitted sequence; read_agent_conversation reads it whole.
function contextLevels(value) {
  const levels = [value];
  let current = value;
  const recall = value.task_knowledge_recall;
  if (recall?.facts?.length || recall?.entities?.length || recall?.knowledge_index) {
    current = copyPreferenceScope(value, { ...value, task_knowledge_recall: recallPointer(recall) });
    levels.push(current);
  }
  const recovery = current.conversation?.recovery;
  const messages = Array.isArray(recovery?.messages) ? recovery.messages : [];
  for (let dropped = 1; dropped <= messages.length; dropped++) {
    levels.push(copyPreferenceScope(value, { ...current, conversation: { ...current.conversation, recovery: { ...recovery,
      messages: messages.slice(dropped), truncated: true,
      omitted_sequence: Math.max(recovery.omitted_sequence ?? 0, messages[dropped - 1].sequence) } } }));
  }
  return levels;
}

// The recall without its items: what it matched, how many, and the search
// that reads them (task_knowledge_recall's own guidance says how to query).
// A title-only knowledge_index (rec#51 D-59) is per task like the recall, so
// it goes with the recall, before any preference.
function recallPointer(recall) {
  const { facts = [], entities = [], knowledge_index: index, sourceMarker: _marker, noMatchSourceMarker: _none,
    pending_fallback: _pending, confirmed_use: _confirmed, retrieval_budget: _budget, ...summary } = recall;
  return { ...summary, items_omitted: facts.length + entities.length + (index?.items.length ?? 0),
    read: { tool: 'search_current_project_knowledge' } };
}
