import { personWordsNotFoundRefusal, personWordsRequiredRefusal } from './refusals.js';

// The person's own decision an FLA relays (rec#80) runs only on words the
// person wrote: personWords must appear, ignoring case and spacing, in one of
// their newest saved messages of the calling task's own session. The Agent's
// arguments never name the message; FULI finds it and keeps where it was.
export const PERSON_WORDS_MIN = 2;
export const PERSON_WORDS_MAX = 600;
const RECENT_MESSAGES = 20;

export async function verifiedPersonWords(app, task, personWords) {
  const words = typeof personWords === 'string' ? personWords.trim() : '';
  if (words.length < PERSON_WORDS_MIN || words.length > PERSON_WORDS_MAX) throw personWordsRequiredRefusal();
  const wanted = comparable(words);
  const messages = await app.recentSessionUserMessages(task, RECENT_MESSAGES);
  const match = messages.findLast((message) => comparable(message.text).includes(wanted));
  if (!match) throw personWordsNotFoundRefusal();
  return { words, messageRef: match.ref };
}

function comparable(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}
