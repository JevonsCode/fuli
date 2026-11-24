// Habits that apply only in a case they state (a habit whose qualifiers carry
// an `appliesWhen`, or whose instruction opens "仅适用于 X", "仅在 X 时适用",
// "Applies only to X"): an entry spells them out only where this task may be
// that case. A question that has nothing to do with them used to carry every
// such hard rule in full ("68 条习惯" for one unrelated question).
//
// Missing a habit the person must follow costs more than sending one more, and
// a hard rule most of all, so the judgment leans one way throughout:
// - Whether a habit states a case at all, and which, is
//   preference-stated-case.js: a hard rule only by an `appliesWhen` or an
//   opening that says it *applies* only there; a case meaning every task is none.
// - Unknown counts as met: a request too short to judge by (fewer than 8
//   Chinese characters or 3 Latin words once filler is out), one that points
//   back at earlier words (REFERENCES: 「按上面说的继续做」), no request at all
//   (a restore after compaction, a host turn), or a case with no word left
//   once filler is out (「相关工作」).
// - Met: a distinctive word of its case appears in what the task shows of
//   itself: the person's request, the project's ID, name and brief, the
//   folder, the task scene, and the person's latest messages of this
//   conversation the entry carries (conversation.recovery: a later turn of the
//   same native session has its own window there; a new one has none).
// Only an unmet one is left out, with one line naming its case, and
// read_task_preferences still reads it by key. A hard rule's line also says
// what the rule says (its first sentence), so a task its case words miss
// ("region 的判断" for a case worded 「门店促销排期」) is still one the model
// can tell it touches. The judgment is a rule, never a model call.
import { basename } from 'node:path';
import { singleLine } from '../text/single-line.js';
import { distinctiveUnits, preferenceName, withoutFiller } from './preference-index.js';
import { preferenceAlwaysInline } from '../graphiti/preference-task-scope.js';
import { preferenceCondition } from './preference-stated-case.js';
import { entryPreferenceScene } from './preference-snapshot.js';
import { taskPreferenceRead } from '../mcp/preference-delivery.js';

// What a frame says of them (preferences_omitted.conditional, or
// conditional_unchanged in a delta whose base listed the same lines).
export const CONDITIONAL_LABEL = 'preferences_omitted.conditional (or conditional_unchanged: as the base listed) names habits '
  + 'that apply only in the case each states, left out as the task\'s words fit none '
  + '(a hard rule\'s line adds its gist): judge by meaning; if one applies, read it by key (read_task_preferences) before acting.';

// How many habits whose case this task is not an entry counts without a line
// (entry-inline-budget.js: where those lines would cost a body). A symbol on
// the entry, beside the fields a frame is checked by: it travels with the
// entry while a frame is built and is never part of what the model reads.
export const CONDITIONAL_FOLDED = Symbol('conditional habits counted without a line');

// All habits an entry's frame leaves out because this task is not the case they state.
export const conditionalOmitted = value => (value?.preferences_omitted?.conditional?.length ?? 0) + (value?.[CONDITIONAL_FOLDED] ?? 0);

// What a hard rule's line adds of what it says: its first sentence, cut at a
// word end to this many columns (a Chinese character counts two: 40 of them,
// or 80 Latin characters).
const GIST_COLUMNS = 80;
// A request says enough to tell a habit does not apply once it has this many
// Chinese characters, or Latin words, without filler (a Chinese pair count
// reached 3 at four characters: 「按上面说」, review of #1104). Mixed requests add
// the two shares.
const JUDGEABLE = Object.freeze({ han: 8, latin: 3 });
// Words a request uses to point back at what was said before; what they point
// to is not in the request, so such a request cannot be judged by its words.
export const REFERENCES = Object.freeze(['上面', '上述', '如上', '同上', '刚才', '刚刚', '之前说', '前面说', '上次说', '那个',
  '这个', '那些', '这些', '继续', '接着', '同样', '照旧', '照着', 'as above', 'the above', 'that one', 'this one', 'same as',
  'as before', 'continue', 'keep going', 'go on', 'carry on']);
const REFERENCE = new RegExp(REFERENCES.map(word => /^[a-z]/u.test(word) ? `\\b${word}\\b` : word).join('|'), 'iu');
// The person's latest messages of this conversation the entry carries.
const RECENT_MESSAGES = 4;
// Chinese words that carry no meaning of their own in a request, beyond filler.
const HAN_FUNCTION = /[了吗呢吧啊呀把被请帮我你他她它们一下看]/gu;

// One line for a habit left out because its case is not this task's: its key
// and layer, whether it is a hard rule, and the case in its own words; a hard
// rule's also the first sentence of what it says after that case, so a model
// can tell the task touches it where the case's words miss. The separator is
// the omission index's, so a delta tells a held line by its key.
export function conditionLine(item) {
  const { text, end } = preferenceCondition(item);
  const hard = preferenceAlwaysInline(item);
  const gist = hard ? firstSentence(item.instruction.trim().slice(end)) : '';
  return `${preferenceName(item)} — ${hard ? 'hard rule · ' : ''}${text}${gist ? ` · ${gist}` : ''}`;
}

// The first sentence of a text, cut at a word end to GIST_COLUMNS with "…".
function firstSentence(text) {
  const sentence = singleLine(text).replace(/^[\s：:，,；;。.、]+/u, '').split(/[。！？；;!?]|\.(?:\s|$)/u)[0].trim();
  const chars = [...sentence];
  let columns = 0;
  for (let index = 0; index < chars.length; index++) {
    columns += /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u.test(chars[index]) ? 2 : 1;
    if (columns <= GIST_COLUMNS - 1) continue;
    let cut = chars.slice(0, index).join('');
    // Inside a Latin word: back to its start.
    if (/\w$/u.test(cut) && /\w/u.test(chars[index])) cut = cut.replace(/\s*\S*$/u, '') || cut;
    return `${cut.trimEnd()}…`;
  }
  return sentence;
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
// the request cannot be judged by: missing, too short, or pointing back.
function taskSignals(value, request, projectPath) {
  if (!judgeable(request)) return null;
  const scene = entryPreferenceScene(value);
  const brief = value.project_agent_context?.project_brief;
  const messages = value.conversation?.recovery?.messages;
  const said = Array.isArray(messages) ? messages.filter(message => message?.role === 'user').slice(-RECENT_MESSAGES)
    .map(message => message.content) : [];
  return [request, value.context?.personal_project_id, brief?.name, brief?.summary, scene?.work_kind, scene?.workflow,
    typeof projectPath === 'string' && projectPath.trim() ? basename(projectPath) : null, ...said]
    .filter(text => typeof text === 'string' && text.trim()).join('\n').toLowerCase();
}

// Whether a request says enough, by itself, to tell a habit does not apply.
export function judgeable(request) {
  if (typeof request !== 'string' || REFERENCE.test(request)) return false;
  const text = withoutFiller(request).replace(HAN_FUNCTION, ' ');
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = distinctiveUnits(text.replace(/\p{Script=Han}+/gu, ' ')).length;
  return han / JUDGEABLE.han + latin / JUDGEABLE.latin >= 1;
}
