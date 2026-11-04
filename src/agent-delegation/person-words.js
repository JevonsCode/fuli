import { personWordsNotFoundRefusal, personWordsRequiredRefusal } from './refusals.js';

// The person's own decision an FLA relays (rec#80) runs only on words the
// person wrote: personWords must appear, ignoring case and spacing, in the
// prompt that began the calling task (entry-prompts.js, this same turn) or in
// one of their newest saved messages of that task's own session. The Agent's
// arguments never name the message; FULI finds it and keeps which source it
// was, never the prompt itself.
export const PERSON_WORDS_MIN = 2;
export const PERSON_WORDS_MAX = 600;
const RECENT_MESSAGES = 20;

export async function verifiedPersonWords(app, task, personWords) {
  const words = typeof personWords === 'string' ? personWords.trim() : '';
  if (words.length < PERSON_WORDS_MIN || words.length > PERSON_WORDS_MAX) throw personWordsRequiredRefusal();
  const wanted = comparable(words);
  const entry = app.entryPrompts?.read(task) ?? null;
  if (entry && comparable(entry.prompt).includes(wanted)) {
    return { words, messageRef: { source: 'current_turn', taskId: null, conversationId: null, at: entry.keptAt } };
  }
  const messages = await app.recentSessionUserMessages(task, RECENT_MESSAGES);
  const match = messages.findLast((message) => comparable(message.text).includes(wanted));
  if (!match) throw personWordsNotFoundRefusal();
  return { words, messageRef: { source: 'session_record', ...match.ref } };
}

function comparable(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}
