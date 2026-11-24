// Habits that apply only in a case they state (a habit written "仅适用于 X",
// "仅在 X 时适用", "Applies only to X", or one whose qualifiers carry an
// `appliesWhen`): an entry spells them out only where this task may be that
// case. A question that has nothing to do with them used to carry every such
// hard rule in full ("68 条习惯" for one unrelated question).
//
// The judgment is a rule, never a model call, and it runs on what the entry
// already holds: the person's request, the project's ID, name and brief, the
// folder, the task scene, and the person's recent messages the entry carries.
// Three outcomes for each conditional habit:
// - met: a distinctive word of its condition appears in those signals;
// - unmet: its condition has distinctive words and none of them appears,
//   while the request itself says enough to judge by;
// - unknown: the request is too short ("继续", "好的") or missing (a restore
//   after compaction, a host turn), or the condition yields no word to match.
// Unknown counts as met: missing a habit the person must follow costs more
// than sending one more. Only an unmet one is left out, with one line naming
// its case, and read_task_preferences still reads it by key.
import { basename } from 'node:path';
import { singleLineExcerpt } from '../text/single-line.js';
import { distinctiveUnits, preferenceName, statedScopePhrase } from './preference-index.js';
import { preferenceAlwaysInline, preferenceAppliesWhen } from '../graphiti/preference-task-scope.js';
import { entryPreferenceScene } from './preference-snapshot.js';
import { taskPreferenceRead } from '../mcp/preference-delivery.js';

// What a frame says of them (preferences_omitted.conditional, or
// conditional_unchanged in a delta whose base listed the same lines).
export const CONDITIONAL_LABEL = 'preferences_omitted.conditional (or conditional_unchanged: as the base listed) names habits '
  + 'that apply only in the case each states, left out because this task does not look like one: '
  + 'if it is, read that one by key with read_task_preferences before acting.';

// A condition is shown as its own words, cut to one short clause.
const CONDITION_CHARS = 40;
// A request with fewer distinctive units than this says too little to tell a
// habit does not apply ("继续", "好的", "fix it").
const JUDGEABLE_UNITS = 3;
// The person's latest messages the entry already carries: what "this" in a
// short follow-up refers to.
const RECENT_MESSAGES = 4;

// The case a habit states, as { text, units }, or null for a habit without
// one. `appliesWhen` (free text a person or Agent wrote) wins over a case the
// instruction states in its opening words; a habit that states neither is
// unconditional, whatever its words seem to be about.
export function preferenceCondition(item) {
  const appliesWhen = preferenceAppliesWhen(item);
  const phrase = appliesWhen ?? statedScopePhrase(item?.instruction);
  return phrase ? { text: singleLineExcerpt(phrase, CONDITION_CHARS), units: distinctiveUnits(phrase) } : null;
}

// One line for a habit left out because its case is not this task's: its key
// and layer, whether it is a hard rule, and the case in its own words. The
// separator is the omission index's, so a delta tells a held line by its key.
export function conditionLine(item) {
  const { text } = preferenceCondition(item);
  return `${preferenceName(item)} — ${preferenceAlwaysInline(item) ? 'hard rule · ' : ''}${text}`;
}

// The indexes of the entry's preferences whose stated case this task clearly
// is not (unmet above), in entry order. None where the task's reader cannot
// serve them (rec#128: nothing is left out behind a read that would be
// refused) or where the request cannot be judged. `request`: the person's
// prompt for this task, null where the entry has none. `given(item)`: whether
// this context generation already spelled the habit out; a body the model
// holds is never taken back.
export function unmetConditions(value, { request = null, projectPath = null, given = () => false } = {}) {
  const preferences = Array.isArray(value?.effective_preferences) ? value.effective_preferences : [];
  if (!preferences.length || !taskPreferenceRead(value)) return [];
  const signals = taskSignals(value, request, projectPath);
  if (!signals) return [];
  return preferences.flatMap((item, index) => {
    const condition = preferenceCondition(item);
    if (!condition?.units.length || given(item)) return [];
    return condition.units.some(unit => signals.includes(unit)) ? [] : [index];
  });
}

// Everything the task shows of itself, lowercased into one text, or null when
// the request says too little to judge by.
function taskSignals(value, request, projectPath) {
  if (typeof request !== 'string' || new Set(distinctiveUnits(request)).size < JUDGEABLE_UNITS) return null;
  const scene = entryPreferenceScene(value);
  const brief = value.project_agent_context?.project_brief;
  const messages = value.conversation?.recovery?.messages;
  const said = Array.isArray(messages) ? messages.filter(message => message?.role === 'user').slice(-RECENT_MESSAGES)
    .map(message => message.content) : [];
  return [request, value.context?.personal_project_id, brief?.name, brief?.summary, scene?.work_kind, scene?.workflow,
    typeof projectPath === 'string' && projectPath.trim() ? basename(projectPath) : null, ...said]
    .filter(text => typeof text === 'string' && text.trim()).join('\n').toLowerCase();
}
