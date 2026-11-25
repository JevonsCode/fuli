import { personWordsNotFoundRefusal, personWordsRequiredRefusal, reuseInstructionNotFoundRefusal } from './refusals.js';

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
  return { words, messageRef: { source: 'session_record', ...messageRefOf(match.ref) } };
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

// A lesson is kept only from an affirmative reuse instruction in the request
// that began this turn: 下次也这样做, or "do it this way next time". The words
// must be the person's own instruction, not a bare thanks, a negation, a
// question, an older quote, a cited example or words being explained.
const REUSE_INSTRUCTION = new RegExp([
  '下次[^。！？.!?\\n]{0,8}(?:也|还|就|继续|照|按)[^。！？.!?\\n]{0,6}(?:这样|这么|此|这个)[^。！？.!?\\n]{0,6}(?:做|干|来|办|处理|走)',
  '下次[^。！？.!?\\n]{0,8}(?:这样|这么|如此)[^。！？.!?\\n]{0,6}(?:做|干|来|办|处理|走)',
  '以后[^。！？.!?\\n]{0,8}(?:也|都|就|继续|照|按)[^。！？.!?\\n]{0,6}(?:这样|这么|此|这个)[^。！？.!?\\n]{0,6}(?:做|干|来|办|处理|走)',
  '以后[^。！？.!?\\n]{0,8}(?:这样|这么|如此)[^。！？.!?\\n]{0,6}(?:做|干|来|办|处理|走)',
  '今后[^。！？.!?\\n]{0,8}(?:也|都|就|照|按)[^。！？.!?\\n]{0,6}(?:这样|这么|此|这个)[^。！？.!?\\n]{0,6}(?:做|干|来|办|处理|走)',
  '\\b(?:next time|from now on|going forward|in the future)\\b[\\s\\S]{0,40}\\b(?:do|handle|run|work|approach|treat)\\b[\\s\\S]{0,24}\\b(?:it\\s+|this\\s+|that\\s+)?(?:this way|the same way|same way|like this|like that)\\b',
  '\\b(?:do|handle|run|work|approach|treat)\\b[\\s\\S]{0,24}\\b(?:it\\s+|this\\s+)?(?:this way|the same way|same way|like this|like that)\\b[\\s\\S]{0,24}\\b(?:next time|from now on|going forward|in the future)\\b',
  '\\b(?:this way|the same way|same way|like this|like that)\\b[\\s\\S]{0,24}\\b(?:next time|from now on|going forward|in the future)\\b'
].join('|'), 'iu');
const NEGATED_REUSE = new RegExp([
  '(?:不|别|不要|不用|不必|无需|没|没有|勿|莫)[^。！？.!?\\n]{0,10}(?:下次|以后|今后|这样|这么|如此|照这样|按这个)[^。！？.!?\\n]{0,8}(?:做|干|来|办|处理|走)',
  '\\b(?:not|never|no need|don\'?t|do not|without)\\b[^.!?\\n]{0,24}\\b(?:next time|from now on|going forward|this way|the same way|same way|like this)\\b'
].join('|'), 'iu');
// Words that introduce a quote or an example rather than an instruction; they
// sit in the clause just before the matched one ("比如，下次也这样做").
const QUOTED_OR_OLDER = /(?:如果|假如|要是|比如|例如|比方说|举个例|举个例子|打个比方|譬如|引用|举例|说是|听说|上次|之前|刚才|先前|if (?:someone|anyone|i|you) (?:say|said)|when (?:someone|anyone) says|for example|e\.?g\.?|quote[d]?|earlier|previously|last time)/iu;
// The person asking what the words mean, not asking for the work.
const ASKS_ABOUT_THE_WORDS = /(?:只解释|解释这句|解释这句话|这句话是什么意思|是什么意思|什么意思|怎么读|怎么念|英文怎么说|用英语怎么说)/iu;
const QUESTION = /[？?]\s*$/u;
const QUOTE_PAIRS = new Map([['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['"', '"']]);

export async function verifiedReuseInstruction(app, task, personWords) {
  const words = typeof personWords === 'string' ? personWords.trim() : '';
  if (words.length < PERSON_WORDS_MIN || words.length > PERSON_WORDS_MAX) throw personWordsRequiredRefusal();
  const wanted = clauses(words);
  if (!wanted.length) throw personWordsRequiredRefusal();
  const request = await currentRequest(app, task);
  const context = request ? reuseContext(request.text, wanted) : null;
  if (!context) throw personWordsNotFoundRefusal();
  const claimed = wanted.join('，');
  if (!REUSE_INSTRUCTION.test(claimed) || NEGATED_REUSE.test(claimed)
    || QUOTED_OR_OLDER.test(context.window) || ASKS_ABOUT_THE_WORDS.test(context.window)
    || ASKS_ABOUT_THE_WORDS.test(context.after)
    || context.question || context.quoted || quotedClaim(claimed)) {
    throw reuseInstructionNotFoundRefusal();
  }
  return { words, messageRef: request.ref };
}

// The request that began this turn only: a hook's own prompt, else a saved
// message of this task's own turn. Neither an older task's message in the same
// session nor an older quote in it can opt in.
async function currentRequest(app, task) {
  const entry = app.entryPrompts?.read(task) ?? null;
  if (entry?.prompt) {
    return { text: entry.prompt, ref: { source: 'current_turn', taskId: null, conversationId: null, at: entry.keptAt } };
  }
  const messages = await app.recentSessionUserMessages(task, RECENT_MESSAGES);
  const newest = (Array.isArray(messages) ? messages : []).filter(({ ref }) => savedInThisTurn(ref, task)).at(-1);
  if (!newest?.text) return null;
  return { text: newest.text, ref: { source: 'session_record', ...messageRefOf(newest.ref) } };
}

// A saved message counts only when its turn is this task's own turn. Without a
// turn to compare, nothing saved is accepted: the hook's prompt is the only
// authoritative same-turn source (a transcript is saved when its turn ends).
function savedInThisTurn(ref, task) {
  return typeof task.turnId === 'string' && task.turnId.length > 0 && ref?.turnId === task.turnId;
}

function messageRefOf(ref) {
  return { taskId: ref?.taskId ?? null, conversationId: ref?.conversationId ?? null, at: ref?.at ?? null };
}

// The clauses the person's words matched, with what surrounds them in the raw
// request: the clause before (an example or a quote introduces them), the clause
// after (words being explained), the sentence (a question), and whether they sit
// inside quotation marks.
function reuseContext(text, wanted) {
  const parts = clausesAt(text);
  for (let start = 0; start + wanted.length <= parts.length; start += 1) {
    if (!wanted.every((clause, index) => parts[start + index].text === clause)) continue;
    const first = parts[start];
    const last = parts[start + wanted.length - 1];
    const sentence = sentenceAround(text, first.start, last.end);
    return {
      window: parts.slice(Math.max(0, start - 1), start + wanted.length).map(part => part.text).join('，'),
      after: parts[start + wanted.length]?.text ?? '',
      question: QUESTION.test(sentence),
      quoted: insideQuotes(text, first.start, last.end)
    };
  }
  return null;
}

const CLAUSE_BREAK_ALL = /[\r\n,.;:!?，。；：！？、…]+/g;
const SENTENCE_END = /[。！？.!?\n]/gu;
const SENTENCE_AT = /[。！？.!?\n]/u;

function clausesAt(text) {
  const source = String(text);
  const parts = [];
  let from = 0;
  for (const match of source.matchAll(CLAUSE_BREAK_ALL)) {
    addClause(parts, source, from, match.index);
    from = match.index + match[0].length;
  }
  addClause(parts, source, from, source.length);
  return parts;
}

function addClause(parts, source, start, end) {
  const piece = source.slice(start, end);
  if (piece.trim()) parts.push({ text: normalizeClause(piece), start, end });
}

function normalizeClause(piece) {
  return piece.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sentenceAround(text, start, end) {
  let begin = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    if (match.index >= start) break;
    begin = match.index + 1;
  }
  const rest = text.slice(end).match(SENTENCE_AT);
  return text.slice(begin, rest ? end + rest.index + 1 : text.length);
}

function insideQuotes(text, start, end) {
  const open = text.slice(0, start).trimEnd().slice(-1);
  const close = text.slice(end).trimStart().slice(0, 1);
  return QUOTE_PAIRS.get(open) === close;
}

// The person wrote the matched words inside quotation marks: a phrase they are
// quoting or explaining, not an instruction in their own voice.
function quotedClaim(claimed) {
  const open = claimed.trimStart().slice(0, 1);
  const close = claimed.trimEnd().slice(-1);
  return QUOTE_PAIRS.get(open) === close;
}
