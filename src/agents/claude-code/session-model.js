import { readJsonlTail } from '../jsonl-tail.js';

// Claude Code's prompt hook does not name the session's model; its transcript
// does, on every assistant message. The model of the newest one in the last
// TAIL_BYTES is the session's model as the client last reported it, or null
// before the first answer, for an unreadable transcript, or for Claude Code's
// own placeholder messages. It never fails task entry.
const TAIL_BYTES = 64 * 1024;
const PLACEHOLDER = '<synthetic>';

export async function claudeSessionModel(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  try {
    const { records } = await readJsonlTail(transcriptPath, TAIL_BYTES);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const model = records[index]?.type === 'assistant' ? records[index]?.message?.model : null;
      if (typeof model === 'string' && model.trim() && model !== PLACEHOLDER) return model.trim().slice(0, 120);
    }
  } catch {
    // Ignore: an unreadable transcript only leaves the model unknown.
  }
  return null;
}
