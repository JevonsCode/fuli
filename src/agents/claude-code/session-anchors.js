import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { DELIVERY_TOKEN } from '../../conversations/session-delivery.js';

// Claude previews additionalContext above about 10,000 characters instead of
// showing it, so larger entries never count as delivered.
export const CLAUDE_INLINE_LIMIT = 9_500;
const COMPACTION = /"subtype"\s*:\s*"compact_boundary"/;
const TAIL_BYTES = 2 * 1024 * 1024;

// Proof that a full Fuli group is still in the conversation: Claude recorded
// the hook_additional_context carrying its delivery token after the latest
// compaction, within the recent transcript. Older or unreadable history proves
// nothing, so the entry is delivered in full again.
export function claudeDeliveredTokens(transcriptPath, { readTail = readTranscriptTail } = {}) {
  const delivered = new Set();
  if (transcriptPath) {
    try {
      for (const line of readTail(transcriptPath).split('\n')) {
        if (COMPACTION.test(line)) delivered.clear();
        else if (line.includes('"hook_additional_context"')) {
          for (const match of line.matchAll(DELIVERY_TOKEN)) delivered.add(match[0]);
        }
      }
    } catch {
      delivered.clear();
    }
  }
  return (token) => delivered.has(token);
}

function readTranscriptTail(path) {
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    // The first line may be cut by the window; it cannot prove anything.
    const text = buffer.toString('utf8');
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(descriptor);
  }
}
