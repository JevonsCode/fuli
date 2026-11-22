// One short line for every preference a task entry cannot spell out (rec#137).
// An entry bounded to a host's inline limit used to name what it left out by
// count alone, so the only way to learn what existed was to page a whole
// revision at the MCP budget. The index names each omitted item by key, scope
// and one sentence instead, and the omission's own read call expands the ones
// that may apply.
//
// Where an instruction states its own scope in prose only ("仅适用于…", "Only
// for…"), FULI lifts that clause into applies_when (rec#111): a restriction
// written in a sentence is otherwise invisible to every filter, and an Agent
// has applied such a rule to an unrelated task. It is a marker, never a
// removal: a misread clause must not silently drop a rule the person set.
import { singleLineExcerpt } from '../text/single-line.js';

// Long enough for one clause, short enough that a whole set of them costs less
// than a handful of bodies. Each line is one string, not an object: repeating
// three JSON key names per item would cost more than the words do.
const GIST_CHARS = 36;
const SCOPE_CHARS = 24;
const SEPARATOR = ' — ';
const SCOPE_MARK = ' · 仅适用于 ';

// The restrictive openers a person writes by hand. Each captures the scope it
// names, up to the punctuation that ends the clause.
const STATED_SCOPE = [
  /^仅(?:适用于|限|用于)\s*([^，,。：:；;]{2,40})/,
  /^只(?:适用于|在|针对)\s*([^，,。：:；;]{2,40})/,
  /^Only\s+(?:for|when|in|on)\s+([^,.:;]{2,60})/i,
  /^Applies?\s+only\s+to\s+([^,.:;]{2,60})/i
];

// The scope an instruction states in prose, or null. A session clause is
// already structured (preference-task-scope.js legacyPreferenceSession), so it
// is left to that reader rather than repeated here.
export function statedPreferenceScope(instruction) {
  if (typeof instruction !== 'string') return null;
  const text = instruction.trim();
  for (const pattern of STATED_SCOPE) {
    const scope = pattern.exec(text)?.[1]?.trim();
    if (scope && !/会话/.test(scope)) return singleLineExcerpt(scope, SCOPE_CHARS);
  }
  return null;
}

// What one omitted preference is about, in one line: its key, the opening of
// what it says, and the scope it states in prose where it states one. Never
// the whole body, so an index of a large set stays cheaper than one
// spelled-out rule.
export function preferenceIndexLine(item) {
  const scope = statedPreferenceScope(item?.instruction);
  return `${item?.preference_key ?? ''}${SEPARATOR}${singleLineExcerpt(item?.instruction ?? '', GIST_CHARS)}`
    + (scope ? `${SCOPE_MARK}${scope}` : '');
}

// The index of the items an entry does not list, in the order they were
// resolved, so two turns with the same set produce the same index. `detail`
// is 'full' (a line each) or 'keys' (the keys alone), the cheaper tier for an
// entry whose limit cannot hold the lines but can still say what exists.
export function preferenceIndex(preferences, selected, detail = 'full') {
  const omitted = preferences.filter((_, index) => !selected.has(index));
  return detail === 'keys' ? omitted.map(item => item?.preference_key ?? '') : omitted.map(preferenceIndexLine);
}

// Whether a prose-stated scope has anything to do with this task's own words:
// every word of the scope has to be there, so "only for synthetic timesheet
// work" does not meet every task that happens to say "synthetic". Unknown (no
// prompt, no stated scope) counts as related: this only ranks, never drops,
// and an item FULI cannot place must not be pushed out by a guess.
export function statedScopeMeetsTask(item, taskPrompt) {
  const scope = statedPreferenceScope(item?.instruction);
  if (!scope || typeof taskPrompt !== 'string' || !taskPrompt.trim()) return true;
  const prompt = taskPrompt.toLowerCase();
  return scopeTerms(scope).every(term => prompt.includes(term));
}

// The words of the stated scope worth looking for in a prompt: CJK runs of at
// least two characters and Latin words of at least three, without the filler
// that would match anything.
const FILLER = new Set(['the', 'this', 'that', 'and', 'for', 'with', 'work', 'task', 'tasks', 'when', '需求', '任务', '工作']);
function scopeTerms(scope) {
  const terms = [...scope.toLowerCase().matchAll(/[\p{Script=Han}]{2,}|[a-z][a-z0-9_-]{2,}/gu)].map(([term]) => term);
  const kept = terms.filter(term => !FILLER.has(term));
  return kept.length ? kept : terms;
}
