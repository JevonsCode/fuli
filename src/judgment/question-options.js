import { enumSchema, stringSchema } from '../agent-tools/schema.js';
import { InvalidInputError } from '../app/application-error.js';
import { singleLineExcerpt } from '../text/single-line.js';
import { injectionSignals } from './review-injection-precheck.js';

// What one Tonborg question is, everywhere a person meets it (Jevons 11-11:
// 「说人话，说重点；能点一下是否，就不要让他自己输」): ONE sentence that says
// what FULI is about to do with an item and why Tonborg is unsure, the guessed
// action as the first choice, its opposite as the second, and 「其他」 for
// the person's own words. The console's 待决策 row, the host's native choice
// card and list_tonborg_questions all ask this same shape.
//
// The review model answers three things per candidate: guess and doubt, fixed
// values, and question, its own sentence. The sentence is shown only while it
// keeps the shape (usableQuestion); otherwise the question is written here
// from the item's title and those fixed values. That template holds none of
// the model's words, so an Agent may read and ask it (rec#50), and the two
// choices follow from the guess, so they always answer the question.
export const GUESSES = Object.freeze(['keep', 'drop', 'edit']);
// Why Tonborg is unsure, as the review criteria name it (review-prompt.js).
export const DOUBTS = Object.freeze(['one_off', 'not_your_words', 'duplicate', 'conflict', 'unclear', 'agent_reply', 'scope', 'other']);
export const QUESTION_MAX = 80;
// The answer schema's fields: a review is asked for all three. An answer is
// then checked with the guess as part of its verdict (a delegated review must
// give it) and its doubt and question apart (softAsk), so a missing doubt or a
// long or odd sentence is replaced instead of failing the verdict.
export const guessProperty = Object.freeze({ guess: enumSchema(GUESSES) });
export const askProperties = Object.freeze({ ...guessProperty, doubt: enumSchema(DOUBTS), question: stringSchema() });
export const ASK_FIELDS = Object.freeze(Object.keys(askProperties));
const SOFT_FIELDS = Object.freeze(['doubt', 'question']);
// More than any question that keeps the shape; what is stored of one that does not.
const STORED_QUESTION_MAX = 400;

// One raw decision of a review answer, split into the verdict the schema
// checks and the doubt and question a record keeps of it, if usable at all.
export function softAsk(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { verdict: raw, ask: {} };
  const verdict = Object.fromEntries(Object.entries(raw).filter(([field]) => !SOFT_FIELDS.includes(field)));
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  return { verdict, ask: { ...(DOUBTS.includes(raw.doubt) ? { doubt: raw.doubt } : {}),
    ...(question ? { question: [...question].slice(0, STORED_QUESTION_MAX).join('') } : {}) } };
}
// 稍后处理 / 稍后 / Later: the person put the question off, not answered it.
export const SNOOZE_REASON = /^\s*(稍后|later\b)/i;

const DEFAULT_LANGUAGE = 'zh-CN';
// quote: the item's excerpt, its own quote marks made inner ones; subject: the item when it has no title to quote; sentence: (subject, doubt, ask) as one line.
const WORDS = Object.freeze({
  'zh-CN': {
    answers: { keep: '保留', drop: '不要', edit: '改一下' }, keepAsIs: '原样保留', other: '其他',
    ask: { keep: '保留吗？', drop: '丢掉吗？', edit: '先改一下再留吗？' },
    doubt: { one_off: '像是只说了这一次', not_your_words: '不像是你亲口说的', duplicate: '和已有的一条差不多', conflict: '和已有的一条对不上',
      unclear: '说得不够清楚', agent_reply: '像是 AI 自己的回复', scope: '不确定用在哪', other: '我拿不准' },
    quote: text => `「${text.replace(/「/g, '『').replace(/」/g, '』')}」`, subject: '有一条知识', sentence: (subject, doubt, ask) => `${subject}${doubt}，${ask}`,
    verbs: { keep: /保留|留着|留下/, drop: /不要|丢|删|去掉/, edit: /改/ },
    open: /什么|怎么|怎样|如何|哪|为什么|为何|还是|多少|几个|谁/, own: text => /\p{Script=Han}/u.test(text)
  },
  'en-US': {
    answers: { keep: 'Keep', drop: 'Drop', edit: 'Edit' }, keepAsIs: 'Keep as is', other: 'Other',
    ask: { keep: 'Keep it?', drop: 'Drop it?', edit: 'Edit it before keeping?' },
    doubt: { one_off: 'looks like a one-off', not_your_words: 'does not look like your own words', duplicate: 'is close to one you already have',
      conflict: 'disagrees with one you already have', unclear: 'is not clear enough', agent_reply: 'looks like an AI\'s own reply',
      scope: 'may not apply everywhere', other: 'is one I am not sure about' },
    quote: text => `"${text.replace(/"/g, "'")}"`, subject: 'One item', sentence: (subject, doubt, ask) => `${subject} ${doubt}. ${ask}`,
    verbs: { keep: /\bkeep/i, drop: /\b(drop|remove|delete)/i, edit: /\b(edit|change|fix|rewrite|correct)/i },
    open: /\b(what|how|which|why|who|when|where|or)\b/i, own: text => !/\p{Script=Han}/u.test(text)
  }
});
const wordsOf = language => WORDS[language] ?? WORDS[DEFAULT_LANGUAGE];

// The excerpt of the item a question quotes: short in a chat card, longer in the console's row.
const EXCERPT = 24;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const QUOTED = /「([^」]*)」|“([^”]*)”|"([^"]*)"/gu;
const flat = text => text.replace(/\s+/g, ' ').trim().toLowerCase();

// Whether the model's own sentence may be shown as the question: one line of
// at most QUESTION_MAX characters in the person's language that ends as one
// question, quotes the item, asks whether to do the guessed action, and is
// neither open (what, how, which) nor either/or.
function usableQuestion(text, { guess, title, language }) {
  if (typeof text !== 'string' || CONTROL.test(text.trim())) return false;
  const line = text.trim(), words = wordsOf(language);
  if (!line || [...line].length > QUESTION_MAX || !/[?？]$/.test(line) || line.match(/[?？]/g).length !== 1) return false;
  const quotes = [...line.matchAll(QUOTED)].map(match => flat(match[1] ?? match[2] ?? match[3]).replace(/(…|\.\.\.)$/, ''));
  const own = line.replace(QUOTED, ' ');
  const named = !title || quotes.some(quote => [...quote].length >= 2 && flat(title).includes(quote));
  return named && words.own(own) && words.verbs[guess].test(own) && !words.open.test(own) && !injectionSignals({ question: line }).length;
}

// What a stored review asks the person, in their language. record: its title,
// guess, doubt and question (a review from before 11-11 has no doubt, and one
// that was not delegated no guess: it is asked as keep, with no choice marked
// as the guess; an Agent's view of a record has no question, so it reads the
// template). excerpt: how much of the title is quoted. answers: the two choices, the guess first; a third way to answer and the
// person's own words go under other.
export function plainQuestion(record, language, { excerpt = EXCERPT } = {}) {
  const words = wordsOf(language);
  const guess = GUESSES.includes(record?.guess) ? record.guess : 'keep';
  const doubt = DOUBTS.includes(record?.doubt) ? record.doubt : 'other';
  const title = typeof record?.title === 'string' && record.title.trim() ? record.title : null;
  const own = usableQuestion(record?.question, { guess, title, language }) ? record.question.trim() : null;
  const opposite = guess === 'keep' ? 'drop' : 'keep';
  return {
    question: own ?? words.sentence(title ? words.quote(singleLineExcerpt(title, excerpt)) : words.subject, words.doubt[doubt], words.ask[guess]),
    guess: record?.guess ?? null, doubt,
    answers: [{ answer: guess, label: words.answers[guess] },
      { answer: opposite, label: guess === 'edit' ? words.keepAsIs : words.answers[opposite] }],
    other: words.other
  };
}

// The choice of this question the person's words pick, as written; null for their own words.
export function chosenAnswer(record, personWords, language) {
  return plainQuestion(record, language).answers.find(choice => flat(choice.label) === flat(personWords ?? '')) ?? null;
}

// How a picked choice is voted: on Tonborg's guess when the review has one, as
// the console's buttons cast it (up when it is the guessed action, down
// otherwise). A review without a guess: keep votes up, any other choice null.
export function relayedChoiceVote(choice, record) {
  if (record?.guess) return choice.answer === record.guess ? 'up' : 'down';
  return choice.answer === 'keep' ? 'up' : null;
}

// A choice the person picked from this question, relayed as their exact words,
// is recorded only as its own answer (relayedChoiceVote), with what changed
// for edit and drop. Their own words match no label and are recorded as the
// Agent reads them.
export function checkRelayedChoice(record, { vote, reason = '' }, personWords, language) {
  const chosen = chosenAnswer(record, personWords, language);
  if (!chosen) return;
  const wanted = relayedChoiceVote(chosen, record);
  if (vote !== wanted) {
    throw new InvalidInputError(`「${chosen.label}」 is recorded as ${chosen.answer}: vote ${wanted === null ? 'null' : `"${wanted}"`}`);
  }
  if (['edit', 'drop'].includes(chosen.answer) && !reason.trim()) {
    throw new InvalidInputError(`「${chosen.label}」 is recorded as ${chosen.answer}: reason = what changed`);
  }
}
