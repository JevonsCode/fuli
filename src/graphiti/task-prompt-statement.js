import { contentHash } from '../../packages/roundtable/src/canonical-json.js';

// What of a prompt is the task's own (rec#88). Clients and scripts append the
// same instructions to every prompt ("Environment: …", "Do not commit, push,
// or create branches…"); taken as the task, they chose the recall topics and
// took the focus slots, so every turn recalled the same release items and
// never the facts the task named. The recall plans from the statement left
// once these are set aside:
// - a line that opens with a note label ("Environment:", "注意：") is a note,
//   unless nothing else is left;
// - a sentence an earlier prompt of the same session already had is a
//   repeat, unless the whole prompt repeats (the same request again);
// - a negated instruction ("do not …", "never …", "不要…") never chooses a
//   topic or a query: it is cut up to the end of its clause.
const NOTE_LINE = /^\s*(?:environment|context|setup|notes?|constraints?|instructions|环境|背景|说明|备注|注意(?:事项)?)\s*[:：]/iu;
const SENTENCE_BREAK = /(?<=[.!?])\s+|(?<=[。！？])/u;
const MIN_SENTENCE_CHARS = 8;
const PROHIBITION = /(?:\b(?:do\s+not|don't|never)\b[^,;:.!?\n]*|(?:不要|禁止|不得|切勿|请勿)[^，,；;：:。！？!?\n并但而]*)/giu;

// The prompt without its notes and its repeated sentences, keeping its lines
// and paragraphs. `earlier` holds the sentence keys of the session's earlier prompts.
export function taskStatement(prompt, earlier = new Set()) {
  const lines = String(prompt).split(/\r?\n/u);
  const notes = lines.map(line => NOTE_LINE.test(line));
  const own = notes.some((note, index) => !note && lines[index].trim()) ? lines.filter((_, index) => !notes[index]) : lines;
  const fresh = own.map(line => sentencesOf(line).filter(sentence => !earlier.has(sentenceKey(sentence))).join(' '));
  return (fresh.some(line => line.trim()) ? fresh : own).join('\n').trim();
}

// The text with its negated instructions cut out, for planning only.
export function withoutProhibitions(text) {
  return text.replace(PROHIBITION, ' ');
}

// The keys of a prompt's sentences, by hash only, for the session's later
// prompts. A very short sentence ("ok", "继续") has none: it is never a repeat.
export function promptSentenceKeys(prompt) {
  return [...new Set(String(prompt).split(/\r?\n/u).flatMap(sentencesOf).map(sentenceKey).filter(Boolean))];
}

function sentencesOf(line) {
  return line.split(SENTENCE_BREAK).map(sentence => sentence.trim()).filter(Boolean);
}

function sentenceKey(sentence) {
  const normalized = sentence.toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
  return normalized.length < MIN_SENTENCE_CHARS ? null
    : contentHash({ purpose: 'task-prompt-sentence-v1', sentence: normalized }).slice(0, 32);
}
