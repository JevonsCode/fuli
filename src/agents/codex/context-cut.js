import { readJsonlTail } from '../jsonl-tail.js';
import { hookContext } from './preference-evidence.js';

// Whether Codex cut the last hook context it recorded in this rollout: it
// keeps a cut context's head and tail under its own warning line
// (lifecycle-event.js, CODEX_ENTRY_INLINE_BYTES). A missing or unreadable
// rollout, or none recorded yet, is not a cut.
const TAIL_BYTES = 512 * 1024;
const CUT = /^Warning: truncated output \(original token count: \d+\)/;

export async function lastHookContextCut(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return false;
  try {
    const { records } = await readJsonlTail(transcriptPath, TAIL_BYTES);
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      const text = record?.type === 'response_item' ? hookContext(record.payload) : null;
      if (text !== null) return CUT.test(text);
    }
    return false;
  } catch { return false; }
}
