import { readJsonlTail } from '../jsonl-tail.js';
import { verifyCodexTranscript } from './conversation-transcript.js';

// What the person answered in Codex's own question card, read from the
// session's rollout, which Codex writes itself as the turn goes (rec#93):
// - request_user_input waits for the card: its call output's `answers` maps
//   each question to the person's picked or typed answers;
// - request_user_input_async shows the card and ends the turn: the person's
//   answer is the next message they send, Codex's own user_message event.
// Only a rollout whose header names this session counts, and only its tail is read.
const TAIL_BYTES = 4 * 1024 * 1024;
const BLOCKING = 'request_user_input';
const ASYNC = 'request_user_input_async';

export async function codexChoiceAnswers(path, sessionId) {
  const { first, records } = await readJsonlTail(path, TAIL_BYTES);
  if (!verifyCodexTranscript(first, sessionId)) return [];
  const blocking = new Set();
  let waiting = false;
  return records.flatMap((record) => {
    const item = record?.payload;
    const at = typeof record?.timestamp === 'string' ? record.timestamp : null;
    if (record?.type === 'response_item' && item?.type === 'function_call') {
      if (item.name === BLOCKING) blocking.add(item.call_id);
      if (item.name === ASYNC) waiting = true;
      return [];
    }
    if (record?.type === 'response_item' && item?.type === 'function_call_output' && blocking.delete(item.call_id)) {
      return cardAnswers(item.output).map(text => ({ text, at }));
    }
    if (record?.type === 'event_msg' && item?.type === 'user_message' && waiting) {
      waiting = false;
      return typeof item.message === 'string' && item.message.trim() ? [{ text: item.message, at }] : [];
    }
    return [];
  });
}

// The output is the response JSON, as a string or as text content.
function cardAnswers(output) {
  const text = typeof output === 'string' ? output
    : typeof output?.content === 'string' ? output.content
      : Array.isArray(output) ? output.map(block => block?.text ?? '').join('') : '';
  let response;
  try { response = JSON.parse(text); } catch { return []; }
  const answers = response?.answers && typeof response.answers === 'object' ? Object.values(response.answers) : [];
  return answers.flatMap(answer => (Array.isArray(answer?.answers) ? answer.answers : []))
    .filter(value => typeof value === 'string' && value.trim());
}
