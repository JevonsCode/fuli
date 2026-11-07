import { arraySchema, enumSchema, objectSchema, stringSchema } from '../agent-tools/schema.js';
import { InvalidInputError } from '../app/application-error.js';
import { injectionSignals } from './review-injection-precheck.js';

// rec#99: the choices a single Tonborg question offers the person. Tonborg's
// review model writes them for the item and its doubt, in the same review
// call; each maps to one of these fixed recording actions, which the host
// owns. A label is model output over untrusted knowledge text: it is shown as
// written and never chooses anything but its own action.
export const OPTION_ACTIONS = Object.freeze(['keep', 'correct', 'drop', 'later']);
export const LABEL_MAX = 40;
const OPTIONS_MAX = 4;
const LABEL_MIN = 2;
// 稍后处理 / 稍后 / Later: the person put the question off, not answered it.
export const SNOOZE_REASON = /^\s*(稍后|later\b)/i;
const LATER = Object.freeze({ label: '稍后处理', action: 'later' });
// Asked when Tonborg wrote no usable options, as before rec#99.
export const DEFAULT_OPTIONS = Object.freeze([{ label: '补充或纠正信息', action: 'correct' },
  { label: '保持当前记录', action: 'keep' }, LATER].map(Object.freeze));
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

// The answer schema's field: [] when Tonborg approves with confidence. A
// label's length and the count are checked apart (sanitizeQuestionOptions),
// so a long or extra choice is dropped instead of failing the whole verdict.
export const optionsProperty = Object.freeze({ options: arraySchema(objectSchema({ label: stringSchema(),
  action: enumSchema(OPTION_ACTIONS) }, ['label', 'action'])) });

// Tonborg's options, kept only when every rule holds for each; invalid ones are
// dropped, a later choice is always offered, and fewer than one usable choice
// besides later means none (the defaults are asked).
export function sanitizeQuestionOptions(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set(), kept = [];
  for (const option of raw) {
    const label = typeof option?.label === 'string' ? option.label.replace(/\s+/g, ' ').trim() : '';
    const action = option?.action;
    if (!OPTION_ACTIONS.includes(action) || [...label].length < LABEL_MIN || [...label].length > LABEL_MAX
      || CONTROL.test(option.label) || injectionSignals({ label }).length || !honest(label, action) || seen.has(key(label))) continue;
    seen.add(key(label));
    kept.push({ label, action });
  }
  const answers = kept.filter(option => option.action !== 'later').slice(0, OPTIONS_MAX - 1);
  if (!answers.length) return null;
  return [...answers, kept.find(option => option.action === 'later') ?? LATER];
}

// A label that reads as a fixed choice or as putting off must carry that action.
function honest(label, action) {
  const fixed = DEFAULT_OPTIONS.find(option => key(option.label) === key(label));
  if (fixed) return fixed.action === action;
  return SNOOZE_REASON.test(label) === (action === 'later');
}

const key = text => text.replace(/\s+/g, ' ').trim().toLowerCase();

// What a question asks: the record's own options while they are still valid, else the defaults.
export function questionOptions(record) {
  return sanitizeQuestionOptions(record?.options) ?? DEFAULT_OPTIONS.map(option => ({ ...option }));
}

// The option of this question the person's words pick, as written; null for custom input.
export function chosenOption(record, personWords) {
  return questionOptions(record).find(option => key(option.label) === key(personWords ?? '')) ?? null;
}

// The guess each answering action stands for (rec#96 delegated questions).
const GUESS_OF = Object.freeze({ keep: 'keep', correct: 'edit', drop: 'drop' });

// How a picked option is voted. A question Tonborg asked as its guess
// (delegated) is a vote on that guess, as the console's buttons cast it: up
// when the choice is the guessed action, down otherwise; later votes null. Any
// other question: keep votes up, every other choice votes null.
export function relayedChoiceVote(option, record) {
  if (record?.delegated === true && record.guess && option.action !== 'later') {
    return GUESS_OF[option.action] === record.guess ? 'up' : 'down';
  }
  return option.action === 'keep' ? 'up' : null;
}

// A choice the person picked from this question, relayed as their exact words,
// is recorded only as its own action (relayedChoiceVote), with 稍后处理 for
// later and what changed for correct and drop. Custom input matches no label
// and is recorded as the Agent reads it.
export function checkRelayedChoice(record, { vote, reason = '' }, personWords) {
  const chosen = chosenOption(record, personWords);
  if (!chosen) return;
  const wanted = relayedChoiceVote(chosen, record);
  if (vote !== wanted) {
    throw new InvalidInputError(`「${chosen.label}」 is recorded as ${chosen.action}: vote ${wanted === null ? 'null' : `"${wanted}"`}`);
  }
  if (chosen.action === 'later' && !SNOOZE_REASON.test(reason)) {
    throw new InvalidInputError(`「${chosen.label}」 is recorded as later: reason "稍后处理"`);
  }
  if (['correct', 'drop'].includes(chosen.action) && !reason.trim()) {
    throw new InvalidInputError(`「${chosen.label}」 is recorded as ${chosen.action}: reason = what changed`);
  }
}
