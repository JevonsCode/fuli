import { personWordsNotFoundRefusal, personWordsRequiredRefusal } from './refusals.js';

// The person's own decision an FLA relays (rec#80) runs only on words the
// person wrote: personWords must be whole clauses of theirs, ignoring case and
// spacing, in the prompt that began the calling task (entry-prompts.js, this
// same turn) or in one of their newest saved messages of that task's own
// session. A fragment never counts: 「通过」 is not in 「先别通过，等我看完」. The
// Agent's arguments never name the message; FULI finds it and keeps which
// source it was, never the prompt itself. An answer the person picked or typed
// in the client's own question card counts too, when FULI can read it
// (agents/choice-answers.js): the card's answer reaches no prompt, so the
// relay FULI asks for would otherwise always fail on it. Within a hook-entered
// task only answers given since its prompt count.
export const PERSON_WORDS_MIN = 2;
export const PERSON_WORDS_MAX = 600;
const RECENT_MESSAGES = 5;
const CLAUSE_BREAK = /[\r\n,.;:!?，。；：！？、…]+/;

export async function verifiedPersonWords(app, task, personWords) {
  const words = typeof personWords === 'string' ? personWords.trim() : '';
  if (words.length < PERSON_WORDS_MIN || words.length > PERSON_WORDS_MAX) throw personWordsRequiredRefusal();
  const wanted = clauses(words);
  if (!wanted.length) throw personWordsRequiredRefusal();
  const entry = app.entryPrompts?.read(task) ?? null;
  if (entry && said(entry.prompt, wanted)) {
    return { words, messageRef: { source: 'current_turn', taskId: null, conversationId: null, at: entry.keptAt } };
  }
  const choice = (await app.nativeChoiceAnswers?.(task) ?? [])
    .filter(answer => !entry?.keptAt || time(answer.at) >= time(entry.keptAt))
    .slice(-RECENT_MESSAGES)
    .findLast(answer => said(answer.text, wanted));
  if (choice) return { words, messageRef: { source: 'native_choice', taskId: null, conversationId: null, at: choice.at } };
  const messages = await app.recentSessionUserMessages(task, RECENT_MESSAGES);
  const match = messages.findLast((message) => said(message.text, wanted));
  if (!match) throw personWordsNotFoundRefusal();
  return { words, messageRef: { source: 'session_record', ...match.ref } };
}

function clauses(text) {
  return String(text).split(CLAUSE_BREAK).map((clause) => clause.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
}

// Whether the wanted clauses stand in the text one after another.
function said(text, wanted) {
  const written = clauses(text);
  return written.some((_, start) => wanted.every((clause, index) => written[start + index] === clause));
}

function time(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}
